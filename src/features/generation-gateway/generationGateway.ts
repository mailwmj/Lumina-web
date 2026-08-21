export const GENERATION_GATEWAY_PATH = '/api/generation';
export const AI_MEDIA_PROVIDER_ID = 'ai-media' as const;
const DEFAULT_MODEL_ID = 'ai-media/gpt-image-2';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PROMPT_LENGTH = 32_000;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE_TASK_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESULT_CONFIRMATION_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;
const MAX_CONCURRENT_TASKS_PER_SOURCE = 2;

export type GenerationGatewayProviderId = typeof AI_MEDIA_PROVIDER_ID;
export type GenerationGatewayOperation = 'submit' | 'poll';
export type GenerationGatewayJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found';

export interface GenerationGatewayImageRequest {
  model: string;
  prompt: string;
  size: string;
  aspectRatio?: string;
  extraParams?: Record<string, unknown>;
  referenceImages?: string[];
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
}

interface GenerationGatewayTask extends GenerationGatewayTaskSnapshot {
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
  if (record.referenceImages !== undefined && (
    !Array.isArray(record.referenceImages) || record.referenceImages.length > 0
  )) {
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

function upstreamError(payload: Record<string, unknown> | null, status: number): string {
  const error = payload?.error;
  const message = error && typeof error === 'object' && !Array.isArray(error)
    ? (error as Record<string, unknown>).message
    : error;
  return typeof message === 'string' && message.trim()
    ? message.trim().slice(0, 500)
    : `Upstream image provider returned HTTP ${status}.`;
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
  const item = Array.isArray(payload.data) ? payload.data[0] : payload;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null;
  }
  const result = item as Record<string, unknown>;
  if (typeof result.b64_json === 'string') {
    const bytes = toBase64Bytes(result.b64_json);
    return bytes ? new Blob([bytes], { type: 'image/png' }) : null;
  }
  if (typeof result.url !== 'string') {
    return null;
  }
  let resultUrl: URL;
  try {
    resultUrl = new URL(result.url);
  } catch {
    return null;
  }
  const allowedUrl = normalizeBaseUrl(allowedBaseUrl);
  if (!allowedUrl || resultUrl.origin !== allowedUrl.origin || resultUrl.protocol !== allowedUrl.protocol) {
    return null;
  }
  const response = await fetchImpl(resultUrl, { redirect: 'manual' });
  if (!response.ok || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) {
    return null;
  }
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > MAX_RESULT_BYTES) {
    return null;
  }
  const blob = await response.blob();
  return blob.size <= MAX_RESULT_BYTES ? blob : null;
}

function taskSnapshot(task: GenerationGatewayTask): GenerationGatewayTaskSnapshot {
  const {
    resultBlob: _resultBlob,
    terminalAt: _terminalAt,
    resultAvailableAt: _resultAvailableAt,
    resultFetchedAt: _resultFetchedAt,
    source: _source,
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

  const concurrentTaskCount = (source: string): number => (
    [...tasks.values()].filter((task) => task.source === source && (task.status === 'queued' || task.status === 'running')).length
  );

  const loadProvider = (provider: unknown): GenerationGatewayProviderConfig | null => {
    if (provider !== AI_MEDIA_PROVIDER_ID) {
      return null;
    }
    return options.providers[AI_MEDIA_PROVIDER_ID] ?? null;
  };

  const submit = async (
    provider: GenerationGatewayProviderId,
    config: GenerationGatewayProviderConfig,
    request: GenerationGatewayImageRequest,
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
    tasks.set(task.id, task);
    notifyTask(task);

    let response: Response;
    try {
      response = await fetchImpl(upstreamUrl(config.baseUrl, 'images/generations'), {
        method: 'POST',
        redirect: 'manual',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(request.extraParams ?? {}),
          prompt: request.prompt,
          size: request.size,
          model: request.model,
          ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
        }),
      });
    } catch {
      task.status = 'failed';
      task.error = 'Unable to reach the configured image provider.';
      task.terminalAt = now();
      task.updatedAt = now();
      notifyTask(task);
      return json({ job_id: task.id, status: task.status, error: task.error }, 202);
    }

    const payload = await readJson(response);
    if (!response.ok) {
      task.status = 'failed';
      task.error = upstreamError(payload, response.status);
      task.updatedAt = now();
      notifyTask(task);
      return json({ job_id: task.id, status: task.status, error: task.error }, 202);
    }

    const upstreamTaskId = typeof payload?.id === 'string' ? payload.id.trim() : '';
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
    return json({ job_id: task.id, status: task.status, ...(task.error ? { error: task.error } : {}) }, 202);
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
      return json({ job_id: task.id, status: task.status, error: task.error ?? 'generation failed' });
    }
    if (!task.upstreamTaskId) {
      return json({ job_id: task.id, status: task.status });
    }
    let response: Response;
    try {
      response = await fetchImpl(upstreamUrl(
        config.baseUrl,
        `images/generations/${encodeURIComponent(task.upstreamTaskId)}`,
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
      task.status = 'failed';
      task.error = upstreamError(payload, response.status);
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
    return json({
      job_id: task.id,
      status: task.status,
      ...(task.status === 'succeeded'
        ? { result: `${GENERATION_GATEWAY_PATH}/jobs/${task.id}/result` }
        : task.error ? { error: task.error } : {}),
    });
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
      if (concurrentTaskCount(source) >= MAX_CONCURRENT_TASKS_PER_SOURCE) {
        return errorResponse(429, 'concurrency_limited', 'Too many active generation tasks.');
      }
      return submit(AI_MEDIA_PROVIDER_ID, config, requestPayload, apiKey, source);
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
