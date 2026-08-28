/* global AbortController, Buffer, Headers, Response, URL, process, setInterval */

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createOutboundClient } from './outbound.mjs';
import { createGatewayLogger } from './operational-log.mjs';
import {
  createGenerationTaskQueue,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MAX_PENDING_TASKS_PER_SOURCE,
} from './generation-task-queue.mjs';
import { createTaskStateStore, isSafeUpstreamTaskId } from './task-state.mjs';
import {
  providerErrorMessage,
  providerRequestId,
  seedanceProviderTarget,
  textProviderTarget,
} from './provider-targets.mjs';
import { createTosTemporaryMediaStore } from './tos-temporary-media.mjs';
import {
  createJsonMediaRequestBody,
  createMultipartRequestBody,
} from './streaming-request-body.mjs';
import { waitForResponseDrain } from './response-backpressure.mjs';
import {
  imageProviderAuthHeaders,
  imageProviderResponseReservationBytes,
  imageProviderProxyRequest,
  imageProviderRequestBodyAllowed,
  imageProviderResultSources,
  imageProviderResultTarget,
  isImageProviderProtocol,
  maximumImageProviderRequestBytes,
} from './image-provider-proxy.mjs';

const PORT = Number(process.env.LUMINA_GATEWAY_PORT ?? 8787);
const ORIGIN = process.env.LUMINA_GATEWAY_ORIGIN ?? '';
const AI_MEDIA_UPSTREAM_BASE_URL = process.env.LUMINA_GATEWAY_AI_MEDIA_BASE_URL ?? 'https://api.ai-media.vip/v1';
const CHAOMO_UPSTREAM_BASE_URL = process.env.LUMINA_GATEWAY_CHAOMO_BASE_URL ?? 'https://www.chaomoapi.com/v1';
const MAX_GENERATION_REQUEST_BYTES = boundedNumber(
  'LUMINA_GATEWAY_MAX_GENERATION_REQUEST_BYTES',
  1024 * 1024,
  1024 * 1024,
);
const MAX_RESULT_BYTES = 50 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_PROVIDER_RESPONSE_BYTES = Math.ceil(MAX_RESULT_BYTES / 3) * 4 + 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_COUNT = 10;
const MAX_IMAGE_REFERENCE_AGGREGATE_BYTES = 250 * 1024 * 1024;
const MAX_IMAGE_PROVIDER_REQUEST_BYTES = maximumImageProviderRequestBytes({
  maxAggregateImageBytes: MAX_IMAGE_REFERENCE_AGGREGATE_BYTES,
  maxImageCount: MAX_REFERENCE_IMAGE_COUNT,
  maxMetadataBytes: MAX_GENERATION_REQUEST_BYTES,
});
const MAX_IMAGE_PROVIDER_PROXY_CONCURRENT_REQUESTS = boundedNumber(
  'LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_CONCURRENT_REQUESTS',
  4,
  8,
);
const MAX_IMAGE_PROVIDER_PROXY_RESIDENT_BYTES = boundedNumber(
  'LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_RESIDENT_BYTES',
  768 * 1024 * 1024,
  768 * 1024 * 1024,
);
const IMAGE_PROVIDER_RESPONSE_RESERVATION_BYTES = imageProviderResponseReservationBytes({
  maxProviderResponseBytes: MAX_IMAGE_PROVIDER_RESPONSE_BYTES,
  maxResultBytes: MAX_RESULT_BYTES,
});
const GATEWAY_OUTBOUND_TIMEOUT_MS = boundedNumber(
  'LUMINA_GATEWAY_OUTBOUND_TIMEOUT_MS',
  5 * 60 * 1000,
  10 * 60 * 1000,
);
const IMAGE_PROVIDER_PROXY_TIMEOUT_MS = boundedNumber(
  'LUMINA_GATEWAY_IMAGE_PROVIDER_PROXY_TIMEOUT_MS',
  GATEWAY_OUTBOUND_TIMEOUT_MS,
  10 * 60 * 1000,
);
const IMAGE_PROVIDER_RESULT_CAPABILITY_TTL_MS = 10 * 60 * 1000;
const IMAGE_PROVIDER_RESULT_CLAIM_TTL_MS = Math.min(
  IMAGE_PROVIDER_RESULT_CAPABILITY_TTL_MS,
  IMAGE_PROVIDER_PROXY_TIMEOUT_MS + 30 * 1000,
);
const MAX_IMAGE_PROVIDER_RESULT_REQUEST_BYTES = 32 * 1024;
const MAX_IMAGE_PROVIDER_RESULT_CAPABILITIES_PER_SESSION = 256;
const MAX_TEXT_REFERENCE_AGGREGATE_BYTES = MAX_IMAGE_REFERENCE_AGGREGATE_BYTES;
const MAX_TEXT_PROVIDER_REQUEST_BYTES = MAX_IMAGE_PROVIDER_REQUEST_BYTES;
const MAX_VIDEO_RESULT_BYTES = 512 * 1024 * 1024;
const MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES = 5;
const MAXIMUM_POLL_RETRY_DELAY_MS = 30 * 1000;
const AI_MEDIA_PROVIDER_ID = 'ai-media';
const CHAOMO_PROVIDER_ID = 'chaomo';
const CUSTOM_OPENAI_PROVIDER_PREFIX = 'custom-openai:';
const MAX_CUSTOM_IMAGE_PROVIDERS_PER_SESSION = 32;
const MODEL_ID = `${AI_MEDIA_PROVIDER_ID}/gpt-image-2`;
const UPSTREAM_MODEL_ID = 'gpt-image-2';

function boundedNumber(name, fallback, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), maximum) : fallback;
}

const RATE_LIMIT_WINDOW_MS = boundedNumber('LUMINA_GATEWAY_RATE_LIMIT_WINDOW_MS', 60 * 1000, 60 * 60 * 1000);
const MAX_REQUESTS_PER_WINDOW = boundedNumber('LUMINA_GATEWAY_MAX_REQUESTS_PER_WINDOW', 10_000, 10_000);
const MAX_PENDING_TASKS_PER_SOURCE = boundedNumber(
  'LUMINA_GATEWAY_MAX_PENDING_TASKS_PER_SOURCE',
  boundedNumber(
    'LUMINA_GATEWAY_MAX_CONCURRENT_TASKS_PER_SOURCE',
    DEFAULT_MAX_PENDING_TASKS_PER_SOURCE,
    DEFAULT_MAX_PENDING_TASKS_PER_SOURCE,
  ),
  DEFAULT_MAX_PENDING_TASKS_PER_SOURCE,
);
const MAX_CONCURRENT_TASKS = boundedNumber(
  'LUMINA_GATEWAY_MAX_CONCURRENT_TASKS',
  boundedNumber(
    'LUMINA_GATEWAY_MAX_ACTIVE_TASKS_PER_PROVIDER',
    DEFAULT_MAX_CONCURRENT_TASKS,
    DEFAULT_MAX_PENDING_TASKS_PER_SOURCE,
  ),
  DEFAULT_MAX_PENDING_TASKS_PER_SOURCE,
);
const POLL_RETRY_BASE_DELAY_MS = boundedNumber(
  'LUMINA_GATEWAY_POLL_RETRY_BASE_DELAY_MS',
  1_000,
  MAXIMUM_POLL_RETRY_DELAY_MS,
);
const MAX_ACTIVE_TASK_AGE_MS = boundedNumber('LUMINA_GATEWAY_ACTIVE_TASK_TTL_MS', 7 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const TERMINAL_TASK_RETENTION_MS = boundedNumber('LUMINA_GATEWAY_TERMINAL_TASK_TTL_MS', 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
const RESULT_RETENTION_MS = boundedNumber('LUMINA_GATEWAY_RESULT_TTL_MS', 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
const RESULT_CONFIRMATION_WINDOW_MS = boundedNumber('LUMINA_GATEWAY_RESULT_CONFIRMATION_TTL_MS', 60 * 60 * 1000, 60 * 60 * 1000);
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
const CUSTOM_PROVIDER_TTL_MS = SESSION_MAX_AGE_SECONDS * 1000;
const TRUST_PROXY = process.env.LUMINA_GATEWAY_TRUST_PROXY === '1';
const STATE_FILE = process.env.LUMINA_GATEWAY_STATE_FILE ?? join(tmpdir(), 'lumina-generation-gateway-tasks.json');
const LOG_FILE = process.env.LUMINA_GATEWAY_LOG_FILE ?? join(tmpdir(), 'lumina-generation-gateway.log.jsonl');
const MEDIA_TRANSCODER_URL = process.env.LUMINA_GATEWAY_MEDIA_TRANSCODER_URL ?? '';
const MAX_MEDIA_BYTES = boundedNumber('LUMINA_GATEWAY_MAX_MEDIA_BYTES', 64 * 1024 * 1024, 64 * 1024 * 1024);
const MAX_TEMPORARY_MEDIA_BYTES_PER_SESSION = boundedNumber(
  'LUMINA_GATEWAY_MAX_TEMPORARY_MEDIA_BYTES_PER_SESSION',
  256 * 1024 * 1024,
  256 * 1024 * 1024,
);
const MAX_TEMPORARY_MEDIA_BYTES = Math.max(
  MAX_TEMPORARY_MEDIA_BYTES_PER_SESSION,
  boundedNumber(
    'LUMINA_GATEWAY_MAX_TEMPORARY_MEDIA_BYTES',
    512 * 1024 * 1024,
    512 * 1024 * 1024,
  ),
);
const MEDIA_TTL_MS = boundedNumber('LUMINA_GATEWAY_MEDIA_TTL_MS', 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
const MEDIA_PROVIDER_IDS = new Set((process.env.LUMINA_GATEWAY_MEDIA_PROVIDER_IDS ?? 'volcengine-seedance,text-reference')
  .split(',').map((providerId) => providerId.trim()).filter(Boolean));
const PUBLIC_TEMPORARY_MEDIA_PROVIDER_IDS = new Set(['volcengine-seedance', 'fal-reference']);
const ALLOW_LOCAL_MEDIA_DELIVERY = process.env.NODE_ENV === 'test'
  || process.env.LUMINA_GATEWAY_ALLOW_LOCAL_MEDIA_DELIVERY === '1';
const rateLimits = new Map();
const temporaryMedia = new Map();
const imageProviderResultCapabilities = new Map();
const tosMediaStore = createTosTemporaryMediaStore({ requestTimeoutMs: IMAGE_PROVIDER_PROXY_TIMEOUT_MS });
let activeImageProviderProxyRequests = 0;
let residentImageProviderProxyBytes = 0;
const imageProviderProxyCapacityWaiters = new Set();
let inFlightTemporaryMediaBytes = 0;
const inFlightTemporaryMediaBytesBySession = new Map();

function configuredOutboundOrigin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

const AI_MEDIA_UPSTREAM_ORIGIN = configuredOutboundOrigin(AI_MEDIA_UPSTREAM_BASE_URL);
const CHAOMO_UPSTREAM_ORIGIN = configuredOutboundOrigin(CHAOMO_UPSTREAM_BASE_URL);
const IMAGE_PROVIDERS = new Map([
  [AI_MEDIA_PROVIDER_ID, {
    id: AI_MEDIA_PROVIDER_ID,
    baseUrl: AI_MEDIA_UPSTREAM_BASE_URL,
    origin: AI_MEDIA_UPSTREAM_ORIGIN,
    acceptsModel: (model) => model === MODEL_ID,
  }],
  [CHAOMO_PROVIDER_ID, {
    id: CHAOMO_PROVIDER_ID,
    baseUrl: CHAOMO_UPSTREAM_BASE_URL,
    origin: CHAOMO_UPSTREAM_ORIGIN,
    acceptsModel: (model) => typeof model === 'string'
      && /^chaomo\/[A-Za-z0-9._-]{1,256}$/.test(model),
  }],
]);
const customImageProviders = new Map();
const TRUSTED_PRIVATE_ORIGINS = ['development', 'test'].includes(process.env.NODE_ENV)
  ? (process.env.LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS ?? '')
    .split(',')
    .map((value) => configuredOutboundOrigin(value.trim()))
    .filter((origin) => {
      if (!origin) return false;
      const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
      return host === 'localhost' || host === '127.0.0.1' || host === '::1';
    })
  : [];
const outbound = createOutboundClient({
  trustedPrivateOrigins: TRUSTED_PRIVATE_ORIGINS,
  trustedHttpsSyntheticOrigins: [AI_MEDIA_UPSTREAM_ORIGIN, CHAOMO_UPSTREAM_ORIGIN].filter(Boolean),
  defaultTimeoutMs: GATEWAY_OUTBOUND_TIMEOUT_MS,
});
const logger = createGatewayLogger({ file: LOG_FILE });
setInterval(() => logger.prune(), 60 * 60 * 1000).unref();

const MEDIA_MIME_TYPES = {
  image: new Set(['image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']),
  audio: new Set(['audio/aac', 'audio/flac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/x-wav']),
  video: new Set(['video/avi', 'video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm', 'video/x-matroska']),
};

function decodeBase64(value, maxBytes) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes * 4 / 3) + 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1
    || (value.includes('=') && value.length % 4 !== 0)) {
    return null;
  }
  const padded = value.includes('=') ? value : `${value}${'='.repeat((4 - value.length % 4) % 4)}`;
  const bytes = Buffer.from(padded, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    return null;
  }
  return bytes;
}

function resolveImageSize(resolution, aspectRatio = '1:1') {
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

function resolveImageQuality(resolution) {
  switch (resolution.trim().toLowerCase()) {
    case '1k': case 'low': return 'low';
    case '2k': case 'medium': return 'medium';
    case '4k': case 'high': return 'high';
    case 'auto': return 'auto';
    default: return null;
  }
}

function aiMediaRequestFields(request) {
  const quality = resolveImageQuality(request.size);
  return {
    ...(request.extraParams && typeof request.extraParams === 'object' ? request.extraParams : {}),
    model: UPSTREAM_MODEL_ID,
    prompt: request.prompt,
    n: 1,
    size: resolveImageSize(request.size, request.aspectRatio),
    ...(quality ? { quality } : {}),
    async: true,
    response_format: 'b64_json',
  };
}

function chaomoRequestFields(request) {
  const model = request.model.slice(`${CHAOMO_PROVIDER_ID}/`.length);
  return {
    ...(request.extraParams && typeof request.extraParams === 'object' ? request.extraParams : {}),
    model,
    prompt: request.prompt,
    n: 1,
    ratio: request.aspectRatio || '1:1',
    response_format: 'url',
    async: true,
    ...(!/Hight$/i.test(model) && model !== 'gpt-image2-4K' ? { quality: 'medium' } : {}),
  };
}

function isCustomOpenAiProviderId(providerId) {
  return typeof providerId === 'string'
    && new RegExp(`^${CUSTOM_OPENAI_PROVIDER_PREFIX}[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`).test(providerId);
}

function normalizeCustomProviderBaseUrl(value) {
  if (typeof value !== 'string' || value.trim().length > 2048) return null;
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed;
  } catch {
    return null;
  }
}

function registerCustomImageProvider(value, sessionBinding) {
  const provider = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!provider || !isCustomOpenAiProviderId(provider.id) || provider.protocol !== 'openai-images') {
    return null;
  }
  const baseUrl = normalizeCustomProviderBaseUrl(provider.base_url);
  const origin = baseUrl ? configuredOutboundOrigin(baseUrl.toString()) : null;
  if (!baseUrl || !origin) return null;

  const existing = customImageProviders.get(provider.id);
  if (existing && existing.sessionBinding !== sessionBinding) return null;
  if (existing && existing.baseUrl !== baseUrl.toString()
    && [...tasks.values()].some((task) => task.provider === provider.id
      && (task.status === 'queued' || task.status === 'running'))) {
    return null;
  }
  if (!existing && [...customImageProviders.values()]
    .filter((item) => item.sessionBinding === sessionBinding).length >= MAX_CUSTOM_IMAGE_PROVIDERS_PER_SESSION) {
    return null;
  }

  const id = provider.id;
  const customProvider = {
    id,
    baseUrl: baseUrl.toString(),
    origin,
    protocol: 'openai-images',
    sessionBinding,
    updatedAt: Date.now(),
    acceptsModel: (model) => typeof model === 'string' && model.startsWith(`${id}/`)
      && /^[A-Za-z0-9._/-]{1,256}$/.test(model.slice(id.length + 1)),
  };
  customImageProviders.set(id, customProvider);
  return customProvider;
}

