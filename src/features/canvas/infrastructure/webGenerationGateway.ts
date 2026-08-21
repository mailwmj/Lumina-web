import { submitGenerationJobBatch } from '@/features/canvas/application/generationJobBatch';
import {
  scheduleTransientImageGenerationPollRetry,
  type GenerationJobRecoverySnapshot,
} from '@/features/canvas/application/generationJobRecovery';
import type {
  AiGateway,
  GenerateImagePayload,
  GenerationJobSubmissionReceipt,
} from '@/features/canvas/application/ports';
import {
  createBrowserGenerationJobHandle,
  type PersistedGenerationJobHandle,
} from '@/features/canvas/domain/generationJobHandle';
import {
  AI_MEDIA_PROVIDER_ID,
  GENERATION_GATEWAY_PATH,
  type GenerationGatewayJobState,
} from '@/features/generation-gateway/generationGateway';
import i18n from '@/i18n';
import { DEFAULT_OPENAI_IMAGE_BASE_URL } from '@/features/settings/domain/settingsSchema';
import {
  resolveWebImageProtocol,
  pollImageGenerationViaWeb,
  sourceToDataUrl,
  submitImageGenerationViaWeb,
  type WebImageProtocol,
  type WebImageTaskHandle,
} from './webImageApi';

export interface WebGenerationGatewayOptions {
  fetchImpl?: typeof fetch;
  basePath?: string;
}

function providerForPayload(payload: GenerateImagePayload): string {
  return payload.providerId?.trim() || (
    payload.model.startsWith(`${AI_MEDIA_PROVIDER_ID}/`) ? AI_MEDIA_PROVIDER_ID : ''
  );
}

function requireAiMediaProvider(payload: GenerateImagePayload): void {
  if (providerForPayload(payload) !== AI_MEDIA_PROVIDER_ID) {
    throw new Error(i18n.t('generationGateway.providerNotConfigured'));
  }
}

interface DirectImageTask {
  status: 'running' | 'succeeded' | 'failed';
  result?: string;
  error?: string;
  errorDetails?: string;
  requestId?: string;
  handle?: WebImageTaskHandle;
  recovery?: GenerationJobRecoverySnapshot;
}

function restoreDirectImageTask(
  taskHandle: PersistedGenerationJobHandle | null | undefined,
): DirectImageTask | null {
  if (taskHandle?.kind !== 'browser-direct') {
    return null;
  }
  const safeHandle = createBrowserGenerationJobHandle(taskHandle);
  if (!safeHandle) {
    return null;
  }
  return {
    status: 'running',
    requestId: safeHandle.externalTaskId,
    handle: {
      ...safeHandle,
      protocol: safeHandle.protocol as WebImageProtocol,
    },
  };
}

function requireProjectContext(payload: GenerateImagePayload): { projectId: string; projectRevision: string } {
  const projectId = payload.projectId?.trim() ?? '';
  const projectRevision = payload.projectRevision?.trim() ?? '';
  if (!projectId || !projectRevision) {
    throw new Error(i18n.t('generationGateway.projectRequired'));
  }
  return { projectId, projectRevision };
}

function requireConfiguredBaseUrl(payload: GenerateImagePayload): string {
  const baseUrl = payload.providerConfig?.base_url?.trim() ?? '';
  if (!baseUrl) {
    throw new Error(i18n.t('generationGateway.baseUrlRequired'));
  }
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error(i18n.t('generationGateway.baseUrlInvalid'));
  }
  if (baseUrl.replace(/\/+$/, '') !== DEFAULT_OPENAI_IMAGE_BASE_URL) {
    throw new Error(i18n.t('generationGateway.baseUrlNotSupported'));
  }
  return baseUrl;
}

function normalizeStatus(value: unknown): GenerationGatewayJobState {
  if (value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'not_found') {
    return value;
  }
  throw new Error(i18n.t('generationGateway.invalidStatus'));
}

function parseJobStatus(value: unknown): Awaited<ReturnType<AiGateway['getGenerateImageJob']>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(i18n.t('generationGateway.invalidResponse'));
  }
  const record = value as Record<string, unknown>;
  const jobId = typeof record.job_id === 'string' ? record.job_id.trim() : '';
  if (!jobId) {
    throw new Error(i18n.t('generationGateway.invalidJobId'));
  }
  const status = normalizeStatus(record.status);
  return {
    job_id: jobId,
    status,
    result: typeof record.result === 'string' ? record.result : null,
    error: typeof record.error === 'string' ? record.error : null,
    error_details: typeof record.error_details === 'string' ? record.error_details : null,
    request_id: typeof record.request_id === 'string' ? record.request_id : null,
  };
}

