import { submitGenerationJobBatch } from '@/features/canvas/application/generationJobBatch';
import {
  scheduleTransientImageGenerationPollRetry,
  type GenerationJobRecoverySnapshot,
} from '@/features/canvas/application/generationJobRecovery';
import type {
  AiGateway,
  GenerateImagePayload,
  GenerationJobCancellationResult,
  GenerationJobSubmissionReceipt,
} from '@/features/canvas/application/ports';
import {
  createBrowserGenerationJobHandle,
  type PersistedGenerationJobHandle,
} from '@/features/canvas/domain/generationJobHandle';
import {
  AI_MEDIA_PROVIDER_ID,
  GENERATION_GATEWAY_PATH,
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
import {
  pollSeedanceVideoGenerationViaWeb,
  prepareSeedanceVideoContentForWeb,
  releaseSeedanceVideoTemporaryMediaForWeb,
  cancelSeedanceVideoGenerationViaWeb,
  submitSeedanceVideoGenerationViaWeb,
  type WebSeedanceVideoTaskHandle,
} from './webVideoApi';

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
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
  errorDetails?: string;
  requestId?: string;
  preview?: string;
  lastFrame?: string;
  handle?: WebImageTaskHandle | WebSeedanceVideoTaskHandle;
  recovery?: GenerationJobRecoverySnapshot;
  releaseTemporaryMedia?: () => Promise<void>;
}

function taskWasCancelled(task: DirectImageTask): boolean {
  return task.status === 'cancelled';
}

function taskExternalTaskId(task: DirectImageTask): string | null {
  const externalTaskId = task.handle?.externalTaskId ?? task.requestId;
  return typeof externalTaskId === 'string' && externalTaskId.trim()
    ? externalTaskId.trim()
    : null;
}

function taskRequestMetadata(task: DirectImageTask): {
  external_task_id?: string;
  request_id?: string;
} {
  const externalTaskId = taskExternalTaskId(task);
  return externalTaskId
    ? { external_task_id: externalTaskId, request_id: task.requestId ?? externalTaskId }
    : task.requestId
      ? { request_id: task.requestId }
      : {};
}