function configuredImageProvider(providerId, sessionBinding) {
  const provider = IMAGE_PROVIDERS.get(providerId);
  if (provider?.origin) return provider;
  const customProvider = customImageProviders.get(providerId);
  return customProvider?.sessionBinding === sessionBinding
    && customProvider.updatedAt > Date.now() - CUSTOM_PROVIDER_TTL_MS ? customProvider : null;
}

function providerRequestFields(provider, request) {
  if (provider.id === CHAOMO_PROVIDER_ID) return chaomoRequestFields(request);
  if (provider.protocol === 'openai-images') {
    const model = request.model.slice(`${provider.id}/`.length);
    const quality = resolveImageQuality(request.size);
    const [width, height] = String(request.aspectRatio ?? '1:1').split(':').map(Number);
    const size = Number.isFinite(width) && Number.isFinite(height) && width > height
      ? '1536x1024'
      : Number.isFinite(width) && Number.isFinite(height) && width < height
        ? '1024x1536' : '1024x1024';
    return {
      ...(request.extraParams && typeof request.extraParams === 'object' ? request.extraParams : {}),
      model,
      prompt: request.prompt,
      n: 1,
      size,
      ...(quality ? { quality } : {}),
      response_format: 'b64_json',
    };
  }
  return aiMediaRequestFields(request);
}

function normalizeConfiguredOrigin(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

const CANONICAL_ORIGIN = normalizeConfiguredOrigin(ORIGIN);

const taskState = createTaskStateStore({
  file: STATE_FILE,
  activeRetentionMs: MAX_ACTIVE_TASK_AGE_MS,
  terminalRetentionMs: TERMINAL_TASK_RETENTION_MS,
  resultRetentionMs: RESULT_RETENTION_MS,
  confirmationRetentionMs: RESULT_CONFIRMATION_WINDOW_MS,
  maxResultBytes: MAX_RESULT_BYTES,
});
const tasks = taskState.tasks;
const activeManagedImagePolls = new Map();
let generationTaskQueue;

function saveTasks() {
  taskState.save();
  for (const task of tasks.values()) {
    if (task.status === 'succeeded' && task.bytes && taskState.hasResult(task.id)) delete task.bytes;
  }
}

const interruptedAt = Date.now();
for (const task of tasks.values()) {
  if (task.status === 'queued' || (task.status === 'running' && !task.upstreamTaskId)) {
    task.status = 'failed';
    task.errorCode = 'submission_interrupted';
    task.terminalAt = interruptedAt;
    task.updatedAt = interruptedAt;
  }
}
saveTasks();

function sourceAddress(request) {
  const forwarded = TRUST_PROXY
    ? String(request.headers['x-forwarded-for'] ?? '').split(',', 1)[0].trim()
    : '';
  return forwarded && isIP(forwarded) ? forwarded : request.socket.remoteAddress ?? 'unknown';
}

function hashValue(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requestSource(sourceIp) {
  return hashValue(sourceIp);
}

function requestSessionBinding(sessionId, sourceIp) {
  return hashValue(`${sessionId}\n${sourceIp}`);
}

function requestSession(request) {
  const cookie = request.headers.cookie ?? '';
  const match = cookie.match(/(?:^|;\s*)lumina_session=([A-Za-z0-9-]{16,128})(?:;|$)/);
  return match?.[1] ?? randomUUID();
}

function setSessionCookie(response, sessionId) {
  response.setHeader(
    'set-cookie',
    `lumina_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/api/generation; Max-Age=${SESSION_MAX_AGE_SECONDS}${CANONICAL_ORIGIN?.startsWith('https:') ? '; Secure' : ''}`,
  );
}

function consumeRateLimit(source) {
  const currentTime = Date.now();
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
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.luminaBytes = body.length;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  response.end(body);
}

function sendError(response, status, code, message) {
  sendJson(response, status, {
    error: code,
    message,
    request_id: response.getHeader('x-request-id'),
  });
}

function sendCapacityError(response, code, message) {
  response.setHeader('retry-after', String(Math.max(1, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000))));
  return sendError(response, 429, code, message);
}

function bearer(request) {
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const key = header.slice(7).trim();
  return key && key.length <= 4096 ? key : null;
}

function originError(request) {
  if (!CANONICAL_ORIGIN) {
    return { status: 503, code: 'gateway_origin_unconfigured', message: 'The gateway canonical Origin is not configured.' };
  }
  const origin = request.headers.origin;
  if (!origin) {
    return request.method === 'GET'
      ? null
      : { status: 403, code: 'origin_required', message: 'The canonical Origin is required.' };
  }
  return origin === CANONICAL_ORIGIN
    ? null
    : { status: 403, code: 'origin_not_allowed', message: 'The request origin is not allowed.' };
}

function requestOperation(request) {
  const pathname = new URL(request.url ?? '/', 'http://gateway.invalid').pathname;
  if (pathname === '/api/generation/image-provider') return 'image_provider_proxy';
  if (pathname === '/api/generation/image-provider/result') return 'image_provider_result';
  if (pathname === '/api/generation/providers/custom') return 'provider_register';
  if (pathname === '/api/generation/providers/models') return 'model_discovery';
  if (pathname === '/api/generation/providers/chaomo/models') return 'model_discovery';
  if (pathname === '/api/generation/text') return 'text_proxy';
  if (pathname === '/api/generation/video') return 'video_proxy';
  if (pathname.startsWith('/api/generation/media')) {
    if (request.method === 'GET') return 'media_retrieve';
    if (request.method === 'DELETE') return 'media_release';
    if (request.headers['x-lumina-media-operation'] === 'publish'
      || request.headers['x-lumina-media-operation'] === 'publish-url') return 'media_publish';
    if (request.headers['x-lumina-media-operation'] === 'transcode') return 'media_transcode';
    return 'unknown';
  }
  if (!pathname.startsWith('/api/generation/jobs')) return 'unknown';
  if (pathname.endsWith('/result/confirmed')) return 'result_confirm';
  if (pathname.endsWith('/result')) return 'result';
  return pathname === '/api/generation/jobs' ? 'submit' : 'poll';
}

function upstreamUrl(provider, path) {
  const base = new URL(provider.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Invalid gateway upstream configuration.');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  return new URL(path.replace(/^\/+/, ''), base);
}

function isJsonContentType(value) {
  const contentType = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return contentType === 'application/json' || contentType.endsWith('+json');
}

async function readJsonBody(request, maximumBytes) {
  if (!isJsonContentType(request.headers['content-type'])) {
    throw Object.assign(new Error('The generation request must use application/json.'), {
      status: 415,
      code: 'request_content_type_not_allowed',
    });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    request.luminaBytes = length;
    if (length > maximumBytes) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 });
  }
}

async function readBoundedMediaStream(stream, maximumBytes, capacityLease, onLength, declaredLength = null) {
  if (declaredLength !== null) capacityLease?.grow(declaredLength);
  const output = declaredLength !== null ? Buffer.allocUnsafe(declaredLength) : null;
  const chunks = output ? null : [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    length += bytes.length;
    onLength?.(length);
    if (length > maximumBytes || (declaredLength !== null && length > declaredLength)) {
      throw Object.assign(new Error('media is too large'), { status: 413 });
    }
    if (output) {
      bytes.copy(output, length - bytes.length);
    } else {
      capacityLease?.grow(bytes.length);
      chunks.push(bytes);
    }
  }
  if (length === 0) throw Object.assign(new Error('media is empty'), { status: 400 });
  if (declaredLength !== null) {
    if (length !== declaredLength) throw Object.assign(new Error('media length is invalid'), { status: 400 });
    return output;
  }
  if (chunks.length === 1) return chunks[0];
  capacityLease?.grow(length);
  const bytes = Buffer.concat(chunks, length);
  capacityLease?.shrink(length);
  return bytes;
}

async function readMediaBody(request, capacityLease) {
  const declaredLength = Number(request.headers['content-length'] ?? '0');
  const hasDeclaredLength = request.headers['content-length'] !== undefined;
  if (hasDeclaredLength && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
    throw Object.assign(new Error('media length is invalid'), { status: 400 });
  }
  if (hasDeclaredLength && declaredLength > MAX_MEDIA_BYTES) {
    throw Object.assign(new Error('media is too large'), { status: 413 });
  }
  return await readBoundedMediaStream(
    request,
    MAX_MEDIA_BYTES,
    capacityLease,
    (length) => { request.luminaBytes = length; },
    hasDeclaredLength ? declaredLength : null,
  );
}

function mediaContentType(request) {
  return String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
}

function mediaKind(request) {
  const kind = request.headers['x-lumina-media-kind'];
  return kind === 'image' || kind === 'audio' || kind === 'video' ? kind : null;
}

function mediaOutputContentType(kind) {
  return kind === 'audio' ? 'audio/mpeg' : 'video/mp4';
}

function isAllowedMediaType(kind, contentType) {
  return MEDIA_MIME_TYPES[kind]?.has(contentType) ?? false;
}

function mediaOrigin(request) {
  return CANONICAL_ORIGIN;
}

function deleteExpiredTemporaryMedia(currentTime = Date.now()) {
  for (const [key, media] of temporaryMedia) {
    if (media.expiresAt <= currentTime) {
      if (media.referenceCount > 0) {
        media.releaseRequested = true;
      } else {
        temporaryMedia.delete(key);
        if (media.tosObjectKey) void tosMediaStore.release(media.tosObjectKey).catch(() => undefined);
      }
    }
  }
}

function requestLifecycle(request, response) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnClose = () => {
    if (!response.writableFinished) abort();
  };
  request.once('aborted', abort);
  response.once('close', abortOnClose);
  return {
    signal: controller.signal,
    release: () => {
      request.removeListener('aborted', abort);
      response.removeListener('close', abortOnClose);
    },
  };
}

async function readBody(request) {
  return await readJsonBody(request, MAX_GENERATION_REQUEST_BYTES);
}

function acquireImageProviderProxySlot() {
  if (activeImageProviderProxyRequests >= MAX_IMAGE_PROVIDER_PROXY_CONCURRENT_REQUESTS) return false;
  activeImageProviderProxyRequests += 1;
  return true;
}

function releaseImageProviderProxySlot() {
  activeImageProviderProxyRequests = Math.max(0, activeImageProviderProxyRequests - 1);
}

function reserveImageProviderProxyBytes(length) {
  if (!Number.isSafeInteger(length) || length < 0
    || residentImageProviderProxyBytes + length > MAX_IMAGE_PROVIDER_PROXY_RESIDENT_BYTES) {
    return false;
  }
  residentImageProviderProxyBytes += length;
  return true;
}

