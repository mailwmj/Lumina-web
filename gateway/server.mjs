/* global Blob, Buffer, FormData, Headers, Response, URL, process, setInterval */

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createOutboundClient } from './outbound.mjs';
import { createGatewayLogger } from './operational-log.mjs';
import { createTaskStateStore, isSafeUpstreamTaskId } from './task-state.mjs';

const PORT = Number(process.env.LUMINA_GATEWAY_PORT ?? 8787);
const ORIGIN = process.env.LUMINA_GATEWAY_ORIGIN ?? '';
const UPSTREAM_BASE_URL = process.env.LUMINA_GATEWAY_AI_MEDIA_BASE_URL ?? 'https://api.ai-media.vip/v1';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_COUNT = 10;
const MODEL_ID = 'ai-media/gpt-image-2';
const UPSTREAM_MODEL_ID = 'gpt-image-2';

function boundedNumber(name, fallback, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), maximum) : fallback;
}

const RATE_LIMIT_WINDOW_MS = boundedNumber('LUMINA_GATEWAY_RATE_LIMIT_WINDOW_MS', 60 * 1000, 60 * 60 * 1000);
const MAX_REQUESTS_PER_WINDOW = boundedNumber('LUMINA_GATEWAY_MAX_REQUESTS_PER_WINDOW', 60, 10_000);
const MAX_CONCURRENT_TASKS_PER_SOURCE = boundedNumber('LUMINA_GATEWAY_MAX_CONCURRENT_TASKS_PER_SOURCE', 2, 100);
const MAX_ACTIVE_TASKS_PER_PROVIDER = boundedNumber('LUMINA_GATEWAY_MAX_ACTIVE_TASKS_PER_PROVIDER', 8, 1_000);
const MAX_ACTIVE_TASK_AGE_MS = boundedNumber('LUMINA_GATEWAY_ACTIVE_TASK_TTL_MS', 7 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const TERMINAL_TASK_RETENTION_MS = boundedNumber('LUMINA_GATEWAY_TERMINAL_TASK_TTL_MS', 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
const RESULT_RETENTION_MS = boundedNumber('LUMINA_GATEWAY_RESULT_TTL_MS', 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
const RESULT_CONFIRMATION_WINDOW_MS = boundedNumber('LUMINA_GATEWAY_RESULT_CONFIRMATION_TTL_MS', 60 * 60 * 1000, 60 * 60 * 1000);
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
const TRUST_PROXY = process.env.LUMINA_GATEWAY_TRUST_PROXY === '1';
const STATE_FILE = process.env.LUMINA_GATEWAY_STATE_FILE ?? join(tmpdir(), 'lumina-generation-gateway-tasks.json');
const LOG_FILE = process.env.LUMINA_GATEWAY_LOG_FILE ?? join(tmpdir(), 'lumina-generation-gateway.log.jsonl');
const MEDIA_TRANSCODER_URL = process.env.LUMINA_GATEWAY_MEDIA_TRANSCODER_URL ?? '';
const MAX_MEDIA_BYTES = boundedNumber('LUMINA_GATEWAY_MAX_MEDIA_BYTES', 64 * 1024 * 1024, 64 * 1024 * 1024);
const MEDIA_TTL_MS = boundedNumber('LUMINA_GATEWAY_MEDIA_TTL_MS', 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
const MEDIA_PROVIDER_IDS = new Set((process.env.LUMINA_GATEWAY_MEDIA_PROVIDER_IDS ?? 'volcengine-seedance')
  .split(',').map((providerId) => providerId.trim()).filter(Boolean));
const rateLimits = new Map();
const temporaryMedia = new Map();

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

const UPSTREAM_ORIGIN = configuredOutboundOrigin(UPSTREAM_BASE_URL);
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
  trustedHttpsSyntheticOrigins: UPSTREAM_ORIGIN ? [UPSTREAM_ORIGIN] : [],
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

function referenceImage(value) {
  const match = typeof value === 'string' && value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  const bytes = decodeBase64(match[2], MAX_REFERENCE_IMAGE_BYTES);
  return MEDIA_MIME_TYPES.image.has(contentType) && bytes ? { bytes, contentType } : null;
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
});
const tasks = taskState.tasks;

function saveTasks() {
  taskState.save();
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

function concurrentTaskCount(source) {
  return [...tasks.values()].filter((task) => task.sourceId === source && (task.status === 'queued' || task.status === 'running')).length;
}

function providerTaskCount(provider) {
  return [...tasks.values()].filter((task) => task.provider === provider && (task.status === 'queued' || task.status === 'running')).length;
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
  if (pathname.startsWith('/api/generation/media')) {
    if (request.method === 'GET') return 'media_retrieve';
    if (request.method === 'DELETE') return 'media_release';
    if (request.headers['x-lumina-media-operation'] === 'publish') return 'media_publish';
    if (request.headers['x-lumina-media-operation'] === 'transcode') return 'media_transcode';
    return 'unknown';
  }
  if (!pathname.startsWith('/api/generation/jobs')) return 'unknown';
  if (pathname.endsWith('/result/confirmed')) return 'result_confirm';
  if (pathname.endsWith('/result')) return 'result';
  return pathname === '/api/generation/jobs' ? 'submit' : 'poll';
}

function upstreamUrl(path) {
  const base = new URL(UPSTREAM_BASE_URL);
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

async function readBody(request) {
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
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 });
  }
}

async function readMediaBody(request) {
  const declaredLength = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) {
    throw Object.assign(new Error('media is too large'), { status: 413 });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    request.luminaBytes = length;
    if (length > MAX_MEDIA_BYTES) {
      throw Object.assign(new Error('media is too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (length === 0) {
    throw Object.assign(new Error('media is empty'), { status: 400 });
  }
  return Buffer.concat(chunks);
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
      temporaryMedia.delete(key);
    }
  }
}

function deleteExpiredRateLimits(currentTime = Date.now()) {
  for (const [source, entry] of rateLimits) {
    if (currentTime - entry.startedAt >= RATE_LIMIT_WINDOW_MS) {
      rateLimits.delete(source);
    }
  }
}

function cleanupExpiredState(currentTime = Date.now()) {
  deleteExpiredTemporaryMedia(currentTime);
  deleteExpiredRateLimits(currentTime);
  if (taskState.prune(currentTime)) saveTasks();
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

async function transcodeMedia(request, response, kind, bytes) {
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
      if (!response.write(output)) await once(response, 'drain');
    }
    response.end();
  } catch {
    response.destroy();
  }
}

async function handleMediaUpload(request, response, sessionBinding) {
  const operation = request.headers['x-lumina-media-operation'];
  const kind = mediaKind(request);
  const contentType = mediaContentType(request);
  if ((operation !== 'publish' && operation !== 'transcode') || !kind) {
    return sendError(response, 400, 'invalid_media_request', 'The media gateway request is invalid.');
  }
  if (!isAllowedMediaType(kind, contentType)) {
    return sendError(response, 415, 'media_type_not_allowed', 'The media type is not supported by the gateway.');
  }
  if (operation === 'publish' && !CANONICAL_ORIGIN) {
    return sendError(response, 503, 'gateway_origin_unconfigured', 'The gateway canonical Origin is not configured.');
  }
  const bytes = await readMediaBody(request);
  if (operation === 'transcode') {
    return await transcodeMedia(request, response, kind, bytes);
  }
  const providerId = String(request.headers['x-lumina-media-provider'] ?? '').trim();
  if (!MEDIA_PROVIDER_IDS.has(providerId)) {
    return sendError(response, 400, 'provider_not_allowed', 'The media provider is not enabled for this gateway.');
  }
  const key = `media-${randomUUID()}`;
  const grant = randomUUID();
  const expiresAt = Date.now() + MEDIA_TTL_MS;
  temporaryMedia.set(key, {
    bytes,
    contentType,
    providerId,
    grant,
    expiresAt,
    sessionBinding,
  });
  const url = `${mediaOrigin()}/api/generation/media/${encodeURIComponent(key)}?grant=${encodeURIComponent(grant)}&provider=${encodeURIComponent(providerId)}`;
  return sendJson(response, 201, {
    key,
    url,
    expiresAt,
    contentType,
    sizeBytes: bytes.length,
  });
}

function taskError(task) {
  if (task.errorCode === 'provider_unavailable') return 'Unable to reach the configured image provider.';
  if (task.errorCode === 'provider_rejected') return 'The image provider rejected the generation request.';
  if (task.errorCode === 'invalid_provider_result') return 'The image provider returned no usable result.';
  return 'Generation failed.';
}

function taskErrorDetails(task) {
  return Number.isInteger(task.providerHttpStatus)
    ? `Provider request failed with HTTP ${task.providerHttpStatus}.`
    : null;
}

function taskFailure(task) {
  const details = taskErrorDetails(task);
  return { error: taskError(task), ...(details ? { error_details: details } : {}) };
}

async function jsonResponse(response) {
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType.endsWith('+json')) return null;
  try { return await response.json(); } catch { return null; }
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
  return providerRecords(payload).flatMap((record) => (
    Array.isArray(record.data) ? record.data
      : Array.isArray(record.images) ? record.images
        : Array.isArray(record.results) ? record.results
          : [record]
  )).filter((item) => item && typeof item === 'object' && !Array.isArray(item));
}

