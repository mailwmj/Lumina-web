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
  CHAOMO_PROVIDER_ID,
  GENERATION_GATEWAY_PATH,
} from '@/features/generation-gateway/generationGateway';
import i18n from '@/i18n';
import {
  createGenerationProviderError,
  getGenerationErrorCode,
  getGenerationErrorLogFields,
  getGenerationGatewayRequestId,
  getGenerationProviderRequestId,
  normalizeGenerationProviderRequestId,
} from '@/lib/generationProviderError';
import { getLogger } from '@/lib/logger';
import {
  CUSTOM_IMAGE_PROVIDER_ID_PREFIX,
  DEFAULT_CHAOMO_IMAGE_BASE_URL,
  DEFAULT_OPENAI_IMAGE_BASE_URL,
} from '@/features/settings/domain/settingsSchema';
import {
  resolveWebImageProtocol,
  pollImageGenerationViaWeb,
  sourceToImageFile,
  submitImageGenerationViaWeb,
  type WebImageProtocol,
  type WebImageTaskHandle,
} from './webImageApi';
import {
  createImageProviderGatewayFetch,
  isPermanentImageProviderResultError,
  materializeImageProviderResult,
} from './imageProviderGatewayFetch';
import {
  pollSeedanceVideoGenerationViaWeb,
  prepareSeedanceVideoContentForWeb,
  cancelSeedanceVideoGenerationViaWeb,
  submitSeedanceVideoGenerationViaWeb,
  type WebSeedanceVideoTaskHandle,
} from './webVideoApi';
import { createBrowserMediaGateway } from '@/features/media/infrastructure/browserMediaGateway';

const generationLogger = getLogger('generation.gateway');
const MAX_LOGGED_JOB_STATES = 500;

export interface WebGenerationGatewayOptions {
  fetchImpl?: typeof fetch;
  basePath?: string;
}

function isCustomOpenAiGatewayProvider(provider: string): boolean {
  return provider.startsWith(CUSTOM_IMAGE_PROVIDER_ID_PREFIX)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider.slice(CUSTOM_IMAGE_PROVIDER_ID_PREFIX.length));
}

const FAL_REFERENCE_MEDIA_PROVIDER_ID = 'fal-reference';

function providerForPayload(payload: GenerateImagePayload): string {
  return payload.providerConfig?.gateway_provider?.trim() || payload.providerConfig?.provider_id?.trim()
    || payload.providerId?.trim() || (
    payload.model.startsWith(`${AI_MEDIA_PROVIDER_ID}/`) ? AI_MEDIA_PROVIDER_ID
      : payload.model.startsWith(`${CHAOMO_PROVIDER_ID}/`) ? CHAOMO_PROVIDER_ID : ''
  );
}

function safeLogIdentifier(value: string | undefined, fallback = 'unknown'): string {
  const candidate = value?.trim() ?? '';
  return candidate.length > 0 && candidate.length <= 256
    && !candidate.includes('://')
    && /^[A-Za-z0-9._:/-]+$/.test(candidate)
    ? candidate
    : fallback;
}

function generationSubmissionLogFields(payload: GenerateImagePayload): Record<string, unknown> {
  const provider = providerForPayload(payload);
  return {
    provider: safeLogIdentifier(provider || resolveWebImageProtocol(payload.model)),
    model: safeLogIdentifier(payload.model),
    mediaKind: provider === 'volcvideo' ? 'video' : 'image',
    size: safeLogIdentifier(payload.size),
    aspectRatio: safeLogIdentifier(payload.aspectRatio),
    referenceCount: payload.referenceImages?.length ?? 0,
  };
}

function managedGatewayProvider(payload: GenerateImagePayload): string | null {
  const provider = providerForPayload(payload);
  if (provider === CHAOMO_PROVIDER_ID) return CHAOMO_PROVIDER_ID;
  if (isCustomOpenAiGatewayProvider(provider) && payload.providerConfig?.protocol === 'openai-images') {
    return provider;
  }
  return provider === AI_MEDIA_PROVIDER_ID
    && (payload.providerConfig?.base_url?.trim() ?? '').replace(/\/+$/, '') === DEFAULT_OPENAI_IMAGE_BASE_URL
    ? AI_MEDIA_PROVIDER_ID
    : null;
}