function releaseImageProviderProxyBytes(length) {
  residentImageProviderProxyBytes = Math.max(0, residentImageProviderProxyBytes - length);
  for (const wake of imageProviderProxyCapacityWaiters) wake();
  imageProviderProxyCapacityWaiters.clear();
}

function acquireImageProviderProxyByteLease(length) {
  if (!reserveImageProviderProxyBytes(length)) return null;
  let active = true;
  return {
    release: () => {
      if (!active) return;
      active = false;
      releaseImageProviderProxyBytes(length);
    },
  };
}

function imageProviderResponseReservationTarget() {
  return IMAGE_PROVIDER_RESPONSE_RESERVATION_BYTES;
}

async function waitForImageProviderProxyByteLease(length) {
  if (length > MAX_IMAGE_PROVIDER_PROXY_RESIDENT_BYTES) return null;
  for (;;) {
    const lease = acquireImageProviderProxyByteLease(length);
    if (lease) return lease;
    await new Promise((resolve) => imageProviderProxyCapacityWaiters.add(resolve));
  }
}

async function readResidentImageProviderBytes(
  response,
  maximumBytes,
  { allowEmpty = false, capacityLease = null } = {},
) {
  if (!response.body) {
    if (allowEmpty) return { bytes: Buffer.alloc(0), release: () => undefined };
    throw Object.assign(new Error('image provider result is empty'), {
      status: 502,
      code: 'invalid_provider_result',
      recoverable: false,
    });
  }
  const chunks = [];
  let length = 0;
  let reserved = 0;
  let failure = null;
  const reserve = (byteCount) => {
    if (!reserveImageProviderProxyBytes(byteCount)) {
      throw Object.assign(new Error('image provider proxy capacity exceeded'), {
        status: 429,
        code: 'image_provider_proxy_capacity_exceeded',
        recoverable: true,
      });
    }
    reserved += byteCount;
  };
  try {
    for await (const chunk of response.body) {
      if (failure) continue;
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      length += bytes.length;
      if (length > maximumBytes) {
        failure = Object.assign(new Error('image provider result is too large'), {
          status: 502,
          code: 'invalid_provider_result',
          recoverable: false,
        });
        continue;
      }
      try {
        if (!capacityLease) reserve(bytes.length);
      } catch (error) {
        failure = error;
        continue;
      }
      chunks.push(bytes);
    }
    if (failure) throw failure;
    if (length < 1 && !allowEmpty) {
      throw Object.assign(new Error('image provider result is empty'), {
        status: 502,
        code: 'invalid_provider_result',
        recoverable: false,
      });
    }
    if (chunks.length === 1) {
      return {
        bytes: chunks[0],
        release: () => {
          if (reserved > 0) releaseImageProviderProxyBytes(reserved);
          reserved = 0;
        },
      };
    }
    if (!capacityLease) reserve(length);
    const bytes = Buffer.concat(chunks, length);
    chunks.length = 0;
    if (!capacityLease) {
      releaseImageProviderProxyBytes(length);
      reserved -= length;
    }
    return {
      bytes,
      release: () => {
        if (reserved > 0) releaseImageProviderProxyBytes(reserved);
        reserved = 0;
      },
    };
  } catch (error) {
    if (reserved > 0) releaseImageProviderProxyBytes(reserved);
    throw error;
  }
}

function readResidentImageProviderResult(response, capacityLease = null) {
  return readResidentImageProviderBytes(response, MAX_RESULT_BYTES, { capacityLease });
}

function readResidentImageProviderResponse(response, capacityLease = null) {
  return readResidentImageProviderBytes(response, MAX_IMAGE_PROVIDER_RESPONSE_BYTES, {
    allowEmpty: true,
    capacityLease,
  });
}

function releaseResidentLeaseAfterResponse(response, lease) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    response.removeListener('finish', release);
    response.removeListener('close', release);
    lease.release();
  };
  response.once('finish', release);
  response.once('close', release);
}

async function drainResponseBody(response) {
  if (!response.body) return;
  try {
    for await (const _chunk of response.body) {
      // Draining preserves the Node-to-Web stream adapter lifecycle.
    }
  } catch {
    // The caller already treats this response as unusable.
  }
}

async function readBoundedBinaryBody(request, maximumBytes) {
  const rawDeclaredLength = request.headers['content-length'];
  const hasDeclaredLength = rawDeclaredLength !== undefined;
  const declaredLength = hasDeclaredLength ? Number(rawDeclaredLength) : null;
  if (hasDeclaredLength && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
    throw Object.assign(new Error('request length is invalid'), { status: 400 });
  }
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw Object.assign(new Error('request is too large'), { status: 413 });
  }
  let reserved = 0;
  const reserve = (length) => {
    if (!reserveImageProviderProxyBytes(length)) {
      throw Object.assign(new Error('image provider proxy capacity exceeded'), {
        status: 429,
        code: 'image_provider_proxy_capacity_exceeded',
      });
    }
    reserved += length;
  };
  try {
    if (declaredLength !== null) reserve(declaredLength);
    const output = declaredLength !== null ? Buffer.allocUnsafe(declaredLength) : null;
    const chunks = output ? null : [];
    let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      request.luminaBytes = length;
      if (length > maximumBytes || (declaredLength !== null && length > declaredLength)) {
        throw Object.assign(new Error('request is too large'), { status: 413 });
      }
      if (output) {
        bytes.copy(output, length - bytes.length);
      } else {
        reserve(bytes.length);
        chunks.push(bytes);
      }
    }
    if (length === 0) throw Object.assign(new Error('request is empty'), { status: 400 });
    if (declaredLength !== null && length !== declaredLength) {
      throw Object.assign(new Error('request length is invalid'), { status: 400 });
    }
    let bytes = output;
    if (!bytes && chunks.length === 1) bytes = chunks[0];
    if (!bytes) {
      reserve(length);
      bytes = Buffer.concat(chunks, length);
      chunks.length = 0;
      releaseImageProviderProxyBytes(length);
      reserved -= length;
    }
    return {
      bytes,
      release: () => {
        if (reserved > 0) releaseImageProviderProxyBytes(reserved);
        reserved = 0;
      },
    };
  } catch (error) {
    if (reserved > 0) releaseImageProviderProxyBytes(reserved);
    throw error;
  }
}

function retainTemporaryMediaReferences(keys) {
  for (const key of keys) {
    const media = temporaryMedia.get(key);
    if (media) media.referenceCount = (media.referenceCount ?? 0) + 1;
  }
}

function releaseTemporaryMediaReferences(keys) {
  const currentTime = Date.now();
  for (const key of keys) {
    const media = temporaryMedia.get(key);
    if (!media) continue;
    media.referenceCount = Math.max(0, (media.referenceCount ?? 0) - 1);
    if (media.referenceCount === 0 && (media.releaseRequested || media.expiresAt <= currentTime)) {
      temporaryMedia.delete(key);
      if (media.tosObjectKey) void tosMediaStore.release(media.tosObjectKey).catch(() => undefined);
    }
  }
}

function residentTemporaryMediaBytes(sessionBinding) {
  let sessionBytes = 0;
  let totalBytes = 0;
  for (const media of temporaryMedia.values()) {
    const byteCount = media.bytes?.length ?? 0;
    totalBytes += byteCount;
    if (media.sessionBinding === sessionBinding) sessionBytes += byteCount;
  }
  return { sessionBytes, totalBytes };
}

function reserveTemporaryMediaBytes(byteCount, sessionBinding) {
  deleteExpiredTemporaryMedia();
  const current = residentTemporaryMediaBytes(sessionBinding);
  const sessionInFlight = inFlightTemporaryMediaBytesBySession.get(sessionBinding) ?? 0;
  if (!Number.isSafeInteger(byteCount) || byteCount < 0
    || current.sessionBytes + sessionInFlight + byteCount > MAX_TEMPORARY_MEDIA_BYTES_PER_SESSION
    || current.totalBytes + inFlightTemporaryMediaBytes + byteCount > MAX_TEMPORARY_MEDIA_BYTES) {
    throw Object.assign(new Error('Temporary media capacity is currently exhausted.'), {
      status: 429,
      code: 'temporary_media_capacity_exceeded',
    });
  }
  inFlightTemporaryMediaBytes += byteCount;
  inFlightTemporaryMediaBytesBySession.set(sessionBinding, sessionInFlight + byteCount);
}

function releaseTemporaryMediaReservation(byteCount, sessionBinding) {
  if (!byteCount) return;
  inFlightTemporaryMediaBytes = Math.max(0, inFlightTemporaryMediaBytes - byteCount);
  const next = Math.max(0, (inFlightTemporaryMediaBytesBySession.get(sessionBinding) ?? 0) - byteCount);
  if (next) inFlightTemporaryMediaBytesBySession.set(sessionBinding, next);
  else inFlightTemporaryMediaBytesBySession.delete(sessionBinding);
}

function createTemporaryMediaCapacityLease(sessionBinding) {
  let reserved = 0;
  let active = true;
  return {
    get reservedBytes() { return reserved; },
    grow(byteCount) {
      if (!active || !byteCount) return;
      reserveTemporaryMediaBytes(byteCount, sessionBinding);
      reserved += byteCount;
    },
    shrink(byteCount) {
      if (!active || !byteCount) return;
      const released = Math.min(reserved, byteCount);
      reserved -= released;
      releaseTemporaryMediaReservation(released, sessionBinding);
    },
    release() {
      if (!active) return;
      active = false;
      releaseTemporaryMediaReservation(reserved, sessionBinding);
      reserved = 0;
    },
  };
}

function deleteExpiredRateLimits(currentTime = Date.now()) {
  for (const [source, entry] of rateLimits) {
    if (currentTime - entry.startedAt >= RATE_LIMIT_WINDOW_MS) {
      rateLimits.delete(source);
    }
  }
}

function deleteExpiredCustomImageProviders(currentTime = Date.now()) {
  for (const [providerId, provider] of customImageProviders) {
    if (provider.updatedAt <= currentTime - CUSTOM_PROVIDER_TTL_MS) {
      customImageProviders.delete(providerId);
    }
  }
}

function imageProviderResultCapabilityKey(sessionBinding, protocol, base, target) {
  return createHash('sha256')
    .update(`${sessionBinding}\0${protocol}\0${base.toString()}\0${target.toString()}`)
    .digest('hex');
}

function deleteExpiredImageProviderResultCapabilities(currentTime = Date.now()) {
  for (const [key, capability] of imageProviderResultCapabilities) {
    if (capability.expiresAt <= currentTime) imageProviderResultCapabilities.delete(key);
  }
}

function registerImageProviderResultCapabilities(payload, descriptor, sessionBinding) {
  const currentTime = Date.now();
  deleteExpiredImageProviderResultCapabilities(currentTime);
  for (const source of imageProviderResultSources(payload)) {
    const resolved = imageProviderResultTarget(descriptor.base, source);
    if (!resolved) continue;
    const key = imageProviderResultCapabilityKey(
      sessionBinding,
      descriptor.protocol,
      resolved.base,
      resolved.target,
    );
    const existing = imageProviderResultCapabilities.get(key);
    if (existing) {
      existing.expiresAt = Math.max(
        existing.expiresAt,
        currentTime + IMAGE_PROVIDER_RESULT_CAPABILITY_TTL_MS,
      );
      if (existing.claimToken && existing.claimExpiresAt <= currentTime) {
        delete existing.claimToken;
        delete existing.claimExpiresAt;
      }
      continue;
    }
    const sessionEntries = [...imageProviderResultCapabilities.entries()]
      .filter(([, capability]) => capability.sessionBinding === sessionBinding)
      .sort((left, right) => left[1].createdAt - right[1].createdAt);
    while (sessionEntries.length >= MAX_IMAGE_PROVIDER_RESULT_CAPABILITIES_PER_SESSION) {
      const evictableIndex = sessionEntries.findIndex(([, capability]) => (
        !capability.claimToken || capability.claimExpiresAt <= currentTime
      ));
      if (evictableIndex < 0) break;
      const [oldest] = sessionEntries.splice(evictableIndex, 1);
      imageProviderResultCapabilities.delete(oldest[0]);
    }
    if (sessionEntries.length >= MAX_IMAGE_PROVIDER_RESULT_CAPABILITIES_PER_SESSION) continue;
    imageProviderResultCapabilities.set(key, {
      sessionBinding,
      createdAt: currentTime,
      expiresAt: currentTime + IMAGE_PROVIDER_RESULT_CAPABILITY_TTL_MS,
    });
  }
}

function claimAuthorizedImageProviderResult(body, sessionBinding) {
  if (!isImageProviderProtocol(body?.protocol)) return null;
  const resolved = imageProviderResultTarget(body?.base_url, body?.source);
  if (!resolved) return null;
  const key = imageProviderResultCapabilityKey(
    sessionBinding,
    body.protocol,
    resolved.base,
    resolved.target,
  );
  const capability = imageProviderResultCapabilities.get(key);
  if (!capability || capability.expiresAt <= Date.now()) {
    imageProviderResultCapabilities.delete(key);
    return null;
  }
  const currentTime = Date.now();
  if (capability.claimToken && capability.claimExpiresAt > currentTime) return null;
  const claimToken = randomUUID();
  capability.claimToken = claimToken;
  capability.claimExpiresAt = currentTime + IMAGE_PROVIDER_RESULT_CLAIM_TTL_MS;
  return { key, resolved, claimToken };
}