function upstreamTaskId(payload) {
  for (const record of providerRecords(payload, ['data'])) {
    for (const key of ['request_id', 'requestId', 'task_id', 'taskId', 'id']) {
      const value = typeof record[key] === 'string' ? record[key].trim() : '';
      if (isSafeUpstreamTaskId(value)) return value;
    }
  }
  return null;
}

async function resultUrlBytes(value) {
  let resultUrl;
  try { resultUrl = new URL(value); } catch { return null; }
  const allowedUrl = new URL(UPSTREAM_BASE_URL);
  if (resultUrl.origin !== allowedUrl.origin || resultUrl.protocol !== allowedUrl.protocol) return null;
  const result = await outbound.fetch(resultUrl, {
    allowedOrigin: allowedUrl.origin,
    maxResponseBytes: MAX_RESULT_BYTES,
  });
  if (!result.ok || result.status >= 300 && result.status < 400) return null;
  const bytes = Buffer.from(await result.arrayBuffer());
  const contentType = (result.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  return bytes.length > 0 && bytes.length <= MAX_RESULT_BYTES && MEDIA_MIME_TYPES.image.has(contentType)
    ? { bytes, contentType }
    : null;
}

async function resultBytes(payload, depth = 0) {
  for (const item of resultItems(payload)) {
    const encoded = typeof item.b64_json === 'string' ? item.b64_json
      : typeof item.base64 === 'string' ? item.base64 : null;
    if (encoded) {
      const bytes = decodeBase64(encoded, MAX_RESULT_BYTES);
      if (bytes) return { bytes, contentType: 'image/png' };
    }
    const nestedImage = item.image && typeof item.image === 'object' && !Array.isArray(item.image)
      ? item.image : null;
    const url = typeof item.url === 'string' ? item.url
      : typeof item.signed_url === 'string' ? item.signed_url
        : typeof nestedImage?.url === 'string' ? nestedImage.url : null;
    if (url) {
      const result = await resultUrlBytes(url);
      if (result) return result;
    }
    if (depth === 0 && typeof item.resultJson === 'string') {
      try {
        const result = await resultBytes(JSON.parse(item.resultJson), depth + 1);
        if (result) return result;
      } catch { /* malformed nested result is not usable */ }
    }
  }
  return null;
}

async function submit(body, key, sourceId, sessionBinding) {
  if (body.provider !== 'ai-media' || body.operation !== 'submit') {
    return { status: 400, value: { error: 'provider_or_operation_not_allowed', message: 'Only the configured provider and submit operation are allowed.' } };
  }
  if (typeof body.projectId !== 'string' || !body.projectId.trim() || typeof body.projectRevision !== 'string' || !body.projectRevision.trim()) {
    return { status: 400, value: { error: 'project_context_required', message: 'An active project and revision are required.' } };
  }
  const request = body.request;
  if (!request || typeof request !== 'object' || request.model !== MODEL_ID || typeof request.prompt !== 'string' || !request.prompt.trim() || typeof request.size !== 'string') {
    return { status: 400, value: { error: 'invalid_generation_request', message: 'The image generation request is invalid.' } };
  }
  if (request.referenceImages !== undefined && (!Array.isArray(request.referenceImages)
    || request.referenceImages.length > MAX_REFERENCE_IMAGE_COUNT
    || request.referenceImages.some((source) => typeof source !== 'string' || source.length > MAX_REFERENCE_IMAGE_BYTES * 2))) {
    return { status: 400, value: { error: 'invalid_generation_request', message: 'The image generation request is invalid.' } };
  }
  const references = request.referenceImages?.map(referenceImage);
  if (references?.some((reference) => !reference)) {
    return { status: 400, value: { error: 'invalid_generation_request', message: 'The image generation request is invalid.' } };
  }
  const task = {
    id: `job-${randomUUID()}`,
    provider: 'ai-media',
    status: 'queued',
    sourceId,
    sessionBinding,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  tasks.set(task.id, task);
  saveTasks();
  let upstream;
  try {
    if (request.referenceImages?.length) {
      const form = new FormData();
      const bodyFields = aiMediaRequestFields(request);
      Object.entries(bodyFields).forEach(([name, value]) => form.append(name, String(value)));
      for (const [index, reference] of references.entries()) {
        form.append('image', new Blob([reference.bytes], { type: reference.contentType }), `reference-${index + 1}.png`);
      }
      upstream = await outbound.fetch(upstreamUrl('images/edits'), {
        allowedOrigin: UPSTREAM_ORIGIN,
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
        maxRequestBytes: MAX_BODY_BYTES,
        maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
      });
    } else {
      upstream = await outbound.fetch(upstreamUrl('images/generations'), {
        allowedOrigin: UPSTREAM_ORIGIN,
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(aiMediaRequestFields(request)),
        maxRequestBytes: MAX_BODY_BYTES,
        maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
      });
    }
  } catch {
    task.status = 'failed';
    task.errorCode = 'provider_unavailable';
    task.terminalAt = Date.now();
    task.updatedAt = Date.now();
    saveTasks();
    return { status: 202, value: { job_id: task.id, status: task.status, ...taskFailure(task) } };
  }
  const payload = await jsonResponse(upstream);
  const taskId = upstreamTaskId(payload);
  if (!upstream.ok) {
    task.status = 'failed';
    task.errorCode = 'provider_rejected';
    task.providerHttpStatus = upstream.status;
    task.terminalAt = Date.now();
  } else {
    const result = await resultBytes(payload).catch(() => null);
    if (result) {
      task.status = 'succeeded';
      task.bytes = result.bytes;
      task.contentType = result.contentType;
      task.resultAvailableAt = Date.now();
      task.terminalAt = task.resultAvailableAt;
    } else if (taskId) {
      task.status = 'running';
      task.upstreamTaskId = taskId;
    } else {
      task.status = 'failed';
      task.errorCode = 'invalid_provider_result';
      task.terminalAt = Date.now();
    }
  }
  task.updatedAt = Date.now();
  saveTasks();
  return {
    status: 202,
    value: { job_id: task.id, status: task.status, ...(task.status === 'failed' ? taskFailure(task) : {}) },
  };
}

async function poll(task, key) {
  if (task.status === 'succeeded') {
    return { status: 200, value: { job_id: task.id, status: task.status, result: `/api/generation/jobs/${task.id}/result` } };
  }
  if (task.status === 'failed') return { status: 200, value: { job_id: task.id, status: task.status, ...taskFailure(task) } };
  if (!task.upstreamTaskId) return { status: 200, value: { job_id: task.id, status: task.status } };
  try {
    const upstream = await outbound.fetch(upstreamUrl(`images/generations/${encodeURIComponent(task.upstreamTaskId)}`), {
      allowedOrigin: UPSTREAM_ORIGIN,
      headers: { authorization: `Bearer ${key}` },
      maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
    });
    const payload = await jsonResponse(upstream);
    if (!upstream.ok) {
      task.status = 'failed'; task.errorCode = 'provider_rejected';
      task.providerHttpStatus = upstream.status;
      task.terminalAt = Date.now();
    } else {
      const result = await resultBytes(payload).catch(() => null);
      if (result) {
        task.status = 'succeeded'; task.bytes = result.bytes; task.contentType = result.contentType;
        task.resultAvailableAt = Date.now();
        task.terminalAt = task.resultAvailableAt;
      }
    }
  } catch { /* retain running state for a later poll */ }
  task.updatedAt = Date.now();
  saveTasks();
  return task.status === 'succeeded'
    ? { status: 200, value: { job_id: task.id, status: task.status, result: `/api/generation/jobs/${task.id}/result` } }
    : {
      status: 200,
      value: { job_id: task.id, status: task.status, ...(task.status === 'failed' ? taskFailure(task) : {}) },
    };
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
      provider: audit.provider,
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
      return sendMedia(response, media);
    }
    if (request.method === 'DELETE' && mediaKey) {
      const media = temporaryMedia.get(mediaKey);
      if (!media || media.sessionBinding !== sessionBinding) {
        return sendError(response, 404, 'temporary_media_not_found', 'The temporary media is not available.');
      }
      temporaryMedia.delete(mediaKey);
      response.luminaBytes = 0;
      response.writeHead(204, { 'cache-control': 'no-store' });
      return response.end();
    }
    if (request.method !== 'POST' || mediaKey) {
      return sendError(response, 405, 'method_not_allowed', 'The media gateway operation is not allowed.');
    }
    try {
      return await handleMediaUpload(request, response, sessionBinding);
    } catch (error) {
      return sendError(response, error.status || 500, error.status === 413 ? 'media_too_large' : 'media_gateway_error', error.status ? error.message : 'Gateway media request failed.');
    }
  }
  const match = parsed.pathname.match(/^\/api\/generation\/jobs(?:\/([^/]+)(?:\/(result)(?:\/(confirmed))?)?)?$/);
  if (!match) return sendError(response, 404, 'not_found', 'Gateway route not found.');
  if (!consumeRateLimit(source)) return sendCapacityError(response, 'rate_limited', 'Too many gateway requests.');
  const key = bearer(request);
  const [, taskId, result, confirmed] = match;
  if (request.method === 'POST' && result === 'result' && confirmed === 'confirmed') {
    const task = tasks.get(taskId);
    if (task?.sessionBinding !== sessionBinding || !task.bytes) {
      return sendError(response, 404, 'result_not_found', 'The generation result is not available.');
    }
    task.resultConfirmedAt ??= Date.now();
    saveTasks();
    audit.provider = 'ai-media';
    response.luminaBytes = 0;
    response.writeHead(204, { 'cache-control': 'no-store' });
    return response.end();
  }
  if (request.method === 'GET' && result === 'result') {
    const task = tasks.get(taskId);
    if (task?.sessionBinding !== sessionBinding || !task.bytes) return sendError(response, 404, 'result_not_found', 'The generation result is not available.');
    audit.provider = 'ai-media';
    response.luminaBytes = task.bytes.length;
    response.writeHead(200, { 'cache-control': 'no-store', 'content-type': task.contentType || 'application/octet-stream', 'content-length': task.bytes.length });
    return response.end(task.bytes);
  }
  if (!key) return sendError(response, 401, 'api_key_required', 'An ephemeral provider key is required.');
  if (request.method !== 'POST') return sendError(response, 405, 'method_not_allowed', 'The gateway operation is not allowed.');
  try {
    const body = await readBody(request);
    if (taskId || body?.provider === 'ai-media') audit.provider = 'ai-media';
    if (taskId && (!tasks.has(taskId) || tasks.get(taskId).sessionBinding !== sessionBinding)) {
      const task = tasks.get(taskId);
      return sendError(response, task?.sessionBinding ? 403 : 404,
        task?.sessionBinding ? 'session_source_mismatch' : 'job_not_found',
        task?.sessionBinding ? 'The generation session does not match this source.' : 'The generation job was not found.');
    }
    if (taskId && body?.operation !== 'poll') return sendError(response, 400, 'operation_not_allowed', 'Only the poll operation is allowed for a generation job.');
    if (!taskId && concurrentTaskCount(source) >= MAX_CONCURRENT_TASKS_PER_SOURCE) {
      return sendCapacityError(response, 'concurrency_limited', 'Too many active generation tasks.');
    }
    if (!taskId && body?.provider === 'ai-media' && providerTaskCount('ai-media') >= MAX_ACTIVE_TASKS_PER_PROVIDER) {
      return sendCapacityError(response, 'provider_quota_exceeded', 'The provider active-task quota is exhausted.');
    }
    const outcome = taskId ? await poll(tasks.get(taskId), key) : await submit(body, key, source, sessionBinding);
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