interface DirectImageTask {
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
  errorDetails?: string;
  errorCode?: string;
  requestId?: string;
  gatewayRequestId?: string;
  preview?: string;
  lastFrame?: string;
  handle?: WebImageTaskHandle | WebSeedanceVideoTaskHandle;
  recovery?: GenerationJobRecoverySnapshot;
  releaseTemporaryMedia?: () => Promise<void>;
}

function taskWasCancelled(task: DirectImageTask): boolean {
  return task.status === 'cancelled';
}

function directTaskErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : i18n.t('generationGateway.invalidResponse');
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
  gateway_request_id?: string;
  error_code?: string;
} {
  const externalTaskId = taskExternalTaskId(task);
  const providerMetadata = externalTaskId
    ? { external_task_id: externalTaskId, request_id: task.requestId ?? externalTaskId }
    : task.requestId
      ? { request_id: task.requestId }
      : {};
  return {
    ...providerMetadata,
    ...(task.gatewayRequestId ? { gateway_request_id: task.gatewayRequestId } : {}),
    ...(task.errorCode ? { error_code: task.errorCode } : {}),
  };
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

function requireConfiguredBaseUrl(
  payload: GenerateImagePayload,
  provider: string,
): string {
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
  if (isCustomOpenAiGatewayProvider(provider)) return baseUrl;
  const expectedBaseUrl = provider === CHAOMO_PROVIDER_ID
    ? DEFAULT_CHAOMO_IMAGE_BASE_URL : DEFAULT_OPENAI_IMAGE_BASE_URL;
  if (baseUrl.replace(/\/+$/, '') !== expectedBaseUrl) {
    throw new Error(i18n.t('generationGateway.baseUrlNotSupported'));
  }
  return baseUrl;
}

function managedGatewayProviderForConfig(providerConfig?: Record<string, string>): string {
  const configuredProvider = providerConfig?.gateway_provider?.trim() || providerConfig?.provider_id?.trim();
  if (configuredProvider && isCustomOpenAiGatewayProvider(configuredProvider)
    && providerConfig?.protocol === 'openai-images') {
    return configuredProvider;
  }
  if (configuredProvider === CHAOMO_PROVIDER_ID
    || providerConfig?.base_url?.replace(/\/+$/, '') === DEFAULT_CHAOMO_IMAGE_BASE_URL) {
    return CHAOMO_PROVIDER_ID;
  }
  return AI_MEDIA_PROVIDER_ID;
}

function normalizeStatus(
  value: unknown,
): Awaited<ReturnType<AiGateway['getGenerateImageJob']>>['status'] {
  if (value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'not_found' || value === 'cancelled') {
    return value;
  }
  throw new Error(i18n.t('generationGateway.invalidStatus'));
}

function parseJobStatus(
  value: unknown,
  gatewayRequestId?: string,
): Awaited<ReturnType<AiGateway['getGenerateImageJob']>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(i18n.t('generationGateway.invalidResponse'));
  }
  const record = value as Record<string, unknown>;
  const jobId = typeof record.job_id === 'string' ? record.job_id.trim() : '';
  if (!jobId) {
    throw new Error(i18n.t('generationGateway.invalidJobId'));
  }
  const status = normalizeStatus(record.status);
  const recoveryRecord = record.recovery && typeof record.recovery === 'object' && !Array.isArray(record.recovery)
    ? record.recovery as Record<string, unknown>
    : null;
  const retryCount = recoveryRecord?.retry_count;
  const requiresManualRequery = recoveryRecord?.requires_manual_requery;
  const recovery = Number.isInteger(retryCount) && Number(retryCount) >= 1
    && typeof requiresManualRequery === 'boolean'
    ? {
        retry_count: Number(retryCount),
        next_retry_at: typeof recoveryRecord?.next_retry_at === 'number'
          && Number.isFinite(recoveryRecord.next_retry_at)
          ? recoveryRecord.next_retry_at
          : null,
        requires_manual_requery: requiresManualRequery,
        last_error: typeof recoveryRecord?.last_error === 'string' ? recoveryRecord.last_error : null,
      }
    : null;
  return {
    job_id: jobId,
    status,
    result: typeof record.result === 'string' ? record.result : null,
    preview: typeof record.preview === 'string' ? record.preview : null,
    last_frame: typeof record.last_frame === 'string' ? record.last_frame : null,
    lastFrame: typeof record.lastFrame === 'string' ? record.lastFrame : null,
    error: typeof record.error === 'string' ? record.error : null,
    error_details: typeof record.error_details === 'string' ? record.error_details : null,
    error_code: typeof record.error_code === 'string' ? record.error_code : null,
    external_task_id: typeof record.external_task_id === 'string' ? record.external_task_id : null,
    request_id: typeof record.request_id === 'string' ? record.request_id : null,
    gateway_request_id: gatewayRequestId ?? null,
    recovery,
  };
}