function settleImageProviderResultClaim(claim, consume) {
  if (!claim) return;
  const capability = imageProviderResultCapabilities.get(claim.key);
  if (!capability || capability.claimToken !== claim.claimToken) return;
  if (consume || capability.expiresAt <= Date.now()) {
    imageProviderResultCapabilities.delete(claim.key);
    return;
  }
  delete capability.claimToken;
  delete capability.claimExpiresAt;
}

function cleanupExpiredState(currentTime = Date.now()) {
  deleteExpiredTemporaryMedia(currentTime);
  deleteExpiredRateLimits(currentTime);
  deleteExpiredCustomImageProviders(currentTime);
  deleteExpiredImageProviderResultCapabilities(currentTime);
  if (taskState.prune(currentTime)) saveTasks();
  generationTaskQueue?.reconcile();
}

const CLEANUP_INTERVAL_MS = Math.max(10, Math.min(60 * 1000,
  RATE_LIMIT_WINDOW_MS,
  MAX_ACTIVE_TASK_AGE_MS,
  TERMINAL_TASK_RETENTION_MS,
  RESULT_RETENTION_MS,
  RESULT_CONFIRMATION_WINDOW_MS,
  MEDIA_TTL_MS));
cleanupExpiredState();
setInterval(() => cleanupExpiredState(), CLEANUP_INTERVAL_MS).unref();

function sendMedia(response, media) {
  response.luminaBytes = media.bytes.length;
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': media.contentType,
    'content-length': media.bytes.length,
    'x-content-type-options': 'nosniff',
  });
  response.end(media.bytes);
}

async function sendTemporaryMedia(response, media, signal) {
  if (media.bytes) return sendMedia(response, media);
  if (!media.remoteUrl || !media.remoteOrigin || !media.kind) {
    return sendError(response, 404, 'temporary_media_not_found', 'The temporary media is not available.');
  }
  let upstream;
  try {
    upstream = await outbound.fetch(media.remoteUrl, {
      allowedOrigin: media.remoteOrigin,
      maxResponseBytes: media.kind === 'video' ? MAX_VIDEO_RESULT_BYTES : MAX_RESULT_BYTES,
      streamResponse: true,
      signal,
    });
  } catch {
    return sendError(response, 502, 'temporary_media_unavailable', 'The temporary media could not be retrieved.');
  }
  const contentType = (upstream.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!upstream.ok || !isAllowedMediaType(media.kind, contentType)) {
    return sendError(response, 502, 'temporary_media_invalid', 'The temporary media response is invalid.');
  }
  response.luminaBytes = 0;
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
  });
  try {
    for await (const chunk of upstream.body) {
      const output = Buffer.from(chunk);
      response.luminaBytes += output.length;
      if (!response.write(output)) await waitForResponseDrain(response, signal);
    }
    response.end();
  } catch {
    response.destroy();
  }
}

async function transcodeMedia(request, response, kind, bytes, signal) {
  if (!MEDIA_TRANSCODER_URL) {
    return sendError(response, 503, 'transcoder_unavailable', 'Gateway transcoding is temporarily unavailable.');
  }
  let target;
  try {
    target = new URL(MEDIA_TRANSCODER_URL);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
      throw new Error('invalid transcoder URL');
    }
  } catch {
    return sendError(response, 503, 'transcoder_unavailable', 'Gateway transcoding is temporarily unavailable.');
  }
  let upstream;
  try {
    upstream = await outbound.fetch(target, {
      allowedOrigin: target.origin,
      method: 'POST',
      headers: {
        'content-type': mediaContentType(request),
        'x-lumina-media-kind': kind,
        'x-lumina-media-file-name': String(request.headers['x-lumina-media-file-name'] ?? ''),
      },
      body: bytes,
      maxRequestBytes: MAX_MEDIA_BYTES,
      maxResponseBytes: MAX_MEDIA_BYTES,
      streamResponse: true,
      signal,
    });
  } catch {
    return sendError(response, 503, 'transcoder_unavailable', 'Gateway transcoding is temporarily unavailable.');
  }
  const expectedType = mediaOutputContentType(kind);
  const outputType = (upstream.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!upstream.ok || upstream.status >= 300 && upstream.status < 400 || outputType !== expectedType) {
    return sendError(response, 502, 'transcode_failed', 'Gateway transcoding did not return the required media format.');
  }
  if (!upstream.body) {
    return sendError(response, 502, 'transcode_failed', 'Gateway transcoding returned an invalid media file.');
  }
  response.luminaBytes = 0;
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': expectedType,
  });
  try {
    for await (const chunk of upstream.body) {
      const output = Buffer.from(chunk);
      response.luminaBytes += output.length;
      if (!response.write(output)) await waitForResponseDrain(response, signal);
    }
    response.end();
  } catch {
    response.destroy();
  }
}

function mediaProviderAllowed(providerId, sessionBinding) {
  return PUBLIC_TEMPORARY_MEDIA_PROVIDER_IDS.has(providerId)
    || MEDIA_PROVIDER_IDS.has(providerId)
    || Boolean(configuredImageProvider(providerId, sessionBinding));
}

async function publicMediaBytes(source, kind, signal, capacityLease) {
  let target;
  try {
    target = new URL(source);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) {
      return null;
    }
  } catch {
    return null;
  }
  const upstream = await outbound.fetch(target, {
    allowedOrigin: target.origin,
    maxResponseBytes: MAX_MEDIA_BYTES,
    streamResponse: true,
    signal,
  });
  const contentType = (upstream.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!upstream.ok || !isAllowedMediaType(kind, contentType) || !upstream.body) {
    await drainResponseBody(upstream);
    return null;
  }
  const bytes = await readBoundedMediaStream(upstream.body, MAX_MEDIA_BYTES, capacityLease);
  return bytes.length && bytes.length <= MAX_MEDIA_BYTES ? { bytes, contentType } : null;
}

async function createTemporaryMediaGrant({
  bytes,
  contentType,
  kind,
  providerId,
  projectId,
  sessionBinding,
  signal,
  capacityLease,
}) {
  const key = `media-${randomUUID()}`;
  const grant = randomUUID();
  let expiresAt = Date.now() + MEDIA_TTL_MS;
  let url;
  let tosObjectKey;
  if (PUBLIC_TEMPORARY_MEDIA_PROVIDER_IDS.has(providerId)) {
    if (!tosMediaStore.available && !ALLOW_LOCAL_MEDIA_DELIVERY) {
      throw Object.assign(new Error('Public temporary media delivery is not configured.'), {
        status: 503,
        code: 'public_media_delivery_unavailable',
      });
    }
    if (tosMediaStore.available) {
      const uploaded = await tosMediaStore.upload({ bytes, contentType, projectId, signal });
      url = uploaded.url;
      tosObjectKey = uploaded.objectKey;
      expiresAt = Math.min(expiresAt, uploaded.expiresAt);
    }
  }
  let grantCapacityLease = capacityLease;
  if (!tosObjectKey) {
    grantCapacityLease ??= createTemporaryMediaCapacityLease(sessionBinding);
    if (grantCapacityLease.reservedBytes < bytes.length) {
      grantCapacityLease.grow(bytes.length - grantCapacityLease.reservedBytes);
    } else if (grantCapacityLease.reservedBytes > bytes.length) {
      grantCapacityLease.shrink(grantCapacityLease.reservedBytes - bytes.length);
    }
  }
  url ??= `${mediaOrigin()}/api/generation/media/${encodeURIComponent(key)}?grant=${encodeURIComponent(grant)}&provider=${encodeURIComponent(providerId)}`;
  temporaryMedia.set(key, {
    ...(tosObjectKey ? { tosObjectKey } : { bytes }),
    contentType,
    kind,
    providerId,
    grant,
    expiresAt,
    sessionBinding,
  });
  grantCapacityLease?.release();
  return { key, url, expiresAt, contentType, sizeBytes: bytes.length };
}

function revokeTemporaryMediaGrant(key, sessionBinding) {
  const media = temporaryMedia.get(key);
  if (!media || media.sessionBinding !== sessionBinding) return;
  temporaryMedia.delete(key);
  if (media.tosObjectKey) void tosMediaStore.release(media.tosObjectKey).catch(() => undefined);
}

async function handleMediaUpload(request, response, sessionBinding, signal) {
  const operation = request.headers['x-lumina-media-operation'];
  const kind = mediaKind(request);
  const contentType = mediaContentType(request);
  if (!['publish', 'publish-url', 'transcode'].includes(operation) || !kind) {
    return sendError(response, 400, 'invalid_media_request', 'The media gateway request is invalid.');
  }
  if (operation !== 'publish-url' && !isAllowedMediaType(kind, contentType)) {
    return sendError(response, 415, 'media_type_not_allowed', 'The media type is not supported by the gateway.');
  }
  if (operation !== 'transcode' && !CANONICAL_ORIGIN) {
    return sendError(response, 503, 'gateway_origin_unconfigured', 'The gateway canonical Origin is not configured.');
  }
  if (operation === 'transcode') {
    const capacityLease = createTemporaryMediaCapacityLease(sessionBinding);
    try {
      const bytes = await readMediaBody(request, capacityLease);
      return await transcodeMedia(request, response, kind, bytes, signal);
    } finally {
      capacityLease.release();
    }
  }
  const providerId = String(request.headers['x-lumina-media-provider'] ?? '').trim();
  if (!mediaProviderAllowed(providerId, sessionBinding)) {
    return sendError(response, 400, 'provider_not_allowed', 'The media provider is not enabled for this gateway.');
  }
  if (providerId === 'fal-reference' && kind !== 'image') {
    return sendError(response, 400, 'invalid_media_request', 'FAL reference delivery only accepts images.');
  }
  let bodyLease;
  let mediaCapacityLease;
  try {
    let media;
    if (operation === 'publish-url') {
      const body = await readBody(request);
      const source = typeof body?.source === 'string' ? body.source : '';
      mediaCapacityLease = createTemporaryMediaCapacityLease(sessionBinding);
      media = await publicMediaBytes(source, kind, signal, mediaCapacityLease);
      if (!media) return sendError(response, 400, 'media_source_invalid', 'The remote media source is invalid or unavailable.');
    } else if (providerId === 'fal-reference') {
      bodyLease = await readBoundedBinaryBody(request, MAX_REFERENCE_IMAGE_BYTES);
      media = { bytes: bodyLease.bytes, contentType };
    } else {
      mediaCapacityLease = createTemporaryMediaCapacityLease(sessionBinding);
      media = { bytes: await readMediaBody(request, mediaCapacityLease), contentType };
    }
    const projectId = String(request.headers['x-lumina-project-id'] ?? '').trim();
    const grant = await createTemporaryMediaGrant({
      ...media,
      kind,
      providerId,
      projectId,
      sessionBinding,
      signal,
      capacityLease: mediaCapacityLease,
    });
    mediaCapacityLease = undefined;
    return sendJson(response, 201, grant);
  } catch (error) {
    if (error?.status === 429 && error?.code === 'image_provider_proxy_capacity_exceeded') {
      return sendCapacityError(response, error.code, error.message);
    }
    return sendError(
      response,
      error?.status || 502,
      error?.code || 'public_media_delivery_failed',
      error?.status === 429 || error?.status === 503
        ? error.message
        : 'The temporary media could not be delivered to the provider.',
    );
  } finally {
    mediaCapacityLease?.release();
    bodyLease?.release();
  }
}

function taskError(task) {
  if (task.errorCode === 'provider_unavailable') return 'Unable to reach the configured image provider.';
  if (task.errorCode === 'provider_rejected') return 'The image provider rejected the generation request.';
  if (task.errorCode === 'invalid_provider_result') return 'The image provider returned no usable result.';
  if (task.errorCode === 'submission_interrupted') return 'The queued generation submission was interrupted before it received a recoverable provider task ID.';
  return 'Generation failed.';
}

function taskErrorDetails(task) {
  if (task.providerMessage) return task.providerMessage;
  return Number.isInteger(task.providerHttpStatus)
    ? `Provider request failed with HTTP ${task.providerHttpStatus}.`
    : null;
}

function taskFailure(task) {
  const details = taskErrorDetails(task);
  return {
    error: taskError(task),
    ...(task.errorCode ? { error_code: task.errorCode } : {}),
    ...(details ? { error_details: details } : {}),
    ...(task.providerRequestId ? { request_id: task.providerRequestId } : {}),
  };
}

function publicModelCatalog(payload) {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [])
      : [];
  const seen = new Set();
  const data = [];
  for (const item of source) {
    const record = typeof item === 'string' ? { id: item } : item && typeof item === 'object' ? item : null;
    const id = typeof record?.id === 'string' ? record.id.trim()
      : typeof record?.name === 'string' ? record.name.trim().replace(/^models\//, '') : '';
    if (!id || id.length > 256 || seen.has(id)) continue;
    seen.add(id);
    const label = ['displayName', 'display_name', 'label', 'name']
      .map((key) => record?.[key])
      .find((value) => typeof value === 'string' && value.trim() && value.trim() !== id)
      ?.trim();
    data.push({ id, ...(label ? { label } : {}) });
    if (data.length >= 200) break;
  }
  return { data };
}

async function jsonResponse(response) {
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType.endsWith('+json')) return null;
  try { return await response.json(); } catch { return null; }
}

function jsonBytes(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
}

async function listProviderModels(provider, key, signal) {
  const upstream = await outbound.fetch(upstreamUrl(provider, 'models'), {
    allowedOrigin: provider.origin,
    headers: { authorization: `Bearer ${key}` },
    maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
    signal,
  });
  if (!upstream.ok) {
    return { status: 502, value: { error: 'provider_rejected', message: 'The image provider rejected the model discovery request.' } };
  }
  return { status: 200, value: publicModelCatalog(await jsonResponse(upstream)) };
}