function restoreDirectImageTask(
  taskHandle: PersistedGenerationJobHandle | null | undefined,
  fetchImpl: typeof fetch,
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
    ...(safeHandle.protocol === 'volcengine-seedance' && safeHandle.temporaryMediaKeys
      ? {
        releaseTemporaryMedia: () => releaseSeedanceVideoTemporaryMediaForWeb(
          safeHandle.temporaryMediaKeys!,
          { fetchImpl },
        ),
      }
      : {}),
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

function normalizeStatus(
  value: unknown,
): Awaited<ReturnType<AiGateway['getGenerateImageJob']>>['status'] {
  if (value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'not_found' || value === 'cancelled') {
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
    preview: typeof record.preview === 'string' ? record.preview : null,
    last_frame: typeof record.last_frame === 'string' ? record.last_frame : null,
    lastFrame: typeof record.lastFrame === 'string' ? record.lastFrame : null,
    error: typeof record.error === 'string' ? record.error : null,
    error_details: typeof record.error_details === 'string' ? record.error_details : null,
    external_task_id: typeof record.external_task_id === 'string' ? record.external_task_id : null,
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

  const releaseTemporaryMedia = async (task: DirectImageTask): Promise<void> => {
    const release = task.releaseTemporaryMedia;
    task.releaseTemporaryMedia = undefined;
    await release?.().catch(() => undefined);
  };

  const submitVideo = async (payload: GenerateImagePayload): Promise<GenerationJobSubmissionReceipt> => {
    const preparedContent = await prepareSeedanceVideoContentForWeb(payload.videoContent ?? [], { fetchImpl });
    try {
      const submission = await submitSeedanceVideoGenerationViaWeb({
        ...payload,
        videoContent: preparedContent.content,
      }, { fetchImpl });
      const taskHandle = createBrowserGenerationJobHandle({
        ...submission,
        temporaryMediaKeys: preparedContent.temporaryMediaKeys,
      });
      const jobId = `web-video-${crypto.randomUUID()}`;
      directTasks.set(jobId, {
        status: 'running',
        handle: submission,
        requestId: submission.externalTaskId,
        releaseTemporaryMedia: preparedContent.release,
      });
      return taskHandle
        ? { jobId, taskHandle, requestId: submission.externalTaskId }
        : { jobId, requestId: submission.externalTaskId };
    } catch (error) {
      await preparedContent.release();
      throw error;
    }
  };

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
    const task = directTasks.get(jobId) ?? restoreDirectImageTask(taskHandle, fetchImpl);
    if (!task) {
      return { job_id: jobId, status: 'not_found', result: null, error: null };
    }
    directTasks.set(jobId, task);
    if (task.status === 'succeeded') {
      return {
        job_id: jobId,
        status: 'succeeded',
        result: task.result ?? null,
        preview: task.preview ?? null,
        last_frame: task.lastFrame ?? null,
        lastFrame: task.lastFrame ?? null,
        error: null,
        ...taskRequestMetadata(task),
      };
    }
    if (task.status === 'failed') {
      return {
        job_id: jobId,
        status: 'failed',
        result: null,
        error: task.error ?? null,
        error_details: task.errorDetails ?? null,
        request_id: task.requestId ?? null,
        ...taskRequestMetadata(task),
      };
    }
    if (task.status === 'cancelled') {
      return {
        job_id: jobId,
        status: 'cancelled',
        result: null,
        error: task.error ?? null,
        request_id: task.requestId ?? null,
        ...taskRequestMetadata(task),
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
      if (task.handle.protocol === 'volcengine-seedance') {
        const polled = await pollSeedanceVideoGenerationViaWeb(task.handle, apiKey, { fetchImpl });
        // Cancellation wins over a provider response that was already in flight.
        if (taskWasCancelled(task)) {
          return {
            job_id: jobId,
            status: 'cancelled',
            result: null,
            error: task.error ?? null,
            request_id: task.requestId ?? null,
            ...taskRequestMetadata(task),
          };
        }
        if (polled.status === 'succeeded') {
          task.status = 'succeeded';
          task.result = polled.result;
          task.preview = polled.preview;
          task.lastFrame = polled.lastFrame;
          task.recovery = undefined;
          await releaseTemporaryMedia(task);
          return {
            job_id: jobId,
            status: 'succeeded',
            result: polled.result,
            preview: polled.preview ?? null,
            last_frame: polled.lastFrame ?? null,
            lastFrame: polled.lastFrame ?? null,
            error: null,
            seed: polled.seed ?? null,
            ...taskRequestMetadata(task),
          };
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
          await releaseTemporaryMedia(task);
          return {
            job_id: jobId,
            status: 'failed',
            result: null,
            error: polled.error,
            ...taskRequestMetadata(task),
          };
        }
        if (polled.status === 'cancelled') {
          task.status = 'cancelled';
          task.error = polled.error;
          await releaseTemporaryMedia(task);
          return {
            job_id: jobId,
            status: 'cancelled',
            result: null,
            error: polled.error,
            ...taskRequestMetadata(task),
          };
        }
        task.recovery = undefined;
        return { job_id: jobId, status: 'running', result: null, error: null };
      }

      const polled = await pollImageGenerationViaWeb(task.handle as WebImageTaskHandle, apiKey, { fetchImpl });
      if (taskWasCancelled(task)) {
        return {
          job_id: jobId,
          status: 'cancelled',
          result: null,
          error: task.error ?? null,
          request_id: task.requestId ?? null,
        };
      }
      if (polled.status === 'succeeded') {
        task.status = 'succeeded';
        task.result = polled.source;
        task.recovery = undefined;
        await releaseTemporaryMedia(task);
        return {
          job_id: jobId,
          status: 'succeeded',
          result: polled.source,
          error: null,
          ...taskRequestMetadata(task),
        };
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
        await releaseTemporaryMedia(task);
        return {
          job_id: jobId,
          status: 'failed',
          result: null,
          error: polled.error,
          error_details: polled.errorDetails ?? null,
          request_id: task.requestId ?? null,
          ...taskRequestMetadata(task),
        };
      }
      task.recovery = undefined;
    } catch (error) {
      if (taskWasCancelled(task)) {
        return {
          job_id: jobId,
          status: 'cancelled',
          result: null,
          error: task.error ?? null,
          request_id: task.requestId ?? null,
          ...taskRequestMetadata(task),
        };
      }
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
    if (providerForPayload(payload) === 'volcvideo') {
      return await submitVideo(payload);
    }
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

  const cancelJob = async (
    jobId: string,
    providerConfig?: Record<string, string>,
    taskHandle?: PersistedGenerationJobHandle | null,
  ): Promise<GenerationJobCancellationResult> => {
    const task = directTasks.get(jobId) ?? restoreDirectImageTask(taskHandle, fetchImpl);
    if (task) {
      directTasks.set(jobId, task);
      if (task.status !== 'running') {
        return {
          job_id: jobId,
          status: 'cancelled',
          providerConfirmed: false,
          error: null,
        };
      }
      // Set this before any provider request so an in-flight poll cannot commit.
      task.status = 'cancelled';
      task.error = i18n.t('generationGateway.seedanceCancelled');
    }
    if (!task?.handle || task.handle.protocol !== 'volcengine-seedance') {
      if (task) await releaseTemporaryMedia(task);
      return {
        job_id: jobId,
        status: 'cancelled',
        providerConfirmed: false,
        error: task ? null : i18n.t('generationGateway.invalidJobId'),
      };
    }
    const apiKey = providerConfig?.api_key?.trim()
      || apiKeys.get(task.handle.protocol)
      || apiKeys.get(resolveWebImageProtocol(task.handle.model))
      || '';
    const cancellation = await cancelSeedanceVideoGenerationViaWeb(task.handle, apiKey, { fetchImpl });
    await releaseTemporaryMedia(task);
    return {
      job_id: jobId,
      status: 'cancelled',
      providerConfirmed: cancellation.providerConfirmed,
      error: cancellation.error ?? null,
    };
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
    submitGenerateVideoJob: async (payload) => {
      if (providerForPayload(payload) !== 'volcvideo') {
        throw new Error(i18n.t('generationGateway.providerNotConfigured'));
      }
      return await submitVideo(payload);
    },
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
    cancelGenerateImageJob: async (jobId, providerConfig, taskHandle) => (
      await cancelJob(jobId, providerConfig, taskHandle)
    ),
  };
}

export const webGenerationGateway = createWebGenerationGateway();