export function createWebGenerationGateway(
  options: WebGenerationGatewayOptions = {},
): AiGateway {
  const fetchImpl = options.fetchImpl ?? fetch;
  const basePath = options.basePath ?? GENERATION_GATEWAY_PATH;
  const apiKeys = new Map<string, string>();
  const directTasks = new Map<string, DirectImageTask>();

  const directProviderKey = (payload: GenerateImagePayload): string => (
    payload.providerConfig?.api_key?.trim()
      || apiKeys.get(payload.providerId?.trim() || resolveWebImageProtocol(payload.model))
      || apiKeys.get(resolveWebImageProtocol(payload.model))
      || ''
  );

  const submitDirect = async (payload: GenerateImagePayload): Promise<GenerationJobSubmissionReceipt> => {
    const protocol = resolveWebImageProtocol(
      payload.model,
      payload.providerId,
      payload.providerConfig?.protocol as WebImageProtocol | undefined,
    );
    const key = directProviderKey(payload);
    const baseUrl = payload.providerConfig?.base_url?.trim() ?? '';
    if (!baseUrl) throw new Error(i18n.t('generationGateway.baseUrlRequired'));
    const submission = await submitImageGenerationViaWeb(payload, {
      apiKey: key,
      baseUrl,
      protocol,
    }, { fetchImpl });
    const jobId = `web-image-${crypto.randomUUID()}`;
    if (submission.status === 'succeeded') {
      directTasks.set(jobId, { status: 'succeeded', result: submission.source });
      return { jobId };
    }
    const taskHandle = createBrowserGenerationJobHandle(submission.handle);
    directTasks.set(jobId, {
      status: 'running',
      handle: submission.handle,
      requestId: submission.handle.externalTaskId,
    });
    return taskHandle
      ? { jobId, taskHandle, requestId: submission.handle.externalTaskId }
      : { jobId, requestId: submission.handle.externalTaskId };
  };

  const directJob = async (
    jobId: string,
    providerConfig?: Record<string, string>,
    taskHandle?: PersistedGenerationJobHandle | null,
    forcePollAfterManualRequery = false,
  ): Promise<Awaited<ReturnType<AiGateway['getGenerateImageJob']>>> => {
    const task = directTasks.get(jobId) ?? restoreDirectImageTask(taskHandle);
    if (!task) {
      return { job_id: jobId, status: 'not_found', result: null, error: null };
    }
    directTasks.set(jobId, task);
    if (task.status === 'succeeded') {
      return { job_id: jobId, status: 'succeeded', result: task.result ?? null, error: null };
    }
    if (task.status === 'failed') {
      return {
        job_id: jobId,
        status: 'failed',
        result: null,
        error: task.error ?? null,
        error_details: task.errorDetails ?? null,
        request_id: task.requestId ?? null,
      };
    }
    if (!task.handle) return { job_id: jobId, status: 'running', result: null, error: null };
    if (task.recovery?.requires_manual_requery && !forcePollAfterManualRequery) {
      return { job_id: jobId, status: 'running', result: null, error: null, recovery: task.recovery };
    }
    if (!forcePollAfterManualRequery
      && typeof task.recovery?.next_retry_at === 'number'
      && task.recovery.next_retry_at > Date.now()) {
      return { job_id: jobId, status: 'running', result: null, error: null, recovery: task.recovery };
    }
    const apiKey = providerConfig?.api_key?.trim()
      || apiKeys.get(task.handle.protocol)
      || apiKeys.get(resolveWebImageProtocol(task.handle.model))
      || '';
    if (!apiKey) return { job_id: jobId, status: 'failed', result: null, error: i18n.t('generationGateway.apiKeyRequired') };
    try {
      const polled = await pollImageGenerationViaWeb(task.handle, apiKey, { fetchImpl });
      if (polled.status === 'succeeded') {
        task.status = 'succeeded';
        task.result = polled.source;
        task.recovery = undefined;
        return { job_id: jobId, status: 'succeeded', result: polled.source, error: null };
      }
      if (polled.status === 'failed') {
        if (polled.retryable) {
          task.recovery = scheduleTransientImageGenerationPollRetry({
            taskId: task.handle.externalTaskId ?? jobId,
            previousRetryCount: task.recovery?.retry_count ?? 0,
            nowMs: Date.now(),
            error: polled.error,
          });
          return { job_id: jobId, status: 'running', result: null, error: null, recovery: task.recovery };
        }
        task.status = 'failed';
        task.error = polled.error;
        task.errorDetails = polled.errorDetails;
        task.requestId = polled.requestId ?? task.requestId;
        return {
          job_id: jobId,
          status: 'failed',
          result: null,
          error: polled.error,
          error_details: polled.errorDetails ?? null,
          request_id: task.requestId ?? null,
        };
      }
      task.recovery = undefined;
    } catch (error) {
      task.recovery = scheduleTransientImageGenerationPollRetry({
        taskId: task.handle.externalTaskId ?? jobId,
        previousRetryCount: task.recovery?.retry_count ?? 0,
        nowMs: Date.now(),
        error: error instanceof Error ? error.message : 'Task query failed.',
      });
      return { job_id: jobId, status: 'running', result: null, error: null, recovery: task.recovery };
    }
    return { job_id: jobId, status: 'running', result: null, error: null };
  };

  const request = async (url: string, key: string, body: Record<string, unknown>): Promise<unknown> => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).message === 'string'
        ? (payload as Record<string, string>).message
        : i18n.t('generationGateway.httpError', { status: response.status });
      throw new Error(message);
    }
    return payload;
  };

  const submitOne = async (payload: GenerateImagePayload): Promise<GenerationJobSubmissionReceipt> => {
    if (providerForPayload(payload) !== AI_MEDIA_PROVIDER_ID || (
      payload.providerConfig?.base_url?.trim() ?? ''
    ).replace(/\/+$/, '') !== DEFAULT_OPENAI_IMAGE_BASE_URL) {
      return await submitDirect(payload);
    }
    const provider = AI_MEDIA_PROVIDER_ID;
    const key = apiKeys.get(provider) ?? '';
    if (!key) {
      throw new Error(i18n.t('generationGateway.apiKeyRequired'));
    }
    const { projectId, projectRevision } = requireProjectContext(payload);
    requireConfiguredBaseUrl(payload);
    const referenceImages = payload.referenceImages?.length
      ? await Promise.all(payload.referenceImages.map((source) => sourceToDataUrl(source, fetchImpl)))
      : undefined;
    const response = await request(`${basePath}/jobs`, key, {
      operation: 'submit',
      provider,
      projectId,
      projectRevision,
      request: {
        model: payload.model,
        prompt: payload.prompt,
        size: payload.size,
        aspectRatio: payload.aspectRatio,
        ...(referenceImages ? { referenceImages } : {}),
        ...(payload.extraParams ? { extraParams: payload.extraParams } : {}),
      },
    });
    if (!response || typeof response !== 'object' || typeof (response as Record<string, unknown>).job_id !== 'string') {
      throw new Error(i18n.t('generationGateway.invalidSubmission'));
    }
    return { jobId: String((response as Record<string, unknown>).job_id) };
  };

  const getJob = async (jobId: string): Promise<Awaited<ReturnType<AiGateway['getGenerateImageJob']>>> => {
    const key = apiKeys.get(AI_MEDIA_PROVIDER_ID) ?? '';
    if (!key) {
      throw new Error(i18n.t('generationGateway.apiKeyRequired'));
    }
    const response = await request(`${basePath}/jobs/${encodeURIComponent(jobId)}`, key, { operation: 'poll' });
    return parseJobStatus(response);
  };

  return {
    setApiKey: async (provider, apiKey) => {
      const normalized = apiKey.trim();
      if (!normalized) {
        apiKeys.delete(provider);
      } else {
        apiKeys.set(provider, normalized);
      }
    },
    generateImage: async (payload) => {
      if (providerForPayload(payload) === AI_MEDIA_PROVIDER_ID
        && (payload.providerConfig?.base_url?.trim() ?? '').replace(/\/+$/, '') === DEFAULT_OPENAI_IMAGE_BASE_URL) {
        throw new Error(i18n.t('generationGateway.synchronousUnsupported'));
      }
      const jobId = (await submitDirect(payload)).jobId;
      let result = await directJob(jobId, payload.providerConfig);
      for (let attempt = 0; result.status === 'running' && attempt < 120; attempt += 1) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 1000));
        result = await directJob(jobId, payload.providerConfig);
      }
      if (result.status !== 'succeeded' || !result.result) {
        throw new Error(result.error ?? i18n.t('generationGateway.invalidSubmission'));
      }
      return result.result;
    },
    submitGenerateImageJob: async (payload) => (await submitOne(payload)).jobId,
    submitGenerateImageJobs: async (payload, outputCount, onSettled, beforeSubmit) => {
      // Validate all inputs and storage-independent request fields before creating any result nodes.
      if (providerForPayload(payload) === AI_MEDIA_PROVIDER_ID
        && (payload.providerConfig?.base_url?.trim() ?? '').replace(/\/+$/, '') === DEFAULT_OPENAI_IMAGE_BASE_URL) {
        requireAiMediaProvider(payload);
        requireProjectContext(payload);
        requireConfiguredBaseUrl(payload);
      }
      const safeOutputCount = Math.max(1, Math.min(4, Math.floor(outputCount)));
      beforeSubmit();
      const results = await submitGenerationJobBatch({
        outputCount: safeOutputCount,
        submit: async () => submitOne(payload),
        onSettled,
      });
      return results;
    },
    getGenerateImageJob: async (jobId, providerConfig, taskHandle) => {
      if (directTasks.has(jobId) || jobId.startsWith('web-image-') || taskHandle?.kind === 'browser-direct') {
        return await directJob(jobId, providerConfig, taskHandle);
      }
      return await getJob(jobId);
    },
    retryGenerateImageJob: async (jobId, providerConfig, taskHandle) => {
      if (directTasks.has(jobId) || jobId.startsWith('web-image-') || taskHandle?.kind === 'browser-direct') {
        return await directJob(jobId, providerConfig, taskHandle, true);
      }
      return await getJob(jobId);
    },
  };
}

export const webGenerationGateway = createWebGenerationGateway();