function textReferenceMedia(keys, sessionBinding) {
  if (keys === undefined) return [];
  if (!Array.isArray(keys) || keys.length > MAX_REFERENCE_IMAGE_COUNT) return null;
  const references = keys.map((key) => {
    if (typeof key !== 'string' || !/^media-[0-9a-f-]{36}$/i.test(key)) return null;
    const media = temporaryMedia.get(key);
    return media?.sessionBinding === sessionBinding
      && media.providerId === 'text-reference'
      && media.kind === 'image'
      && media.bytes?.length > 0
      && media.bytes.length <= MAX_REFERENCE_IMAGE_BYTES
      ? media : null;
  });
  if (references.some((reference) => !reference)) return null;
  const aggregateBytes = references.reduce((total, reference) => total + reference.bytes.length, 0);
  return aggregateBytes <= MAX_TEXT_REFERENCE_AGGREGATE_BYTES ? references : null;
}

function validTextProviderRequest(protocol, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = protocol === 'chat'
    ? new Set(['model', 'messages', 'stream', 'reasoning_effort'])
    : new Set(['model', 'input', 'reasoning']);
  return Object.keys(value).every((key) => allowed.has(key))
    && typeof value.model === 'string'
    && value.model.trim().length > 0
    && value.model.length <= 512;
}

async function proxyText(body, key, sessionBinding, signal) {
  const target = textProviderTarget(body?.base_url, body?.operation, body?.protocol);
  if (!target) {
    return { status: 400, value: { error: 'invalid_text_request', message: 'The text provider request is invalid.' } };
  }
  const method = body.operation === 'models' ? 'GET' : 'POST';
  let providerBody;
  if (method === 'POST') {
    const media = textReferenceMedia(body.reference_media_keys, sessionBinding);
    if (!media || media.some((item) => !item) || !validTextProviderRequest(body.protocol, body.request)) {
      return { status: 400, value: { error: 'invalid_text_request', message: 'The text provider request is invalid.' } };
    }
    try {
      providerBody = createJsonMediaRequestBody(body.request, media);
    } catch {
      return { status: 400, value: { error: 'invalid_text_request', message: 'The text provider request is invalid.' } };
    }
    if (providerBody.byteLength > MAX_TEXT_PROVIDER_REQUEST_BYTES) {
      return { status: 413, value: { error: 'text_request_too_large', message: 'The text provider request is too large.' } };
    }
  }
  let upstream;
  try {
    upstream = await outbound.fetch(target, {
      allowedOrigin: target.origin,
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(providerBody ? { 'content-type': providerBody.contentType } : {}),
      },
      ...(providerBody ? { body: providerBody, maxRequestBytes: MAX_TEXT_PROVIDER_REQUEST_BYTES } : {}),
      maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
      signal,
    });
  } catch {
    return { status: 502, value: { error: 'provider_unavailable', message: 'The text provider is unavailable.' } };
  }
  const payload = await jsonResponse(upstream);
  if (!payload) {
    return { status: 502, value: { error: 'invalid_provider_response', message: 'The text provider returned invalid JSON.' } };
  }
  if (!upstream.ok) {
    const requestId = providerRequestId(payload, upstream.headers);
    return {
      status: upstream.status,
      value: {
        error: { message: providerErrorMessage(payload, `Provider request failed with HTTP ${upstream.status}.`) },
        ...(requestId ? { request_id: requestId } : {}),
      },
    };
  }
  return { status: 200, value: payload };
}

function videoContentValid(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return false;
  return value.every((item) => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.type === 'string'
    && ['text', 'image_url', 'video_url', 'audio_url', 'draft_task'].includes(item.type));
}

function validVideoProviderRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([
    'model', 'content', 'generate_audio', 'resolution', 'ratio', 'duration', 'seed',
    'camera_fixed', 'watermark', 'draft', 'return_last_frame', 'tools',
  ]);
  return Object.keys(value).every((key) => allowed.has(key))
    && typeof value.model === 'string' && value.model.trim().length > 0 && value.model.length <= 512
    && videoContentValid(value.content);
}

function nestedObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function videoResultUrls(payload) {
  const data = nestedObject(payload?.data);
  const content = Array.isArray(payload?.content) ? payload.content
    : payload?.content && typeof payload.content === 'object' ? [payload.content] : [];
  const video = content.find((item) => nestedObject(item)?.type === 'video');
  const result = [
    payload?.output_url,
    payload?.video_url,
    data?.video_url,
    data?.output_url,
    video?.video_url,
    video?.output_url,
  ]
    .find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
  const preview = [
    payload?.preview_url,
    payload?.preview_image_url,
    payload?.cover_url,
    data?.preview_url,
    data?.preview_image_url,
    data?.cover_url,
    data?.cover_image_url,
    data?.thumbnail_url,
    data?.poster_url,
  ]
    .find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
  const lastFrame = [
    payload?.last_frame_url,
    payload?.last_frame_image_url,
    data?.last_frame_url,
    data?.last_frame_image_url,
  ]
    .find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
  return { result, preview, lastFrame };
}

function createRemoteMediaGrant(source, kind, sessionBinding) {
  let target;
  try {
    target = new URL(source);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) return null;
  } catch {
    return null;
  }
  const key = `media-${randomUUID()}`;
  const grant = randomUUID();
  const providerId = 'volcengine-seedance-result';
  const expiresAt = Date.now() + MEDIA_TTL_MS;
  temporaryMedia.set(key, {
    remoteUrl: target.toString(),
    remoteOrigin: target.origin,
    kind,
    providerId,
    grant,
    expiresAt,
    sessionBinding,
  });
  return `${mediaOrigin()}/api/generation/media/${encodeURIComponent(key)}?grant=${encodeURIComponent(grant)}&provider=${providerId}`;
}

function proxiedVideoPayload(payload, sessionBinding) {
  const data = nestedObject(payload?.data);
  const urls = videoResultUrls(payload);
  const result = urls.result ? createRemoteMediaGrant(urls.result, 'video', sessionBinding) : null;
  const preview = urls.preview ? createRemoteMediaGrant(urls.preview, 'image', sessionBinding) : null;
  const lastFrame = urls.lastFrame ? createRemoteMediaGrant(urls.lastFrame, 'image', sessionBinding) : null;
  const errorMessage = providerErrorMessage(payload, '');
  const requestId = providerRequestId(payload, null);
  const status = [payload?.status, data?.status]
    .find((value) => typeof value === 'string' && value.trim());
  return {
    ...(typeof payload?.id === 'string' ? { id: payload.id }
      : typeof data?.id === 'string' ? { id: data.id } : {}),
    ...(typeof payload?.task_id === 'string' ? { task_id: payload.task_id }
      : typeof data?.task_id === 'string' ? { task_id: data.task_id } : {}),
    ...(status ? { status } : {}),
    ...(payload?.deleted === true || data?.deleted === true ? { deleted: true } : {}),
    ...(errorMessage ? { error: { message: errorMessage } } : {}),
    ...(requestId ? { request_id: requestId } : {}),
    ...(result ? { output_url: result } : {}),
    ...(preview ? { preview_url: preview } : {}),
    ...(lastFrame ? { last_frame_url: lastFrame } : {}),
    ...(Number.isFinite(payload?.seed) ? { seed: payload.seed }
      : Number.isFinite(payload?.data?.seed) ? { seed: payload.data.seed } : {}),
  };
}