export function createWebGenerationGateway(
  options: WebGenerationGatewayOptions = {},
): AiGateway {
  const fetchImpl = options.fetchImpl ?? fetch;
  const basePath = options.basePath ?? GENERATION_GATEWAY_PATH;
  const apiKeys = new Map<string, string>();
  const directTasks = new Map<string, DirectImageTask>();
  const directPolls = new Map<
    string,
    Promise<Awaited<ReturnType<AiGateway['getGenerateImageJob']>>>
  >();
  const loggedJobStates = new Map<string, string>();
  const mediaGateway = createBrowserMediaGateway({ fetchImpl });

  const logJobStatus = (
    operation: 'poll' | 'requery',
    jobId: string,
    startedAt: number,
    status: Awaited<ReturnType<AiGateway['getGenerateImageJob']>>,
  ): void => {
    const recoveryKey = status.recovery
      ? `${status.recovery.retry_count}:${status.recovery.requires_manual_requery}`
      : 'none';
    const stateKey = `${status.status}:${recoveryKey}`;
    if (loggedJobStates.get(jobId) === stateKey) return;
    if (!loggedJobStates.has(jobId) && loggedJobStates.size >= MAX_LOGGED_JOB_STATES) {
      const oldestJobId = loggedJobStates.keys().next().value;
      if (oldestJobId) loggedJobStates.delete(oldestJobId);
    }
    loggedJobStates.set(jobId, stateKey);
    const fields = {
      operation,
      jobId: safeLogIdentifier(jobId),
      status: status.status,
      durationMs: Date.now() - startedAt,
      ...(status.error_code ? { errorCode: safeLogIdentifier(status.error_code) } : {}),
      ...(status.gateway_request_id ? { gatewayRequestId: status.gateway_request_id } : {}),
      ...(status.request_id ? { providerRequestId: status.request_id } : {}),
      ...(status.recovery ? {
        retryCount: status.recovery.retry_count,
        requiresManualRequery: status.recovery.requires_manual_requery,
      } : {}),
    };
    if (status.status === 'failed' || status.status === 'not_found') {
      generationLogger.error('Generation job failed', fields);
    } else if (status.recovery) {
      generationLogger.warn('Generation job entered recovery', fields);
    } else if (status.status === 'succeeded' || status.status === 'cancelled') {
      generationLogger.info('Generation job reached a terminal state', fields);
    } else {
      generationLogger.debug('Generation job status changed', fields);
    }
  };

  const directProviderKey = (payload: GenerateImagePayload): string => (
    payload.providerConfig?.api_key?.trim()
      || apiKeys.get(payload.providerId?.trim() || resolveWebImageProtocol(payload.model))
      || apiKeys.get(resolveWebImageProtocol(payload.model))
      || ''
  );

  const gatewayProviderKey = (
    provider: string,
    providerConfig?: Record<string, string>,
    payloadProviderId?: string,
  ): string => (
    providerConfig?.api_key?.trim()
      || apiKeys.get(provider)
      || apiKeys.get(payloadProviderId?.trim() ?? '')
      || apiKeys.get('openai')
      || ''
  );

  const releaseTemporaryMedia = async (task: DirectImageTask): Promise<void> => {
    const release = task.releaseTemporaryMedia;
    task.releaseTemporaryMedia = undefined;
    await release?.().catch(() => undefined);
  };

  const prepareFalImageReferences = async (
    payload: GenerateImagePayload,
    protocol: WebImageProtocol,
  ): Promise<{
    payload: GenerateImagePayload;
    releaseTemporaryMedia?: () => Promise<void>;
  }> => {
    if (protocol !== 'fal' || !payload.referenceImages?.length) return { payload };
    const grants: Array<{ key: string; url: string }> = [];
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await Promise.all(grants.map(({ key }) => mediaGateway.release(key).catch(() => undefined)));
    };
    try {
      const referenceImages: string[] = [];
      for (const [index, source] of payload.referenceImages.entries()) {
        if (/^https?:\/\//i.test(source)) {
          referenceImages.push(source);
          continue;
        }
        const file = await sourceToImageFile(source, index, fetchImpl);
        const grant = await mediaGateway.publish(file, 'image', FAL_REFERENCE_MEDIA_PROVIDER_ID, {
          projectId: payload.projectId,
        });
        grants.push({ key: grant.key, url: grant.url });
        referenceImages.push(grant.url);
      }
      return {
        payload: { ...payload, referenceImages },
        ...(grants.length ? { releaseTemporaryMedia: release } : {}),
      };
    } catch (error) {
      await release();
      throw error;
    }
  };

  const submitVideo = async (payload: GenerateImagePayload): Promise<GenerationJobSubmissionReceipt> => {
    const preparedContent = await prepareSeedanceVideoContentForWeb(payload.videoContent ?? [], {
      fetchImpl,
      projectId: payload.projectId,
    });
    try {
      const submission = await submitSeedanceVideoGenerationViaWeb({
        ...payload,
        videoContent: preparedContent.content,
      }, { fetchImpl });
      const taskHandle = createBrowserGenerationJobHandle(submission);
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
    const prepared = await prepareFalImageReferences(payload, protocol);
    const providerFetch = createImageProviderGatewayFetch({
      apiKey: key,
      baseUrl,
      protocol,
      fetchImpl,
    });
    try {
      const submission = await submitImageGenerationViaWeb(prepared.payload, {
        apiKey: key,
        baseUrl,
        protocol,
      }, { fetchImpl: providerFetch });
      const jobId = `web-image-${crypto.randomUUID()}`;
      if (submission.status === 'succeeded') {
        const taskHandle = submission.handle
          ? createBrowserGenerationJobHandle(submission.handle)
          : null;
        const task: DirectImageTask = {
          status: 'running',
          ...(submission.handle ? {
            handle: submission.handle,
            requestId: submission.handle.externalTaskId,
          } : {}),
          releaseTemporaryMedia: prepared.releaseTemporaryMedia,
        };
        directTasks.set(jobId, task);
        try {
          const source = await materializeImageProviderResult({
            apiKey: key,
            baseUrl,
            protocol,
            source: submission.source,
            fetchImpl,
          });
          task.status = 'succeeded';
          task.result = source;
          await releaseTemporaryMedia(task);
        } catch (error) {
          if (isPermanentImageProviderResultError(error)) {
            task.status = 'failed';
            task.error = directTaskErrorMessage(error);
            task.recovery = undefined;
            await releaseTemporaryMedia(task);
          }
          if (!taskHandle) {
            directTasks.delete(jobId);
            throw error;
          }
          return {
            jobId,
            taskHandle,
            requestId: submission.handle?.externalTaskId,
          };
        }
        return taskHandle
          ? { jobId, taskHandle, requestId: submission.handle?.externalTaskId }
          : { jobId };
      }
      const taskHandle = createBrowserGenerationJobHandle(submission.handle);
      directTasks.set(jobId, {
        status: 'running',
        handle: submission.handle,
        requestId: submission.handle.externalTaskId,
        releaseTemporaryMedia: prepared.releaseTemporaryMedia,
      });
      return taskHandle
        ? { jobId, taskHandle, requestId: submission.handle.externalTaskId }
        : { jobId, requestId: submission.handle.externalTaskId };
    } catch (error) {
      await prepared.releaseTemporaryMedia?.();
      throw error;
    }
  };

  const runDirectJob = async (
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
      return {
        job_id: jobId, status: 'running', result: null, error: null, recovery: task.recovery,
        ...taskRequestMetadata(task),
      };
    }
    if (!forcePollAfterManualRequery
      && typeof task.recovery?.next_retry_at === 'number'
      && task.recovery.next_retry_at > Date.now()) {
      return {
        job_id: jobId, status: 'running', result: null, error: null, recovery: task.recovery,
        ...taskRequestMetadata(task),
      };
    }
    const apiKey = providerConfig?.api_key?.trim()
      || apiKeys.get(task.handle.protocol)
      || apiKeys.get(resolveWebImageProtocol(task.handle.model))
      || '';
    if (!apiKey) {
      task.recovery = {
        retry_count: task.recovery?.retry_count ?? 0,
        requires_manual_requery: true,
        last_error: i18n.t('generationGateway.apiKeyRequired'),
      };
      return { job_id: jobId, status: 'running', result: null, error: null, recovery: task.recovery };
    }
    try {
      if (task.handle.protocol === 'volcengine-seedance') {
        const polled = await pollSeedanceVideoGenerationViaWeb(task.handle, apiKey, { fetchImpl });
        task.gatewayRequestId = polled.gatewayRequestId ?? task.gatewayRequestId;
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
          task.errorDetails = polled.errorDetails;
          task.errorCode = polled.errorCode;
          task.requestId = polled.requestId ?? task.requestId;
          if (polled.retryable) {
            task.recovery = scheduleTransientImageGenerationPollRetry({
              taskId: task.handle.externalTaskId ?? jobId,
              previousRetryCount: task.recovery?.retry_count ?? 0,
              nowMs: Date.now(),
              error: polled.error,
            });
            return {
              job_id: jobId, status: 'running', result: null, error: null, recovery: task.recovery,
              ...taskRequestMetadata(task),
            };
          }
          task.status = 'failed';
          task.error = polled.error;
          await releaseTemporaryMedia(task);
          return {
            job_id: jobId,
            status: 'failed',
            result: null,
            error: polled.error,
            error_details: polled.errorDetails ?? null,
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

      const imageHandle = task.handle as WebImageTaskHandle;
      const providerFetch = createImageProviderGatewayFetch({
        apiKey,
        baseUrl: imageHandle.baseUrl,
        protocol: imageHandle.protocol,
        fetchImpl,
      });
      const polled = await pollImageGenerationViaWeb(imageHandle, apiKey, { fetchImpl: providerFetch });
      task.gatewayRequestId = polled.gatewayRequestId ?? task.gatewayRequestId;
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
        const source = await materializeImageProviderResult({
          apiKey,
          baseUrl: imageHandle.baseUrl,
          protocol: imageHandle.protocol,
          source: polled.source,
          fetchImpl,
        });
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
        task.status = 'succeeded';
        task.result = source;
        task.recovery = undefined;
        await releaseTemporaryMedia(task);
        return {
          job_id: jobId,
          status: 'succeeded',
          result: source,
          error: null,
          ...taskRequestMetadata(task),
        };
      }
      if (polled.status === 'failed') {
        if (polled.retryable) {
          task.errorCode = polled.errorCode;
          task.recovery = scheduleTransientImageGenerationPollRetry({
            taskId: task.handle.externalTaskId ?? jobId,
            previousRetryCount: task.recovery?.retry_count ?? 0,
            nowMs: Date.now(),
            error: polled.error,
          });
          return {
            job_id: jobId, status: 'running', result: null, error: null, recovery: task.recovery,
            ...taskRequestMetadata(task),
          };
        }
        task.status = 'failed';
        task.error = polled.error;
        task.errorDetails = polled.errorDetails;
        task.errorCode = polled.errorCode;
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
      if (isPermanentImageProviderResultError(error)) {
        task.status = 'failed';
        task.error = directTaskErrorMessage(error);
        task.errorDetails = error instanceof Error && 'details' in error
          ? String((error as { details?: unknown }).details ?? '') || undefined
          : undefined;
        task.errorCode = getGenerationErrorCode(error);
        task.gatewayRequestId = getGenerationGatewayRequestId(error) ?? task.gatewayRequestId;
        task.requestId = getGenerationProviderRequestId(error) ?? task.requestId;
        task.recovery = undefined;
        await releaseTemporaryMedia(task);
        return {
          job_id: jobId,
          status: 'failed',
          result: null,
          error: task.error,
          ...taskRequestMetadata(task),
        };
      }
      task.recovery = scheduleTransientImageGenerationPollRetry({
        taskId: task.handle.externalTaskId ?? jobId,
        previousRetryCount: task.recovery?.retry_count ?? 0,
        nowMs: Date.now(),
        error: directTaskErrorMessage(error),
      });
      return {
        job_id: jobId, status: 'running', result: null, error: null, recovery: task.recovery,
        ...taskRequestMetadata(task),
      };
    }
    return { job_id: jobId, status: 'running', result: null, error: null };
  };

  const directJob = async (
    jobId: string,
    providerConfig?: Record<string, string>,
    taskHandle?: PersistedGenerationJobHandle | null,
    forcePollAfterManualRequery = false,
  ): Promise<Awaited<ReturnType<AiGateway['getGenerateImageJob']>>> => {
    const localTask = directTasks.get(jobId);
    if (localTask && localTask.status !== 'running') {
      return await runDirectJob(jobId, providerConfig, taskHandle, forcePollAfterManualRequery);
    }
    const existingPoll = directPolls.get(jobId);
    if (existingPoll) return await existingPoll;
    const poll = runDirectJob(
      jobId,
      providerConfig,
      taskHandle,
      forcePollAfterManualRequery,
    ).finally(() => {
      if (directPolls.get(jobId) === poll) directPolls.delete(jobId);
    });
    directPolls.set(jobId, poll);
    return await poll;
  };

  const request = async (
    url: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<{ payload: unknown; gatewayRequestId?: string }> => {
    const startedAt = Date.now();
    const response = await fetchImpl(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    const gatewayRequestId = normalizeGenerationProviderRequestId(response.headers.get('x-request-id'));
    if (!response.ok) {
      throw createGenerationProviderError(payload, response.status, {
        gatewayRequestId,
        fallbackMessage: i18n.t('generationGateway.httpError', { status: response.status }),
      });
    }
    generationLogger.debug('Generation Gateway request completed', {
      operation: safeLogIdentifier(typeof body.operation === 'string' ? body.operation : undefined),
      status: response.status,
      durationMs: Date.now() - startedAt,
      ...(gatewayRequestId ? { gatewayRequestId } : {}),
    });
    return { payload, gatewayRequestId };
  };

  const registerCustomGatewayProvider = async (
    provider: string,
    providerConfig: Record<string, string> | undefined,
    key: string,
  ): Promise<void> => {
    if (!isCustomOpenAiGatewayProvider(provider)) return;
    const baseUrl = requireConfiguredBaseUrl({
      prompt: '', model: '', size: '', aspectRatio: '1:1', providerConfig,
    }, provider);
    await request(`${basePath}/providers/custom`, key, {
      operation: 'register',
      provider: { id: provider, base_url: baseUrl, protocol: 'openai-images' },
    });
  };

  const prepareManagedImageReferences = async (
    payload: GenerateImagePayload,
    provider: string,
  ): Promise<{ keys: string[]; release: () => Promise<void> }> => {
    const providerKey = gatewayProviderKey(provider, payload.providerConfig, payload.providerId);
    if (!providerKey) throw new Error(i18n.t('generationGateway.apiKeyRequired'));
    await registerCustomGatewayProvider(provider, payload.providerConfig, providerKey);
    const keys: string[] = [];
    try {
      for (const [index, source] of (payload.referenceImages ?? []).entries()) {
        const file = await sourceToImageFile(source, index, fetchImpl);
        const grant = await mediaGateway.publish(file, 'image', provider, { projectId: payload.projectId });
        keys.push(grant.key);
      }
      return {
        keys,
        release: async () => {
          await Promise.all(keys.map((key) => mediaGateway.release(key).catch(() => undefined)));
        },
      };
    } catch (error) {
      await Promise.all(keys.map((key) => mediaGateway.release(key).catch(() => undefined)));
      throw error;
    }
  };

  const submitManagedImage = async (
    payload: GenerateImagePayload,
    provider: string,
    referenceMediaKeys?: readonly string[],
  ): Promise<GenerationJobSubmissionReceipt> => {
    const key = gatewayProviderKey(provider, payload.providerConfig, payload.providerId);
    if (!key) {
      throw new Error(i18n.t('generationGateway.apiKeyRequired'));
    }
    const { projectId, projectRevision } = requireProjectContext(payload);
    requireConfiguredBaseUrl(payload, provider);
    await registerCustomGatewayProvider(provider, payload.providerConfig, key);
    const { payload: response } = await request(`${basePath}/jobs`, key, {
      operation: 'submit',
      provider,
      projectId,
      projectRevision,
      request: {
        model: payload.model,
        prompt: payload.prompt,
        size: payload.size,
        aspectRatio: payload.aspectRatio,
        ...(referenceMediaKeys?.length ? { referenceMediaKeys: [...referenceMediaKeys] } : {}),
        ...(payload.extraParams ? { extraParams: payload.extraParams } : {}),
      },
    });
    if (!response || typeof response !== 'object' || typeof (response as Record<string, unknown>).job_id !== 'string') {
      throw new Error(i18n.t('generationGateway.invalidSubmission'));
    }
    return { jobId: String((response as Record<string, unknown>).job_id) };
  };

  const submitOne = async (
    payload: GenerateImagePayload,
    preparedReferenceMediaKeys?: readonly string[],
  ): Promise<GenerationJobSubmissionReceipt> => {
    const startedAt = Date.now();
    const logFields = generationSubmissionLogFields(payload);
    generationLogger.info('Generation submission started', logFields);
    try {
      let receipt: GenerationJobSubmissionReceipt;
      if (providerForPayload(payload) === 'volcvideo') {
        receipt = await submitVideo(payload);
      } else {
        const provider = managedGatewayProvider(payload);
        if (!provider) {
          receipt = await submitDirect(payload);
        } else if (preparedReferenceMediaKeys || !payload.referenceImages?.length) {
          receipt = await submitManagedImage(payload, provider, preparedReferenceMediaKeys);
        } else {
          const prepared = await prepareManagedImageReferences(payload, provider);
          try {
            receipt = await submitManagedImage(payload, provider, prepared.keys);
          } finally {
            await prepared.release();
          }
        }
      }
      generationLogger.info('Generation submission accepted', {
        ...logFields,
        jobId: safeLogIdentifier(receipt.jobId),
        durationMs: Date.now() - startedAt,
        ...(receipt.requestId ? { providerRequestId: receipt.requestId } : {}),
      });
      return receipt;
    } catch (error) {
      generationLogger.error('Generation submission failed', {
        ...logFields,
        durationMs: Date.now() - startedAt,
        ...getGenerationErrorLogFields(error),
      });
      throw error;
    }
  };

  const getJob = async (
    jobId: string,
    providerConfig?: Record<string, string>,
    forceManualRequery = false,
  ): Promise<Awaited<ReturnType<AiGateway['getGenerateImageJob']>>> => {
    const provider = managedGatewayProviderForConfig(providerConfig);
    const key = gatewayProviderKey(provider, providerConfig);
    if (!key) {
      throw new Error(i18n.t('generationGateway.apiKeyRequired'));
    }
    await registerCustomGatewayProvider(provider, providerConfig, key);
    const { payload: response, gatewayRequestId } = await request(`${basePath}/jobs/${encodeURIComponent(jobId)}`, key, {
      operation: forceManualRequery ? 'requery' : 'poll',
    });
    return parseJobStatus(response, gatewayRequestId);
  };

  const cancelJob = async (
    jobId: string,
    providerConfig?: Record<string, string>,
    taskHandle?: PersistedGenerationJobHandle | null,
  ): Promise<GenerationJobCancellationResult> => {
    const task = directTasks.get(jobId) ?? restoreDirectImageTask(taskHandle);
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
      const provider = managedGatewayProvider(payload);
      if (provider === AI_MEDIA_PROVIDER_ID) {
        throw new Error(i18n.t('generationGateway.synchronousUnsupported'));
      }
      const jobId = (provider ? await submitOne(payload) : await submitDirect(payload)).jobId;
      let result = provider
        ? await getJob(jobId, payload.providerConfig)
        : await directJob(jobId, payload.providerConfig);
      for (let attempt = 0; result.status === 'running' && attempt < 120; attempt += 1) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 1000));
        result = provider
          ? await getJob(jobId, payload.providerConfig)
          : await directJob(jobId, payload.providerConfig);
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
      const provider = managedGatewayProvider(payload);
      if (provider) {
        requireProjectContext(payload);
        requireConfiguredBaseUrl(payload, provider);
      }
      const safeOutputCount = Math.max(1, Math.min(4, Math.floor(outputCount)));
      const prepared = provider && payload.referenceImages?.length
        ? await prepareManagedImageReferences(payload, provider)
        : null;
      try {
        beforeSubmit();
        return await submitGenerationJobBatch({
          outputCount: safeOutputCount,
          submit: async () => submitOne(payload, prepared?.keys),
          onSettled,
        });
      } finally {
        await prepared?.release();
      }
    },
    getGenerateImageJob: async (jobId, providerConfig, taskHandle) => {
      const startedAt = Date.now();
      try {
        const status = directTasks.has(jobId) || jobId.startsWith('web-image-') || taskHandle?.kind === 'browser-direct'
          ? await directJob(jobId, providerConfig, taskHandle)
          : await getJob(jobId, providerConfig);
        logJobStatus('poll', jobId, startedAt, status);
        return status;
      } catch (error) {
        generationLogger.warn('Generation job poll failed', {
          operation: 'poll',
          jobId: safeLogIdentifier(jobId),
          durationMs: Date.now() - startedAt,
          ...getGenerationErrorLogFields(error),
        });
        throw error;
      }
    },
    retryGenerateImageJob: async (jobId, providerConfig, taskHandle) => {
      const startedAt = Date.now();
      try {
        const status = directTasks.has(jobId) || jobId.startsWith('web-image-') || taskHandle?.kind === 'browser-direct'
          ? await directJob(jobId, providerConfig, taskHandle, true)
          : await getJob(jobId, providerConfig, true);
        logJobStatus('requery', jobId, startedAt, status);
        return status;
      } catch (error) {
        generationLogger.warn('Generation job requery failed', {
          operation: 'requery',
          jobId: safeLogIdentifier(jobId),
          durationMs: Date.now() - startedAt,
          ...getGenerationErrorLogFields(error),
        });
        throw error;
      }
    },
    cancelGenerateImageJob: async (jobId, providerConfig, taskHandle) => {
      const startedAt = Date.now();
      const result = await cancelJob(jobId, providerConfig, taskHandle);
      loggedJobStates.set(jobId, 'cancelled:none');
      generationLogger.info('Generation job cancellation completed', {
        operation: 'cancel',
        jobId: safeLogIdentifier(jobId),
        status: result.status,
        providerConfirmed: result.providerConfirmed,
        durationMs: Date.now() - startedAt,
      });
      return result;
    },
  };
}

export const webGenerationGateway = createWebGenerationGateway();
