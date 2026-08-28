import { createGenerationProviderError } from '@/lib/generationProviderError';

export const GENERATION_GATEWAY_PATH = '/api/generation';
export const AI_MEDIA_PROVIDER_ID = 'ai-media' as const;
export const CHAOMO_PROVIDER_ID = 'chaomo' as const;
const DEFAULT_MODEL_ID = 'ai-media/gpt-image-2';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PROMPT_LENGTH = 32_000;
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_COUNT = 10;
const MAX_RESULT_BYTES = 50 * 1024 * 1024;
const MAX_ACTIVE_TASK_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESULT_CONFIRMATION_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10_000;
const MAX_PENDING_TASKS_PER_SOURCE = 400;
const MAX_CONCURRENT_TASKS = 50;

export type GenerationGatewayProviderId = typeof AI_MEDIA_PROVIDER_ID;
export type GenerationGatewayOperation = 'submit' | 'poll';
export type GenerationGatewayJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found';

export interface GenerationGatewayImageRequest {
  model: string;
  prompt: string;
  size: string;
  aspectRatio?: string;
  extraParams?: Record<string, unknown>;
  referenceMediaKeys?: string[];
}

export interface GenerationGatewayProviderConfig {
  baseUrl: string;
  modelIds?: readonly string[];
}

export interface GenerationGatewayTaskSnapshot {
  id: string;
  provider: GenerationGatewayProviderId;
  upstreamTaskId?: string;
  status: GenerationGatewayJobState;
  createdAt: number;
  updatedAt: number;
  resultByteCount?: number;
  resultMimeType?: string;
  error?: string;
  errorDetails?: string;
  requestId?: string;
}

interface GenerationGatewayTask extends GenerationGatewayTaskSnapshot {
  providerError?: string;
  resultBlob?: Blob;
  terminalAt?: number;
  resultAvailableAt?: number;
  resultFetchedAt?: number;
  source?: string;
}

export interface GenerationGatewayHandlerOptions {
  providers: Partial<Record<GenerationGatewayProviderId, GenerationGatewayProviderConfig>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  expectedOrigin?: string;
  createTaskId?: () => string;
  inspectTask?: (task: GenerationGatewayTaskSnapshot) => void;
  resolveReferenceImages?: (keys: readonly string[]) => Promise<readonly Blob[]>;
  maxPendingTasksPerSource?: number;
  maxConcurrentTasks?: number;
}

function boundedTaskLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 1
    ? Math.min(Math.floor(Number(value)), MAX_PENDING_TASKS_PER_SOURCE)
    : fallback;
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: code, message }, status);
}

function trimBearer(value: string | null): string | null {
  if (!value?.startsWith('Bearer ')) {
    return null;
  }
  const token = value.slice('Bearer '.length).trim();
  return token.length > 0 && token.length <= 4096 ? token : null;
}

function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return null;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return url;
  } catch {
    return null;
  }
}

function upstreamUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    throw new Error('Gateway provider configuration has an invalid upstream URL.');
  }
  return new URL(path.replace(/^\/+/, ''), base).toString();
}

function resolveAiMediaImageSize(resolution: string, aspectRatio = '1:1'): string {
  const normalizedResolution = resolution.trim().toLowerCase();
  if (/^\d+x\d+$/.test(normalizedResolution)) return normalizedResolution;
  const longEdge = normalizedResolution === '2k' ? 2048 : normalizedResolution === '4k' ? 4096 : 1024;
  const [rawWidth, rawHeight] = aspectRatio.split(':').map(Number);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) {
    return `${longEdge}x${longEdge}`;
  }
  if (rawWidth > rawHeight) return `${longEdge}x${Math.max(1, Math.round(longEdge * rawHeight / rawWidth))}`;
  if (rawWidth < rawHeight) return `${Math.max(1, Math.round(longEdge * rawWidth / rawHeight))}x${longEdge}`;
  return `${longEdge}x${longEdge}`;
}

function resolveAiMediaImageQuality(resolution: string): string | undefined {
  switch (resolution.trim().toLowerCase()) {
    case '1k': case 'low': return 'low';
    case '2k': case 'medium': return 'medium';
    case '4k': case 'high': return 'high';
    case 'auto': return 'auto';
    default: return undefined;
  }
}