async function proxyVideo(body, key, sessionBinding, signal) {
  const target = seedanceProviderTarget(body?.base_url, body?.operation, body?.task_id);
  if (!target || (body.operation === 'submit' && !validVideoProviderRequest(body.request))) {
    return { status: 400, value: { error: 'invalid_video_request', message: 'The video provider request is invalid.' } };
  }
  const method = body.operation === 'submit' ? 'POST' : body.operation === 'cancel' ? 'DELETE' : 'GET';
  const providerBody = method === 'POST' ? JSON.stringify(body.request) : undefined;
  let upstream;
  try {
    upstream = await outbound.fetch(target, {
      allowedOrigin: target.origin,
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(providerBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(providerBody ? { body: providerBody, maxRequestBytes: MAX_GENERATION_REQUEST_BYTES } : {}),
      maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
      signal,
    });
  } catch {
    return { status: 502, value: { error: 'provider_unavailable', message: 'The video provider is unavailable.' } };
  }
  if (body.operation === 'cancel' && (upstream.ok || upstream.status === 404)) {
    return { status: 200, value: { deleted: true } };
  }
  const payload = await jsonResponse(upstream);
  if (!upstream.ok) {
    const requestId = providerRequestId(payload, upstream.headers);
    return {
      status: upstream.status,
      value: {
        error: { message: providerErrorMessage(payload, `Provider request failed with HTTP ${upstream.status}.`) },
        ...(requestId ? { request_id: requestId } : {}),
      },
    };
  }
  if (!payload) {
    return { status: 502, value: { error: 'invalid_provider_response', message: 'The video provider returned invalid JSON.' } };
  }
  if (body.operation === 'submit') {
    const data = nestedObject(payload.data);
    const taskId = [payload.task_id, payload.id, data?.task_id, data?.id, payload.request_id]
      .find((value) => isSafeUpstreamTaskId(value));
    if (!taskId) {
      return { status: 502, value: { error: 'invalid_provider_response', message: 'The video provider returned no safe task id.' } };
    }
    return { status: 200, value: { id: taskId } };
  }
  return { status: 200, value: proxiedVideoPayload(payload, sessionBinding) };
}

function imageProviderProxyContentType(request) {
  const value = String(request.headers['content-type'] ?? '').trim();
  const mediaType = value.split(';', 1)[0].toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json') || mediaType === 'multipart/form-data'
    ? value
    : null;
}

async function proxyImageProvider(request, response, key, sessionBinding, signal) {
  const descriptor = imageProviderProxyRequest(request.headers);
  if (!descriptor) {
    return sendError(response, 400, 'invalid_image_provider_request', 'The image provider request is invalid.');
  }
  const contentType = descriptor.method === 'POST' ? imageProviderProxyContentType(request) : null;
  if (descriptor.method === 'POST' && !contentType) {
    return sendError(response, 415, 'image_provider_content_type_not_allowed', 'The image provider request content type is not supported.');
  }
  let bodyLease;
  let responseLease;
  let responseCapacityLease;
  try {
    bodyLease = descriptor.method === 'POST'
      ? await readBoundedBinaryBody(request, MAX_IMAGE_PROVIDER_REQUEST_BYTES)
      : undefined;
  } catch (error) {
    if (error?.status === 429) {
      return sendCapacityError(response, error.code, 'The image provider proxy is at capacity.');
    }
    return sendError(
      response,
      error?.status ?? 400,
      error?.status === 413 ? 'request_too_large' : 'invalid_image_provider_request',
      error?.status === 413 ? 'The image provider request is too large.' : 'The image provider request is invalid.',
    );
  }
  try {
    if (bodyLease && !imageProviderRequestBodyAllowed(descriptor, contentType, bodyLease.bytes, {
      maxImageBytes: MAX_REFERENCE_IMAGE_BYTES,
      maxImageCount: MAX_REFERENCE_IMAGE_COUNT,
      maxAggregateImageBytes: MAX_IMAGE_REFERENCE_AGGREGATE_BYTES,
    })) {
      return sendError(response, 400, 'invalid_image_provider_request', 'The image provider request is invalid.');
    }
    responseCapacityLease = acquireImageProviderProxyByteLease(
      imageProviderResponseReservationTarget(),
    );
    if (!responseCapacityLease) {
      return sendCapacityError(response, 'image_provider_proxy_capacity_exceeded', 'The image provider proxy is at capacity.');
    }
    const upstream = await outbound.fetch(descriptor.target, {
      allowedOrigin: descriptor.target.origin,
      method: descriptor.method,
      headers: imageProviderAuthHeaders(descriptor.protocol, key, contentType),
      ...(bodyLease ? { body: bodyLease.bytes, maxRequestBytes: MAX_IMAGE_PROVIDER_REQUEST_BYTES } : {}),
      maxResponseBytes: MAX_IMAGE_PROVIDER_RESPONSE_BYTES,
      streamResponse: true,
      timeoutMs: IMAGE_PROVIDER_PROXY_TIMEOUT_MS,
      signal,
    });
    bodyLease?.release();
    bodyLease = undefined;
    const upstreamContentType = String(upstream.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    if (upstream.status !== 204 && upstreamContentType !== 'application/json' && !upstreamContentType.endsWith('+json')) {
      await drainResponseBody(upstream);
      return sendError(response, 502, 'invalid_provider_response', 'The image provider returned an unsupported response.');
    }
    responseLease = upstream.status === 204
      ? undefined
      : await readResidentImageProviderResponse(upstream, responseCapacityLease);
    const bytes = responseLease?.bytes ?? Buffer.alloc(0);
    if (upstream.ok && bytes.length) {
      try {
        registerImageProviderResultCapabilities(JSON.parse(bytes.toString('utf8')), descriptor, sessionBinding);
      } catch {
        // The raw response remains authoritative; malformed JSON is rejected by the browser adapter.
      }
    }
    response.luminaBytes = bytes.length;
    response.writeHead(upstream.status, {
      'cache-control': 'no-store',
      ...(upstream.status === 204 ? {} : { 'content-type': upstreamContentType, 'content-length': bytes.length }),
    });
    if (responseLease) {
      responseLease.release();
      responseLease = undefined;
    }
    releaseResidentLeaseAfterResponse(response, responseCapacityLease);
    responseCapacityLease = undefined;
    return response.end(bytes.length ? bytes : undefined);
  } catch (error) {
    if (error?.status === 429 && error?.code === 'image_provider_proxy_capacity_exceeded') {
      return sendCapacityError(response, error.code, 'The image provider proxy is at capacity.');
    }
    return sendError(response, 502, 'provider_unavailable', 'The image provider is unavailable.');
  } finally {
    responseLease?.release();
    responseCapacityLease?.release();
    bodyLease?.release();
  }
}

async function materializeImageProviderResult(body, key, sessionBinding, signal) {
  if (!isImageProviderProtocol(body?.protocol)) return null;
  const resolved = imageProviderResultTarget(body?.base_url, body?.source);
  if (!resolved) return null;
  const authenticated = resolved.target.origin === resolved.base.origin;
  let upstream;
  try {
    upstream = await outbound.fetch(resolved.target, {
      allowedOrigin: resolved.target.origin,
      headers: authenticated ? imageProviderAuthHeaders(body.protocol, key) : {},
      maxResponseBytes: MAX_RESULT_BYTES,
      streamResponse: true,
      timeoutMs: IMAGE_PROVIDER_PROXY_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    if (permanentProviderResultError(error)) {
      throw Object.assign(new Error('image provider result is invalid'), {
        status: 502,
        code: 'invalid_provider_result',
        recoverable: false,
      });
    }
    throw Object.assign(new Error('image provider result is unavailable'), {
      status: 502,
      code: 'image_provider_result_unavailable',
      recoverable: ['outbound_aborted', 'outbound_timeout', 'outbound_transport_unavailable'].includes(error?.code),
    });
  }
  if (!upstream.ok) {
    await drainResponseBody(upstream);
    throw Object.assign(new Error('image provider result is unavailable'), {
      status: 502,
      code: 'image_provider_result_unavailable',
      recoverable: [408, 425, 429].includes(upstream.status) || upstream.status >= 500,
    });
  }
  const contentType = String(upstream.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!MEDIA_MIME_TYPES.image.has(contentType)) {
    await drainResponseBody(upstream);
    throw Object.assign(new Error('image provider result has an invalid media type'), {
      status: 502,
      code: 'invalid_provider_result',
      recoverable: false,
    });
  }
  const resultLease = await readResidentImageProviderResult(upstream);
  try {
    return await createTemporaryMediaGrant({
      bytes: resultLease.bytes,
      contentType,
      kind: 'image',
      providerId: 'image-provider-result',
      projectId: typeof body?.project_id === 'string' ? body.project_id : undefined,
      sessionBinding,
      signal,
    });
  } catch (error) {
    if (error?.status === 429 || error?.status === 503) error.recoverable = true;
    throw error;
  } finally {
    resultLease.release();
  }
}

function providerRecords(payload, keys = ['data', 'response', 'result']) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const records = [payload];
  for (const key of keys) {
    const value = payload[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
  }
  return records;
}

function resultItems(payload) {
  const records = providerRecords(payload, ['data', 'response', 'result', 'output']);
  return records.flatMap((record) => {
    const nested = ['data', 'images', 'results', 'assets', 'output']
      .flatMap((key) => Array.isArray(record[key]) ? record[key] : []);
    return [record, ...nested];
  }).filter((item) => item && typeof item === 'object' && !Array.isArray(item));
}

function upstreamTaskId(payload) {
  for (const record of providerRecords(payload, ['data'])) {
    for (const key of ['task_id', 'taskId', 'id', 'request_id', 'requestId']) {
      const value = typeof record[key] === 'string' ? record[key].trim() : '';
      if (isSafeUpstreamTaskId(value)) return value;
    }
  }
  return null;
}

function providerTerminalState(payload) {
  const succeeded = new Set(['completed', 'complete', 'done', 'success', 'succeeded']);
  const failed = new Set(['cancelled', 'canceled', 'error', 'expired', 'failed', 'rejected']);
  for (const record of providerRecords(payload)) {
    for (const key of ['status', 'state', 'task_status', 'taskStatus']) {
      const value = typeof record[key] === 'string'
        ? record[key].trim().toLowerCase().replace(/[\s_-]+/g, '')
        : '';
      if (succeeded.has(value)) return 'succeeded';
      if (failed.has(value)) return 'failed';
    }
  }
  return null;
}

async function resultUrlBytes(value, provider, key, authenticated, signal, capacityLease) {
  let resultUrl;
  try { resultUrl = new URL(value, provider.baseUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(resultUrl.protocol) || resultUrl.username || resultUrl.password || resultUrl.hash) return null;
  const providerOrigin = new URL(provider.baseUrl).origin;
  if (authenticated && resultUrl.origin !== providerOrigin) return null;
  let result;
  try {
    result = await outbound.fetch(resultUrl, {
      allowedOrigin: resultUrl.origin,
      headers: authenticated ? { authorization: `Bearer ${key}` } : {},
      maxResponseBytes: MAX_RESULT_BYTES,
      streamResponse: true,
      signal,
    });
  } catch (error) {
    if (permanentProviderResultError(error)) throw providerResultError(false);
    throw providerResultError(true);
  }
  if (!result.ok || result.status >= 300 && result.status < 400) {
    await drainResponseBody(result);
    throw providerResultError(true);
  }
  const contentType = (result.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!MEDIA_MIME_TYPES.image.has(contentType)) {
    await drainResponseBody(result);
    throw providerResultError(false, 'The image provider result has an invalid media type.');
  }
  try {
    const lease = await readResidentImageProviderResult(result, capacityLease);
    try {
      return { bytes: lease.bytes, contentType };
    } finally {
      lease.release();
    }
  } catch (error) {
    if (permanentProviderResultError(error)) throw providerResultError(false);
    throw providerResultError(true);
  }
}

async function resultBytes(payload, provider, key, depth = 0, signal, capacityLease) {
  let recoverableError;
  for (const item of resultItems(payload)) {
    const nestedImage = item.image && typeof item.image === 'object' && !Array.isArray(item.image)
      ? item.image : null;
    const encoded = typeof item.b64_json === 'string' ? item.b64_json
      : typeof item.base64 === 'string' ? item.base64
        : typeof nestedImage?.b64_json === 'string' ? nestedImage.b64_json
          : typeof nestedImage?.base64 === 'string' ? nestedImage.base64 : null;
    if (encoded) {
      const bytes = decodeBase64(encoded, MAX_RESULT_BYTES);
      const contentType = [
        item.media_type,
        item.mime_type,
        item.mimeType,
        nestedImage?.media_type,
        nestedImage?.mime_type,
        nestedImage?.mimeType,
      ]
        .find((value) => typeof value === 'string' && MEDIA_MIME_TYPES.image.has(value.toLowerCase()));
      if (bytes) return { bytes, contentType: contentType?.toLowerCase() ?? 'image/png' };
    }
    const urls = [
      { value: item.signed_url, authenticated: false },
      { value: item.download_url, authenticated: true },
      { value: item.url, authenticated: false },
      { value: nestedImage?.url, authenticated: false },
    ].filter((candidate) => typeof candidate.value === 'string' && candidate.value.trim());
    for (const candidate of urls) {
      try {
        const result = await resultUrlBytes(
          candidate.value,
          provider,
          key,
          candidate.authenticated,
          signal,
          capacityLease,
        );
        if (result) return result;
      } catch (error) {
        recoverableError ??= error;
      }
    }
    if (depth === 0 && typeof item.resultJson === 'string') {
      let nestedPayload;
      try {
        nestedPayload = JSON.parse(item.resultJson);
      } catch { /* malformed nested result is not usable */ }
      if (nestedPayload) {
        try {
          const result = await resultBytes(nestedPayload, provider, key, depth + 1, signal, capacityLease);
          if (result) return result;
        } catch (error) {
          recoverableError ??= error;
        }
      }
    }
  }
  if (recoverableError) throw recoverableError;
  return null;
}

function imageExtension(contentType) {
  return {
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }[contentType] ?? 'bin';
}

function providerReferenceImageField(provider) {
  return provider.id === AI_MEDIA_PROVIDER_ID ? 'image' : 'image[]';
}

function safeProviderPollPath(payload, provider) {
  const candidate = providerRecords(payload, ['data'])
    .flatMap((record) => [record.status_url, record.poll_url])
    .find((value) => typeof value === 'string' && value.trim());
  if (!candidate) return null;
  try {
    const base = new URL(provider.baseUrl);
    const target = new URL(candidate, base);
    const basePath = base.pathname.replace(/\/+$/, '');
    if (target.origin !== base.origin || target.username || target.password || target.hash
      || !target.pathname.startsWith(`${basePath}/`)
      || target.toString().length > 2048
      || [...target.searchParams.keys()].some((name) => /token|secret|key|sign|auth/i.test(name))) {
      return null;
    }
    return `${target.pathname.slice(basePath.length)}${target.search}`;
  } catch {
    return null;
  }
}

function providerPollPath(provider, task) {
  if (task.upstreamPollPath) return task.upstreamPollPath;
  if (provider.id === AI_MEDIA_PROVIDER_ID) {
    return `images/tasks/${encodeURIComponent(task.upstreamTaskId)}?view=summary`;
  }
  if (provider.id === CHAOMO_PROVIDER_ID) return `images/${encodeURIComponent(task.upstreamTaskId)}`;
  return `images/generations/${encodeURIComponent(task.upstreamTaskId)}`;
}

function transientProviderStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function providerResultError(recoverable, message = 'The image provider result is unavailable.') {
  return Object.assign(new Error(message), {
    code: recoverable ? 'image_provider_result_unavailable' : 'invalid_provider_result',
    recoverable,
  });
}

function permanentProviderResultError(error) {
  return error?.recoverable === false
    || error?.code === 'invalid_provider_result'
    || error?.code === 'outbound_response_too_large'
    || error?.code === 'outbound_content_encoding_not_allowed';
}

function stableRetryJitter(taskId, retryCount) {
  let hash = 0x811c9dc5;
  for (const value of `${taskId}:${retryCount}`) {
    hash ^= value.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function scheduleTransientPollRetry(task, currentTime = Date.now()) {
  const retryCount = Math.max(0, Math.floor(task.recovery?.retry_count ?? 0)) + 1;
  const requiresManualRequery = retryCount >= MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES;
  if (requiresManualRequery) {
    task.recovery = {
      retry_count: retryCount,
      requires_manual_requery: true,
      last_error: 'The image provider is temporarily unavailable.',
    };
    return;
  }
  const exponentialDelay = Math.min(
    MAXIMUM_POLL_RETRY_DELAY_MS,
    POLL_RETRY_BASE_DELAY_MS * 2 ** Math.min(retryCount - 1, 5),
  );
  const jitter = stableRetryJitter(task.upstreamTaskId ?? task.id, retryCount)
    % Math.max(1, Math.floor(exponentialDelay / 2));
  task.recovery = {
    retry_count: retryCount,
    next_retry_at: currentTime + exponentialDelay + jitter,
    requires_manual_requery: false,
    last_error: 'The image provider is temporarily unavailable.',
  };
}

function applyProviderFailure(task, upstream, payload) {
  task.status = 'failed';
  task.errorCode = 'provider_rejected';
  task.providerHttpStatus = upstream.status;
  task.providerMessage = providerErrorMessage(payload, '');
  task.providerRequestId = providerRequestId(payload, upstream.headers);
  task.terminalAt = Date.now();
}

async function executeSubmission(task, { request, references, key }) {
  const provider = configuredImageProvider(task.provider, task.sessionBinding);
  if (!provider) {
    task.status = 'failed';
    task.errorCode = 'provider_unavailable';
    task.terminalAt = Date.now();
    task.updatedAt = task.terminalAt;
    saveTasks();
    return;
  }
  let upstream;
  let responseLease;
  const responseCapacityLease = await waitForImageProviderProxyByteLease(
    imageProviderResponseReservationTarget(),
  );
  if (!responseCapacityLease) {
    task.status = 'failed';
    task.errorCode = 'provider_unavailable';
    task.terminalAt = Date.now();
    task.updatedAt = task.terminalAt;
    saveTasks();
    return;
  }
  try {
    const idempotencyHeaders = provider.id === AI_MEDIA_PROVIDER_ID
      ? { 'idempotency-key': `opencanvas-image-${randomUUID()}` }
      : {};
    if (references?.length) {
      const imageField = providerReferenceImageField(provider);
      const multipart = createMultipartRequestBody({
        boundary: `lumina-${randomUUID()}`,
        fields: providerRequestFields(provider, request),
        files: references.map((reference, index) => ({
          name: imageField,
          filename: `reference-${index + 1}.${imageExtension(reference.contentType)}`,
          contentType: reference.contentType,
          bytes: reference.bytes,
        })),
      });
      upstream = await outbound.fetch(upstreamUrl(provider, 'images/edits'), {
        allowedOrigin: provider.origin,
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': multipart.contentType,
          ...idempotencyHeaders,
        },
        body: multipart,
        maxRequestBytes: MAX_IMAGE_PROVIDER_REQUEST_BYTES,
        maxResponseBytes: MAX_IMAGE_PROVIDER_RESPONSE_BYTES,
        streamResponse: true,
      });
    } else {
      upstream = await outbound.fetch(upstreamUrl(provider, 'images/generations'), {
        allowedOrigin: provider.origin,
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...idempotencyHeaders },
        body: JSON.stringify(providerRequestFields(provider, request)),
        maxRequestBytes: MAX_GENERATION_REQUEST_BYTES,
        maxResponseBytes: MAX_IMAGE_PROVIDER_RESPONSE_BYTES,
        streamResponse: true,
      });
    }
    responseLease = await readResidentImageProviderResponse(upstream, responseCapacityLease);
  } catch (error) {
    responseLease?.release();
    task.status = 'failed';
    task.errorCode = permanentProviderResultError(error)
      ? 'invalid_provider_result'
      : 'provider_unavailable';
    task.terminalAt = Date.now();
    task.updatedAt = Date.now();
    saveTasks();
    responseCapacityLease.release();
    return;
  }
  try {
    const payload = jsonBytes(responseLease.bytes);
    const taskId = upstreamTaskId(payload);
    if (!upstream.ok) {
      applyProviderFailure(task, upstream, payload);
    } else {
      let result;
      let resultError;
      try {
        result = await resultBytes(payload, provider, key, 0, undefined, responseCapacityLease);
      } catch (error) {
        resultError = error;
      }
      const terminalState = providerTerminalState(payload);
      if (result) {
        task.status = 'succeeded';
        task.bytes = result.bytes;
        task.contentType = result.contentType;
        task.resultAvailableAt = Date.now();
        task.terminalAt = task.resultAvailableAt;
      } else if (terminalState === 'failed') {
        task.status = 'failed';
        task.errorCode = 'provider_rejected';
        task.terminalAt = Date.now();
      } else if (permanentProviderResultError(resultError)) {
        task.status = 'failed';
        task.errorCode = 'invalid_provider_result';
        task.terminalAt = Date.now();
      } else if (taskId && (terminalState !== 'succeeded' || resultError?.recoverable)) {
        task.status = 'running';
        task.upstreamTaskId = taskId;
        task.upstreamPollPath = safeProviderPollPath(payload, provider) ?? undefined;
        if (resultError) scheduleTransientPollRetry(task);
      } else {
        task.status = 'failed';
        task.errorCode = resultError?.recoverable ? 'provider_unavailable' : 'invalid_provider_result';
        task.terminalAt = Date.now();
      }
    }
  } finally {
    responseLease.release();
    responseCapacityLease.release();
  }
  task.updatedAt = Date.now();
  saveTasks();
}

generationTaskQueue = createGenerationTaskQueue({
  tasks,
  maxPendingTasksPerSource: MAX_PENDING_TASKS_PER_SOURCE,
  maxConcurrentTasks: MAX_CONCURRENT_TASKS,
  execute: async (task, work) => {
    try {
      await executeSubmission(task, work);
    } finally {
      releaseTemporaryMediaReferences(work.referenceMediaKeys ?? []);
    }
  },
  onExecutionError: (task) => {
    if (task.status !== 'queued' && task.status !== 'running') return;
    task.status = 'failed';
    task.errorCode = 'provider_unavailable';
    task.terminalAt = Date.now();
    task.updatedAt = task.terminalAt;
    saveTasks();
  },
});

function imageReferenceMedia(keys, providerId, sessionBinding) {
  if (keys === undefined) return [];
  if (!Array.isArray(keys) || keys.length > MAX_REFERENCE_IMAGE_COUNT) return null;
  const references = keys.map((key) => {
    if (typeof key !== 'string' || !/^media-[0-9a-f-]{36}$/i.test(key)) return null;
    const media = temporaryMedia.get(key);
    if (!media || media.sessionBinding !== sessionBinding || media.providerId !== providerId
      || media.kind !== 'image' || media.releaseRequested || !media.bytes?.length
      || media.bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
      return null;
    }
    return { bytes: media.bytes, contentType: media.contentType };
  });
  if (references.some((reference) => !reference)) return null;
  const aggregateBytes = references.reduce((total, reference) => total + reference.bytes.length, 0);
  return aggregateBytes <= MAX_IMAGE_REFERENCE_AGGREGATE_BYTES ? references : null;
}

async function submit(body, key, sourceId, sessionBinding) {
  const provider = configuredImageProvider(body?.provider, sessionBinding);
  if (!provider || body.operation !== 'submit') {
    return { status: 400, value: { error: 'provider_or_operation_not_allowed', message: 'Only configured providers and submit operations are allowed.' } };
  }
  if (typeof body.projectId !== 'string' || !body.projectId.trim() || typeof body.projectRevision !== 'string' || !body.projectRevision.trim()) {
    return { status: 400, value: { error: 'project_context_required', message: 'An active project and revision are required.' } };
  }
  const request = body.request;
  if (!request || typeof request !== 'object' || !provider.acceptsModel(request.model)
    || typeof request.prompt !== 'string' || !request.prompt.trim() || typeof request.size !== 'string') {
    return { status: 400, value: { error: 'invalid_generation_request', message: 'The image generation request is invalid.' } };
  }
  if (request.referenceImages !== undefined) {
    return { status: 400, value: { error: 'invalid_generation_request', message: 'The image generation request is invalid.' } };
  }
  const references = imageReferenceMedia(request.referenceMediaKeys, provider.id, sessionBinding);
  if (!references) return { status: 400, value: { error: 'invalid_generation_request', message: 'The image generation request is invalid.' } };
  const queuedRequest = { ...request };
  delete queuedRequest.referenceMediaKeys;
  const task = {
    id: `job-${randomUUID()}`,
    provider: provider.id,
    status: 'queued',
    sourceId,
    sessionBinding,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const referenceMediaKeys = request.referenceMediaKeys ?? [];
  retainTemporaryMediaReferences(referenceMediaKeys);
  const scheduled = generationTaskQueue.enqueue(task, {
    request: queuedRequest,
    references,
    referenceMediaKeys,
    key,
  });
  if (!scheduled) {
    releaseTemporaryMediaReferences(referenceMediaKeys);
    return { status: 429, value: { error: 'queue_capacity_exceeded', message: 'The generation task queue is full.' } };
  }
  saveTasks();
  if (scheduled.started) await scheduled.completion;
  return {
    status: 202,
    value: { job_id: task.id, status: task.status, ...(task.status === 'failed' ? taskFailure(task) : {}) },
  };
}

async function performManagedImagePoll(task, key, forceManualRequery = false, signal) {
  const provider = configuredImageProvider(task.provider, task.sessionBinding);
  if (!provider) {
    task.status = 'failed';
    task.errorCode = 'provider_unavailable';
    task.terminalAt = Date.now();
    task.updatedAt = task.terminalAt;
    saveTasks();
    return { status: 200, value: { job_id: task.id, status: task.status, ...taskFailure(task) } };
  }
  if (task.status === 'succeeded') {
    return { status: 200, value: { job_id: task.id, status: task.status, result: `/api/generation/jobs/${task.id}/result` } };
  }
  if (task.status === 'failed') return { status: 200, value: { job_id: task.id, status: task.status, ...taskFailure(task) } };
  if (!task.upstreamTaskId) return { status: 200, value: { job_id: task.id, status: task.status } };
  if (!forceManualRequery && task.recovery?.requires_manual_requery) {
    return { status: 200, value: { job_id: task.id, status: task.status, recovery: task.recovery } };
  }
  if (!forceManualRequery && typeof task.recovery?.next_retry_at === 'number'
    && task.recovery.next_retry_at > Date.now()) {
    return { status: 200, value: { job_id: task.id, status: task.status, recovery: task.recovery } };
  }
  if (forceManualRequery && task.recovery) {
    delete task.recovery;
    saveTasks();
  }
  const responseCapacityLease = acquireImageProviderProxyByteLease(
    imageProviderResponseReservationTarget(),
  );
  if (!responseCapacityLease) {
    scheduleTransientPollRetry(task);
    task.updatedAt = Date.now();
    saveTasks();
    generationTaskQueue.taskUpdated();
    return {
      status: 200,
      value: { job_id: task.id, status: task.status, recovery: task.recovery },
    };
  }
  let responseLease;
  try {
    const upstream = await outbound.fetch(upstreamUrl(provider, providerPollPath(provider, task)), {
      allowedOrigin: provider.origin,
      headers: { authorization: `Bearer ${key}` },
      maxResponseBytes: MAX_IMAGE_PROVIDER_RESPONSE_BYTES,
      streamResponse: true,
      signal,
    });
    responseLease = await readResidentImageProviderResponse(upstream, responseCapacityLease);
    const payload = jsonBytes(responseLease.bytes);
    if (!upstream.ok) {
      if (transientProviderStatus(upstream.status)) {
        scheduleTransientPollRetry(task);
      } else {
        delete task.recovery;
        applyProviderFailure(task, upstream, payload);
      }
    } else {
      delete task.recovery;
      const result = await resultBytes(payload, provider, key, 0, signal, responseCapacityLease);
      if (result) {
        task.status = 'succeeded'; task.bytes = result.bytes; task.contentType = result.contentType;
        task.resultAvailableAt = Date.now();
        task.terminalAt = task.resultAvailableAt;
      } else {
        const terminalState = providerTerminalState(payload);
        if (terminalState) {
          task.status = 'failed';
          task.errorCode = terminalState === 'failed' ? 'provider_rejected' : 'invalid_provider_result';
          task.terminalAt = Date.now();
        }
      }
    }
  } catch (error) {
    if (permanentProviderResultError(error)) {
      delete task.recovery;
      task.status = 'failed';
      task.errorCode = 'invalid_provider_result';
      task.terminalAt = Date.now();
    } else {
      scheduleTransientPollRetry(task);
    }
  } finally {
    responseLease?.release();
    responseCapacityLease.release();
  }
  task.updatedAt = Date.now();
  saveTasks();
  generationTaskQueue.taskUpdated();
  return task.status === 'succeeded'
    ? { status: 200, value: { job_id: task.id, status: task.status, result: `/api/generation/jobs/${task.id}/result` } }
    : {
      status: 200,
      value: {
        job_id: task.id,
        status: task.status,
        ...(task.status === 'failed' ? taskFailure(task) : {}),
        ...(task.recovery ? { recovery: task.recovery } : {}),
      },
  };
}

function poll(task, key, forceManualRequery = false, signal) {
  const active = activeManagedImagePolls.get(task.id);
  if (active) return active;
  let tracked;
  tracked = performManagedImagePoll(task, key, forceManualRequery, signal).finally(() => {
    if (activeManagedImagePolls.get(task.id) === tracked) activeManagedImagePolls.delete(task.id);
  });
  activeManagedImagePolls.set(task.id, tracked);
  return tracked;
}

const server = createServer(async (request, response) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const audit = { operation: requestOperation(request), provider: 'unknown' };
  response.setHeader('x-request-id', requestId);
  response.once('finish', () => {
    logger.record({
      requestId,
      operation: audit.operation,
      provider: String(audit.provider).startsWith(CUSTOM_OPENAI_PROVIDER_PREFIX)
        ? 'custom-openai'
        : audit.provider,
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
      bytes: Number(request.luminaBytes ?? 0) + Number(response.luminaBytes ?? 0),
    });
  });
  const sourceIp = sourceAddress(request);
  const source = requestSource(sourceIp);
  const sessionId = requestSession(request);
  const sessionBinding = requestSessionBinding(sessionId, sourceIp);
  setSessionCookie(response, sessionId);
  cleanupExpiredState();
  const rejectedOrigin = originError(request);
  if (rejectedOrigin) return sendError(response, rejectedOrigin.status, rejectedOrigin.code, rejectedOrigin.message);
  const parsed = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  if (parsed.pathname === '/api/generation/image-provider') {
    audit.provider = isImageProviderProtocol(request.headers['x-lumina-image-protocol'])
      ? request.headers['x-lumina-image-protocol']
      : 'unknown';
    if (!consumeRateLimit(source)) return sendCapacityError(response, 'rate_limited', 'Too many gateway requests.');
    if (request.method !== 'POST') return sendError(response, 405, 'method_not_allowed', 'The image provider proxy only supports POST.');
    const key = bearer(request);
    if (!key) return sendError(response, 401, 'api_key_required', 'An ephemeral provider key is required.');
    if (!acquireImageProviderProxySlot()) {
      return sendCapacityError(response, 'image_provider_proxy_capacity_exceeded', 'The image provider proxy is at capacity.');
    }
    const lifecycle = requestLifecycle(request, response);
    try {
      return await proxyImageProvider(request, response, key, sessionBinding, lifecycle.signal);
    } finally {
      lifecycle.release();
      releaseImageProviderProxySlot();
    }
  }
  if (parsed.pathname === '/api/generation/image-provider/result') {
    if (!consumeRateLimit(source)) return sendCapacityError(response, 'rate_limited', 'Too many gateway requests.');
    if (request.method !== 'POST') return sendError(response, 405, 'method_not_allowed', 'Image result materialization only supports POST.');
    const key = bearer(request);
    if (!key) return sendError(response, 401, 'api_key_required', 'An ephemeral provider key is required.');
    if (!acquireImageProviderProxySlot()) {
      return sendCapacityError(response, 'image_provider_proxy_capacity_exceeded', 'The image provider proxy is at capacity.');
    }
    const lifecycle = requestLifecycle(request, response);
    let claim;
    try {
      const body = await readJsonBody(request, MAX_IMAGE_PROVIDER_RESULT_REQUEST_BYTES);
      audit.provider = isImageProviderProtocol(body?.protocol) ? body.protocol : 'unknown';
      if (!isImageProviderProtocol(body?.protocol) || !imageProviderResultTarget(body?.base_url, body?.source)) {
        return sendError(response, 400, 'invalid_image_provider_result', 'The image provider result is invalid.');
      }
      claim = claimAuthorizedImageProviderResult(body, sessionBinding);
      if (!claim) {
        return sendError(response, 403, 'image_provider_result_not_authorized', 'The image provider result is not authorized for this session.');
      }
      const grant = await materializeImageProviderResult(body, key, sessionBinding, lifecycle.signal);
      const responseClaim = claim;
      claim = null;
      let settled = false;
      const settleResponse = (consume) => {
        if (settled) return;
        settled = true;
        settleImageProviderResultClaim(responseClaim, consume);
        if (!consume) revokeTemporaryMediaGrant(grant.key, sessionBinding);
      };
      response.once('finish', () => settleResponse(true));
      response.once('close', () => {
        if (!response.writableFinished) settleResponse(false);
      });
      return sendJson(response, 201, grant);
    } catch (error) {
      settleImageProviderResultClaim(claim, error?.recoverable !== true);
      claim = null;
      if (error?.status === 429 && error?.code === 'temporary_media_capacity_exceeded') {
        return sendCapacityError(response, error.code, error.message);
      }
      if (error?.status === 429 && error?.code === 'image_provider_proxy_capacity_exceeded') {
        return sendCapacityError(response, error.code, error.message);
      }
      const code = error?.code === 'request_content_type_not_allowed'
        ? error.code
        : error?.code === 'invalid_provider_result'
          ? error.code
          : error?.status === 413 ? 'request_too_large' : 'image_provider_result_unavailable';
      const message = error?.code === 'request_content_type_not_allowed'
        ? 'The generation request must use application/json.'
        : error?.code === 'invalid_provider_result'
          ? 'The image provider result is invalid.'
          : error?.status === 413
            ? 'The generation request is too large.'
            : 'The image provider result is unavailable.';
      return sendError(response, error?.status || 502, code, message);
    } finally {
      lifecycle.release();
      releaseImageProviderProxySlot();
    }
  }
  if (parsed.pathname === '/api/generation/text' || parsed.pathname === '/api/generation/video') {
    audit.provider = parsed.pathname.endsWith('/text') ? 'text' : 'volcengine-seedance';
    if (!consumeRateLimit(source)) return sendCapacityError(response, 'rate_limited', 'Too many gateway requests.');
    if (request.method !== 'POST') return sendError(response, 405, 'method_not_allowed', 'The gateway operation is not allowed.');
    const key = bearer(request);
    if (!key) return sendError(response, 401, 'api_key_required', 'An ephemeral provider key is required.');
    const lifecycle = requestLifecycle(request, response);
    try {
      const body = await readBody(request);
      const outcome = parsed.pathname.endsWith('/text')
        ? await proxyText(body, key, sessionBinding, lifecycle.signal)
        : await proxyVideo(body, key, sessionBinding, lifecycle.signal);
      return sendJson(response, outcome.status, outcome.value);
    } catch (error) {
      const status = error?.status || 500;
      return sendError(
        response,
        status,
        status === 413 ? 'request_too_large' : 'gateway_error',
        status === 413 ? 'The generation request is too large.' : 'Gateway request failed.',
      );
    } finally {
      lifecycle.release();
    }
  }
  const mediaMatch = parsed.pathname.match(/^\/api\/generation\/media(?:\/([^/]+))?$/);
  if (mediaMatch) {
    audit.provider = 'media';
    if (!consumeRateLimit(source)) {
      return sendCapacityError(response, 'rate_limited', 'Too many gateway requests.');
    }
    const [, mediaKey] = mediaMatch;
    if (request.method === 'GET' && mediaKey) {
      const media = temporaryMedia.get(mediaKey);
      const grant = parsed.searchParams.get('grant');
      const providerId = parsed.searchParams.get('provider');
      if (!media || media.grant !== grant || media.providerId !== providerId) {
        return sendError(response, 404, 'temporary_media_not_found', 'The temporary media is not available.');
      }
      const lifecycle = requestLifecycle(request, response);
      try {
        return await sendTemporaryMedia(response, media, lifecycle.signal);
      } finally {
        lifecycle.release();
      }
    }
    if (request.method === 'DELETE' && mediaKey) {
      const media = temporaryMedia.get(mediaKey);
      if (!media || media.sessionBinding !== sessionBinding) {
        return sendError(response, 404, 'temporary_media_not_found', 'The temporary media is not available.');
      }
      if (media.referenceCount > 0) {
        media.releaseRequested = true;
      } else {
        temporaryMedia.delete(mediaKey);
        if (media.tosObjectKey) await tosMediaStore.release(media.tosObjectKey).catch(() => undefined);
      }
      response.luminaBytes = 0;
      response.writeHead(204, { 'cache-control': 'no-store' });
      return response.end();
    }
    if (request.method !== 'POST' || mediaKey) {
      return sendError(response, 405, 'method_not_allowed', 'The media gateway operation is not allowed.');
    }
    const usesImageProviderCapacity = request.headers['x-lumina-media-provider'] === 'fal-reference';
    if (usesImageProviderCapacity && !acquireImageProviderProxySlot()) {
      return sendCapacityError(response, 'image_provider_proxy_capacity_exceeded', 'The image provider proxy is at capacity.');
    }
    const lifecycle = requestLifecycle(request, response);
    try {
      return await handleMediaUpload(request, response, sessionBinding, lifecycle.signal);
    } catch (error) {
      if (error?.status === 429 && error?.code === 'image_provider_proxy_capacity_exceeded') {
        return sendCapacityError(response, error.code, error.message);
      }
      if (error?.status === 429 && error?.code === 'temporary_media_capacity_exceeded') {
        return sendCapacityError(response, error.code, error.message);
      }
      return sendError(response, error.status || 500, error.status === 413 ? 'media_too_large' : 'media_gateway_error', error.status ? error.message : 'Gateway media request failed.');
    } finally {
      lifecycle.release();
      if (usesImageProviderCapacity) releaseImageProviderProxySlot();
    }
  }
  if (parsed.pathname === '/api/generation/providers/custom') {
    audit.provider = 'custom';
    if (!consumeRateLimit(source)) return sendCapacityError(response, 'rate_limited', 'Too many gateway requests.');
    if (request.method !== 'POST') return sendError(response, 405, 'method_not_allowed', 'Custom provider registration only supports POST.');
    const key = bearer(request);
    if (!key) return sendError(response, 401, 'api_key_required', 'An ephemeral provider key is required.');
    try {
      const body = await readBody(request);
      if (body?.operation !== 'register') {
        return sendError(response, 400, 'operation_not_allowed', 'Only custom provider registration is allowed on this route.');
      }
      const provider = registerCustomImageProvider(body.provider, sessionBinding);
      if (!provider) {
        return sendError(response, 400, 'invalid_custom_provider', 'The custom OpenAI-compatible provider configuration is invalid.');
      }
      audit.provider = provider.id;
      response.luminaBytes = 0;
      response.writeHead(204, { 'cache-control': 'no-store' });
      return response.end();
    } catch (error) {
      const code = error?.code === 'request_content_type_not_allowed'
        ? error.code
        : error?.status === 413 ? 'request_too_large' : 'gateway_error';
      const message = error?.code === 'request_content_type_not_allowed'
        ? 'The generation request must use application/json.'
        : error?.status === 413 ? 'The generation request is too large.' : 'Gateway request failed.';
      return sendError(response, error?.status || 500, code, message);
    }
  }
  if (parsed.pathname === '/api/generation/providers/models') {
    const provider = configuredImageProvider(parsed.searchParams.get('provider'), sessionBinding);
    audit.provider = provider?.id ?? 'unknown';
    if (!consumeRateLimit(source)) return sendCapacityError(response, 'rate_limited', 'Too many gateway requests.');
    if (request.method !== 'GET') return sendError(response, 405, 'method_not_allowed', 'The model discovery operation only supports GET.');
    const key = bearer(request);
    if (!key) return sendError(response, 401, 'api_key_required', 'An ephemeral provider key is required.');
    if (!provider || provider.protocol !== 'openai-images') {
      return sendError(response, 404, 'provider_not_registered', 'The custom image provider is not registered for this session.');
    }
    const lifecycle = requestLifecycle(request, response);
    try {
      const outcome = await listProviderModels(provider, key, lifecycle.signal);
      return sendJson(response, outcome.status, outcome.value);
    } catch {
      return sendError(response, 502, 'provider_unavailable', 'The image provider is unavailable.');
    } finally {
      lifecycle.release();
    }
  }
  const providerModelsMatch = parsed.pathname.match(/^\/api\/generation\/providers\/(chaomo)\/models$/);
  if (providerModelsMatch) {
    const provider = configuredImageProvider(providerModelsMatch[1]);
    audit.provider = provider?.id ?? 'unknown';
    if (!consumeRateLimit(source)) return sendCapacityError(response, 'rate_limited', 'Too many gateway requests.');
    if (request.method !== 'GET') return sendError(response, 405, 'method_not_allowed', 'The model discovery operation only supports GET.');
    const key = bearer(request);
    if (!key) return sendError(response, 401, 'api_key_required', 'An ephemeral provider key is required.');
    if (!provider) return sendError(response, 503, 'provider_unavailable', 'The image provider is unavailable.');
    const lifecycle = requestLifecycle(request, response);
    try {
      const outcome = await listProviderModels(provider, key, lifecycle.signal);
      return sendJson(response, outcome.status, outcome.value);
    } catch {
      return sendError(response, 502, 'provider_unavailable', 'The image provider is unavailable.');
    } finally {
      lifecycle.release();
    }
  }
  const match = parsed.pathname.match(/^\/api\/generation\/jobs(?:\/([^/]+)(?:\/(result)(?:\/(confirmed))?)?)?$/);
  if (!match) return sendError(response, 404, 'not_found', 'Gateway route not found.');
  if (!consumeRateLimit(source)) return sendCapacityError(response, 'rate_limited', 'Too many gateway requests.');
  const key = bearer(request);
  const [, taskId, result, confirmed] = match;
  if (request.method === 'POST' && result === 'result' && confirmed === 'confirmed') {
    const task = tasks.get(taskId);
    if (task?.sessionBinding !== sessionBinding || !taskState.hasResult(taskId)) {
      return sendError(response, 404, 'result_not_found', 'The generation result is not available.');
    }
    task.resultConfirmedAt ??= Date.now();
    saveTasks();
    audit.provider = task.provider;
    response.luminaBytes = 0;
    response.writeHead(204, { 'cache-control': 'no-store' });
    return response.end();
  }
  if (request.method === 'GET' && result === 'result') {
    const task = tasks.get(taskId);
    if (task?.sessionBinding !== sessionBinding) {
      return sendError(response, 404, 'result_not_found', 'The generation result is not available.');
    }
    const lifecycle = requestLifecycle(request, response);
    const opened = taskState.openResult(taskId, lifecycle.signal);
    if (!opened) {
      lifecycle.release();
      return sendError(response, 404, 'result_not_found', 'The generation result is not available.');
    }
    audit.provider = task.provider;
    response.luminaBytes = 0;
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': task.contentType || 'application/octet-stream',
      'content-length': opened.size,
    });
    try {
      for await (const chunk of opened.stream) {
        const bytes = Buffer.from(chunk);
        response.luminaBytes += bytes.length;
        if (!response.write(bytes)) await waitForResponseDrain(response, lifecycle.signal);
      }
      return response.end();
    } catch {
      if (!response.destroyed) response.destroy();
      return undefined;
    } finally {
      lifecycle.release();
    }
  }
  if (!key) return sendError(response, 401, 'api_key_required', 'An ephemeral provider key is required.');
  if (request.method !== 'POST') return sendError(response, 405, 'method_not_allowed', 'The gateway operation is not allowed.');
  try {
    const body = await readBody(request);
    if (taskId) {
      audit.provider = tasks.get(taskId)?.provider ?? 'unknown';
    } else if (configuredImageProvider(body?.provider, sessionBinding)) {
      audit.provider = body.provider;
    }
    if (taskId && (!tasks.has(taskId) || tasks.get(taskId).sessionBinding !== sessionBinding)) {
      const task = tasks.get(taskId);
      return sendError(response, task?.sessionBinding ? 403 : 404,
        task?.sessionBinding ? 'session_source_mismatch' : 'job_not_found',
        task?.sessionBinding ? 'The generation session does not match this source.' : 'The generation job was not found.');
    }
    if (taskId && !['poll', 'requery'].includes(body?.operation)) {
      return sendError(response, 400, 'operation_not_allowed', 'Only poll and explicit requery operations are allowed for a generation job.');
    }
    if (!taskId && !generationTaskQueue.canEnqueue(source)) {
      return sendCapacityError(response, 'queue_capacity_exceeded', 'The generation task queue is full.');
    }
    let outcome;
    if (taskId) {
      const lifecycle = requestLifecycle(request, response);
      try {
        outcome = await poll(tasks.get(taskId), key, body.operation === 'requery', lifecycle.signal);
      } finally {
        lifecycle.release();
      }
    } else {
      outcome = await submit(body, key, source, sessionBinding);
    }
    if (outcome.status === 429 && outcome.value?.error === 'queue_capacity_exceeded') {
      return sendCapacityError(response, outcome.value.error, outcome.value.message);
    }
    return sendJson(response, outcome.status, outcome.value);
  } catch (error) {
    const code = error?.code === 'request_content_type_not_allowed'
      ? error.code
      : error?.status === 413 ? 'request_too_large' : 'gateway_error';
    const message = error?.code === 'request_content_type_not_allowed'
      ? 'The generation request must use application/json.'
      : error?.status === 413 ? 'The generation request is too large.' : 'Gateway request failed.';
    return sendError(response, error?.status || 500, code, message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : PORT;
  process.send?.({ type: 'lumina.gateway.ready', port });
  process.stdout.write(`Lumina GenerationGateway listening on ${port}\n`);
});