function aiMediaRequestBody(request: GenerationGatewayImageRequest): Record<string, unknown> {
  const quality = resolveAiMediaImageQuality(request.size);
  return {
    ...(request.extraParams ?? {}),
    model: request.model.startsWith(`${AI_MEDIA_PROVIDER_ID}/`)
      ? request.model.slice(AI_MEDIA_PROVIDER_ID.length + 1)
      : request.model,
    prompt: request.prompt,
    n: 1,
    size: resolveAiMediaImageSize(request.size, request.aspectRatio),
    ...(quality ? { quality } : {}),
    async: true,
    response_format: 'b64_json',
  };
}

function safeString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    ? value.trim()
    : null;
}

function parseRequest(value: unknown): GenerationGatewayImageRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const model = safeString(record.model, 256);
  const prompt = safeString(record.prompt, MAX_PROMPT_LENGTH);
  const size = safeString(record.size, 32);
  if (!model || !prompt || !size) {
    return null;
  }
  if (record.referenceImages !== undefined || (record.referenceMediaKeys !== undefined && (
    !Array.isArray(record.referenceMediaKeys)
    || record.referenceMediaKeys.length > MAX_REFERENCE_IMAGE_COUNT
    || record.referenceMediaKeys.some((key) => (
      !safeString(key, 128) || !/^media-[0-9a-f-]{36}$/i.test(key)
    ))
  ))) {
    return null;
  }
  if (record.extraParams !== undefined && (
    !record.extraParams || typeof record.extraParams !== 'object' || Array.isArray(record.extraParams)
  )) {
    return null;
  }
  return {
    model,
    prompt,
    size,
    ...(typeof record.aspectRatio === 'string' ? { aspectRatio: record.aspectRatio.slice(0, 32) } : {}),
    ...(Array.isArray(record.referenceMediaKeys)
      ? { referenceMediaKeys: record.referenceMediaKeys as string[] }
      : {}),
    ...(record.extraParams ? { extraParams: record.extraParams as Record<string, unknown> } : {}),
  };
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await response.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toBase64Bytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function resolveResultBlob(
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
  allowedBaseUrl: string,
): Promise<Blob | null> {
  const records = [payload, payload.data, payload.response, payload.result].filter(
    (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
  );
  const items = records.flatMap((record) => (
    Array.isArray(record.data) ? record.data
      : Array.isArray(record.images) ? record.images
        : Array.isArray(record.results) ? record.results : [record]
  )).filter(
    (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
  );
  for (const result of items) {
    const nestedImage = result.image && typeof result.image === 'object' && !Array.isArray(result.image)
      ? result.image as Record<string, unknown> : null;
    const encoded = typeof result.b64_json === 'string' ? result.b64_json
      : typeof result.base64 === 'string' ? result.base64
        : typeof nestedImage?.b64_json === 'string' ? nestedImage.b64_json
          : typeof nestedImage?.base64 === 'string' ? nestedImage.base64 : null;
    if (encoded) {
      const bytes = toBase64Bytes(encoded);
      if (bytes) return new Blob([bytes], { type: 'image/png' });
    }
    const resultSource = typeof result.url === 'string' ? result.url
      : typeof result.signed_url === 'string' ? result.signed_url
        : typeof nestedImage?.url === 'string' ? nestedImage.url : null;
    if (!resultSource) continue;
    let resultUrl: URL;
    try {
      resultUrl = new URL(resultSource);
    } catch {
      continue;
    }
    const allowedUrl = normalizeBaseUrl(allowedBaseUrl);
    if (!allowedUrl || resultUrl.origin !== allowedUrl.origin || resultUrl.protocol !== allowedUrl.protocol) {
      continue;
    }
    const response = await fetchImpl(resultUrl, { redirect: 'manual' });
    if (!response.ok || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) {
      continue;
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > MAX_RESULT_BYTES) continue;
    const blob = await response.blob();
    if (blob.size <= MAX_RESULT_BYTES) return blob;
  }
  return null;
}

function extractUpstreamTaskId(payload: Record<string, unknown> | null): string {
  if (!payload) return '';
  const records = [payload, payload.data].filter(
    (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
  );
  for (const record of records) {
    for (const key of ['request_id', 'requestId', 'task_id', 'taskId', 'id']) {
      const value = safeString(record[key], 512);
      if (value && /^[A-Za-z0-9._:-]+$/.test(value)) return value;
    }
  }
  return '';
}

function taskSnapshot(task: GenerationGatewayTask): GenerationGatewayTaskSnapshot {
  const {
    resultBlob: _resultBlob,
    terminalAt: _terminalAt,
    resultAvailableAt: _resultAvailableAt,
    resultFetchedAt: _resultFetchedAt,
    source: _source,
    providerError: _providerError,
    ...snapshot
  } = task;
  return snapshot;
}

function validateOrigin(request: Request, expectedOrigin: string | undefined): Response | null {
  if (!expectedOrigin) {
    return null;
  }
  const origin = request.headers.get('origin');
  return origin && origin !== expectedOrigin
    ? errorResponse(403, 'origin_not_allowed', 'The request origin is not allowed.')
    : null;
}

export function createGenerationGatewayHandler(options: GenerationGatewayHandlerOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const tasks = new Map<string, GenerationGatewayTask>();
  const rateLimits = new Map<string, { startedAt: number; count: number }>();
  const queuedSubmissions = new Map<string, {
    task: GenerationGatewayTask;
    config: GenerationGatewayProviderConfig;
    request: GenerationGatewayImageRequest;
    references: readonly Blob[];
    apiKey: string;
    resolveCompletion: () => void;
    completion: Promise<void>;
  }>();
  const executingTaskIds = new Set<string>();
  const maxPendingTasksPerSource = boundedTaskLimit(
    options.maxPendingTasksPerSource,
    MAX_PENDING_TASKS_PER_SOURCE,
  );
  const maxConcurrentTasks = boundedTaskLimit(options.maxConcurrentTasks, MAX_CONCURRENT_TASKS);
  let taskSequence = 0;
  const createTaskId = options.createTaskId ?? (() => `job-${now()}-${++taskSequence}`);

  const notifyTask = (task: GenerationGatewayTask): void => {
    options.inspectTask?.(taskSnapshot(task));
  };

  const consumeRateLimit = (source: string): boolean => {
    const currentTime = now();
    const existing = rateLimits.get(source);
    const entry = !existing || currentTime - existing.startedAt >= RATE_LIMIT_WINDOW_MS
      ? { startedAt: currentTime, count: 0 }
      : existing;
    if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
      rateLimits.set(source, entry);
      return false;
    }
    entry.count += 1;
    rateLimits.set(source, entry);
    return true;
  };

  const pendingTaskCount = (source: string): number => (
    [...tasks.values()].filter((task) => task.source === source && (task.status === 'queued' || task.status === 'running')).length
  );

  const activeTaskCount = (): number => {
    const activeTaskIds = new Set(executingTaskIds);
    for (const task of tasks.values()) {
      if (task.status === 'running') activeTaskIds.add(task.id);
    }
    return activeTaskIds.size;
  };

  const loadProvider = (provider: unknown): GenerationGatewayProviderConfig | null => {
    if (provider !== AI_MEDIA_PROVIDER_ID) {
      return null;
    }
    return options.providers[AI_MEDIA_PROVIDER_ID] ?? null;
  };

  const executeSubmission = async (
    task: GenerationGatewayTask,
    config: GenerationGatewayProviderConfig,
    request: GenerationGatewayImageRequest,
    references: readonly Blob[],
    apiKey: string,
  ): Promise<void> => {
    let response: Response;
    try {
      const providerBody = aiMediaRequestBody(request);
      if (references.length) {
        const form = new FormData();
        Object.entries(providerBody).forEach(([key, value]) => form.append(key, String(value)));
        for (const [index, blob] of references.entries()) {
          const extension = blob.type === 'image/jpeg' ? 'jpg'
            : blob.type === 'image/webp' ? 'webp'
              : blob.type === 'image/gif' ? 'gif' : 'png';
          form.append('image', blob, `reference-${index + 1}.${extension}`);
        }
        response = await fetchImpl(upstreamUrl(config.baseUrl, 'images/edits'), {
          method: 'POST', redirect: 'manual',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'Idempotency-Key': `opencanvas-image-${crypto.randomUUID()}`,
          },
          body: form,
        });
      } else {
        response = await fetchImpl(upstreamUrl(config.baseUrl, 'images/generations'), {
          method: 'POST',
          redirect: 'manual',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'Idempotency-Key': `opencanvas-image-${crypto.randomUUID()}`,
          },
          body: JSON.stringify(providerBody),
        });
      }
    } catch {
      task.status = 'failed';
      task.error = 'Unable to reach the configured image provider.';
      task.terminalAt = now();
      task.updatedAt = now();
      notifyTask(task);
      return;
    }

    const payload = await readJson(response);
    if (!response.ok) {
      const failure = createGenerationProviderError(payload, response.status);
      task.status = 'failed';
      task.error = 'Generation failed.';
      task.providerError = failure.message;
      task.errorDetails = failure.details;
      task.requestId = failure.requestId;
      task.terminalAt = now();
      task.updatedAt = now();
      notifyTask(task);
      return;
    }

    const upstreamTaskId = extractUpstreamTaskId(payload);
    const blob = payload ? await resolveResultBlob(payload, fetchImpl, config.baseUrl).catch(() => null) : null;
    if (blob) {
      task.status = 'succeeded';
      task.resultBlob = blob;
      task.resultByteCount = blob.size;
      task.resultMimeType = blob.type || 'application/octet-stream';
      task.resultAvailableAt = now();
      task.terminalAt = task.resultAvailableAt;
    } else if (upstreamTaskId) {
      task.status = 'running';
      task.upstreamTaskId = upstreamTaskId;
    } else {
      task.status = 'failed';
      task.error = 'The image provider returned no usable result.';
      task.terminalAt = now();
    }
    if (task.status === 'failed') task.terminalAt ??= now();
    task.updatedAt = now();
    notifyTask(task);
  };

  const submissionResponse = (task: GenerationGatewayTask): Response => json({
    job_id: task.id,
    status: task.status,
    ...(task.status === 'failed'
      ? {
        error: task.providerError ?? task.error ?? 'Generation failed.',
        ...(task.errorDetails ? { error_details: task.errorDetails } : {}),
        ...(task.requestId ? { request_id: task.requestId } : {}),
      }
      : {}),
  }, 202);

  const nextQueuedSubmission = () => [...queuedSubmissions.values()]
    .find(({ task }) => task.status === 'queued' && !executingTaskIds.has(task.id));

  const drainQueue = (): void => {
    while (activeTaskCount() < maxConcurrentTasks) {
      const entry = nextQueuedSubmission();
      if (!entry) return;
      executingTaskIds.add(entry.task.id);
      void runQueuedSubmission(entry);
    }
  };

  const runQueuedSubmission = async (
    entry: NonNullable<ReturnType<typeof nextQueuedSubmission>>,
  ): Promise<void> => {
    try {
      await executeSubmission(entry.task, entry.config, entry.request, entry.references, entry.apiKey);
    } catch {
      entry.task.status = 'failed';
      entry.task.error = 'Unable to reach the configured image provider.';
      entry.task.terminalAt = now();
      entry.task.updatedAt = now();
      notifyTask(entry.task);
    } finally {
      executingTaskIds.delete(entry.task.id);
      queuedSubmissions.delete(entry.task.id);
      entry.resolveCompletion();
      drainQueue();
    }
  };

  const enqueueSubmission = (
    task: GenerationGatewayTask,
    config: GenerationGatewayProviderConfig,
    request: GenerationGatewayImageRequest,
    references: readonly Blob[],
    apiKey: string,
  ): { started: boolean; completion: Promise<void> } | null => {
    if (pendingTaskCount(task.source ?? 'same-origin') >= maxPendingTasksPerSource) return null;
    let resolveCompletion: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    tasks.set(task.id, task);
    queuedSubmissions.set(task.id, {
      task,
      config,
      request,
      references,
      apiKey,
      resolveCompletion,
      completion,
    });
    notifyTask(task);
    drainQueue();
    return { started: executingTaskIds.has(task.id), completion };
  };

  const submit = async (
    provider: GenerationGatewayProviderId,
    config: GenerationGatewayProviderConfig,
    request: GenerationGatewayImageRequest,
    references: readonly Blob[],
    apiKey: string,
    source: string,
  ): Promise<Response> => {
    const allowedModels = config.modelIds ?? [DEFAULT_MODEL_ID];
    if (!allowedModels.includes(request.model)) {
      return errorResponse(400, 'model_not_allowed', 'The image model is not enabled for this gateway.');
    }
    const task: GenerationGatewayTask = {
      id: createTaskId(),
      provider,
      status: 'queued',
      source,
      createdAt: now(),
      updatedAt: now(),
    };
    const scheduled = enqueueSubmission(task, config, request, references, apiKey);
    if (!scheduled) {
      return errorResponse(429, 'queue_capacity_exceeded', 'The generation task queue is full.');
    }
    if (scheduled.started) await scheduled.completion;
    return submissionResponse(task);
  };

  const poll = async (
    task: GenerationGatewayTask,
    config: GenerationGatewayProviderConfig,
    apiKey: string,
  ): Promise<Response> => {
    if (task.status === 'succeeded') {
      return json({
        job_id: task.id,
        status: task.status,
        result: `${GENERATION_GATEWAY_PATH}/jobs/${task.id}/result`,
      });
    }
    if (task.status === 'failed' || task.status === 'not_found') {
      return json({
        job_id: task.id,
        status: task.status,
        error: task.providerError ?? task.error ?? 'generation failed',
        ...(task.errorDetails ? { error_details: task.errorDetails } : {}),
        ...(task.requestId ? { request_id: task.requestId } : {}),
      });
    }
    if (!task.upstreamTaskId) {
      return json({ job_id: task.id, status: task.status });
    }
    let response: Response;
    try {
      response = await fetchImpl(upstreamUrl(
        config.baseUrl,
        `images/tasks/${encodeURIComponent(task.upstreamTaskId)}?view=summary`,
      ), {
        method: 'GET',
        redirect: 'manual',
        headers: { authorization: `Bearer ${apiKey}` },
      });
    } catch {
      return json({ job_id: task.id, status: task.status });
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const failure = createGenerationProviderError(payload, response.status);
      task.status = 'failed';
      task.error = 'Generation failed.';
      task.providerError = failure.message;
      task.errorDetails = failure.details;
      task.requestId = failure.requestId;
      task.terminalAt = now();
    } else {
      const blob = payload ? await resolveResultBlob(payload, fetchImpl, config.baseUrl).catch(() => null) : null;
      if (blob) {
        task.status = 'succeeded';
        task.resultBlob = blob;
        task.resultByteCount = blob.size;
        task.resultMimeType = blob.type || 'application/octet-stream';
        task.resultAvailableAt = now();
        task.terminalAt = task.resultAvailableAt;
      }
    }
    task.updatedAt = now();
    notifyTask(task);
    drainQueue();
    return json({
      job_id: task.id,
      status: task.status,
      ...(task.status === 'succeeded'
        ? { result: `${GENERATION_GATEWAY_PATH}/jobs/${task.id}/result` }
        : task.error
          ? {
            error: task.providerError ?? task.error,
            ...(task.errorDetails ? { error_details: task.errorDetails } : {}),
            ...(task.requestId ? { request_id: task.requestId } : {}),
          }
          : {}),
    });
  };

  const reconcileQueue = (): void => {
    for (const [taskId, entry] of queuedSubmissions) {
      const task = tasks.get(taskId);
      const executing = executingTaskIds.has(taskId);
      if (!task || (!executing && task.status !== 'queued' && task.status !== 'running')) {
        queuedSubmissions.delete(taskId);
        if (!executing) entry.resolveCompletion();
      }
    }
    drainQueue();
  };

  return async function handle(request: Request): Promise<Response> {
    const currentTime = now();
    for (const [taskId, task] of tasks) {
      const isTerminal = task.status === 'succeeded' || task.status === 'failed';
      const terminalAt = task.terminalAt ?? task.updatedAt;
      if ((!isTerminal && task.createdAt < currentTime - MAX_ACTIVE_TASK_AGE_MS)
        || (isTerminal && terminalAt < currentTime - TERMINAL_TASK_RETENTION_MS)) {
        tasks.delete(taskId);
        continue;
      }
      if (task.resultBlob) {
        const resultExpiresAt = task.resultFetchedAt
          ? task.resultFetchedAt + RESULT_CONFIRMATION_WINDOW_MS
          : (task.resultAvailableAt ?? terminalAt) + RESULT_RETENTION_MS;
        if (resultExpiresAt <= currentTime) {
          task.resultBlob = undefined;
        }
      }
    }
    reconcileQueue();
    const originError = validateOrigin(request, options.expectedOrigin);
    if (originError) {
      return originError;
    }
    const url = new URL(request.url);
    const jobsPath = `${GENERATION_GATEWAY_PATH}/jobs`;
    if (url.pathname !== jobsPath && !url.pathname.startsWith(`${jobsPath}/`)) {
      return errorResponse(404, 'not_found', 'Gateway route not found.');
    }
    const pathParts = url.pathname.slice(jobsPath.length)
      .split('/').filter(Boolean);
    if (request.method === 'GET' && pathParts.length === 2 && pathParts[1] === 'result') {
      const task = tasks.get(pathParts[0]);
      if (!task?.resultBlob) {
        return errorResponse(404, 'result_not_found', 'The generation result is not available.');
      }
      task.resultFetchedAt = now();
      return new Response(task.resultBlob, {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-type': task.resultMimeType ?? (task.resultBlob.type || 'application/octet-stream'),
        },
      });
    }
    const apiKey = trimBearer(request.headers.get('authorization'));
    if (!apiKey) {
      return errorResponse(401, 'api_key_required', 'An ephemeral provider key is required.');
    }
    if (request.method !== 'POST' || (pathParts.length !== 0 && pathParts.length !== 1)) {
      return errorResponse(405, 'method_not_allowed', 'The gateway operation is not allowed.');
    }
    const source = request.headers.get('origin') ?? 'same-origin';
    if (!consumeRateLimit(source)) {
      return errorResponse(429, 'rate_limited', 'Too many gateway requests.');
    }

    let body: unknown;
    try {
      const rawBody = await request.text();
      if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
        return errorResponse(413, 'request_too_large', 'The generation request is too large.');
      }
      body = JSON.parse(rawBody);
    } catch {
      return errorResponse(400, 'invalid_json', 'The gateway request must be valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse(400, 'invalid_request', 'The gateway request is invalid.');
    }
    const record = body as Record<string, unknown>;
    const operation = record.operation;
    if (pathParts.length === 0) {
      if (operation !== 'submit') {
        return errorResponse(400, 'operation_not_allowed', 'Only the submit operation is allowed on this route.');
      }
      const config = loadProvider(record.provider);
      if (!config) {
        return errorResponse(400, 'provider_not_allowed', 'The provider is not enabled for this gateway.');
      }
      if (!safeString(record.projectId, 256) || !safeString(record.projectRevision, 256)) {
        return errorResponse(400, 'project_context_required', 'An active project and revision are required.');
      }
      const requestPayload = parseRequest(record.request);
      if (!requestPayload) {
        return errorResponse(400, 'invalid_generation_request', 'The image generation request is invalid.');
      }
      if (pendingTaskCount(source) >= maxPendingTasksPerSource) {
        return errorResponse(429, 'queue_capacity_exceeded', 'The generation task queue is full.');
      }
      let references: readonly Blob[] = [];
      if (requestPayload.referenceMediaKeys?.length) {
        if (!options.resolveReferenceImages) {
          return errorResponse(400, 'invalid_generation_request', 'The image generation request is invalid.');
        }
        try {
          references = await options.resolveReferenceImages(requestPayload.referenceMediaKeys);
        } catch {
          return errorResponse(400, 'invalid_generation_request', 'The image generation request is invalid.');
        }
        if (references.length !== requestPayload.referenceMediaKeys.length || references.some((reference) => (
          !(reference instanceof Blob)
          || !reference.type.startsWith('image/')
          || reference.size <= 0
          || reference.size > MAX_REFERENCE_IMAGE_BYTES
        ))) {
          return errorResponse(400, 'invalid_generation_request', 'The image generation request is invalid.');
        }
      }
      const queuedRequest = { ...requestPayload };
      delete queuedRequest.referenceMediaKeys;
      return submit(AI_MEDIA_PROVIDER_ID, config, queuedRequest, references, apiKey, source);
    }
    if (operation !== 'poll') {
      return errorResponse(400, 'operation_not_allowed', 'Only the poll operation is allowed for a generation job.');
    }
    const task = tasks.get(pathParts[0]);
    if (!task) {
      return errorResponse(404, 'job_not_found', 'The generation job was not found.');
    }
    const config = loadProvider(task.provider);
    if (!config) {
      return errorResponse(400, 'provider_not_allowed', 'The provider is not enabled for this gateway.');
    }
    return poll(task, config, apiKey);
  };
}
