/* global Blob, Buffer, FormData, URL, fetch, process */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = Number(process.env.LUMINA_GATEWAY_PORT ?? 8787);
const ORIGIN = process.env.LUMINA_GATEWAY_ORIGIN ?? '';
const UPSTREAM_BASE_URL = process.env.LUMINA_GATEWAY_AI_MEDIA_BASE_URL ?? 'https://api.ai-media.vip/v1';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_COUNT = 10;
const MODEL_ID = 'ai-media/gpt-image-2';
const MAX_ACTIVE_TASK_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESULT_CONFIRMATION_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;
const MAX_CONCURRENT_TASKS_PER_SOURCE = 2;
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const STATE_FILE = process.env.LUMINA_GATEWAY_STATE_FILE ?? join(tmpdir(), 'lumina-generation-gateway-tasks.json');
const MEDIA_TRANSCODER_URL = process.env.LUMINA_GATEWAY_MEDIA_TRANSCODER_URL ?? '';
const MAX_MEDIA_BYTES = Number(process.env.LUMINA_GATEWAY_MAX_MEDIA_BYTES ?? 64 * 1024 * 1024);
const MEDIA_TTL_MS = Number(process.env.LUMINA_GATEWAY_MEDIA_TTL_MS ?? 24 * 60 * 60 * 1000);
const MEDIA_PROVIDER_IDS = new Set((process.env.LUMINA_GATEWAY_MEDIA_PROVIDER_IDS ?? 'volcengine-seedance')
  .split(',').map((providerId) => providerId.trim()).filter(Boolean));
const rateLimits = new Map();
const temporaryMedia = new Map();

const MEDIA_MIME_TYPES = {
  image: new Set(['image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']),
  audio: new Set(['audio/aac', 'audio/flac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/x-wav']),
  video: new Set(['video/avi', 'video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm', 'video/x-matroska']),
};

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

function loadTasks() {
  if (!existsSync(STATE_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((task) => (
      task && typeof task.id === 'string' && typeof task.status === 'string'
      && (task.status === 'queued' || task.status === 'running' || task.status === 'succeeded' || task.status === 'failed')
    )) : [];
  } catch { return []; }
}

const tasks = new Map(loadTasks().map((task) => [task.id, task]));

function saveTasks() {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const persisted = [...tasks.values()].map((task) => {
      const { bytes: _bytes, ...snapshot } = task;
      return snapshot;
    });
    const temporaryFile = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(temporaryFile, JSON.stringify(persisted), 'utf8');
    renameSync(temporaryFile, STATE_FILE);
  } catch { /* ephemeral task recovery remains best effort */ }
}

function requestSource(request, sessionId) {
  const sourceAddress = request.socket.remoteAddress ?? 'unknown';
  return `${sessionId}|${request.headers.origin ?? 'same-origin'}|${sourceAddress}`;
}

function requestSession(request) {
  const cookie = request.headers.cookie ?? '';
  const match = cookie.match(/(?:^|;\s*)lumina_session=([A-Za-z0-9-]{16,128})(?:;|$)/);
  return match?.[1] ?? randomUUID();
}

function setSessionCookie(response, sessionId) {
  response.setHeader(
    'set-cookie',
    `lumina_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/api/generation; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
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
  return [...tasks.values()].filter((task) => task.source === source && (task.status === 'queued' || task.status === 'running')).length;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendError(response, status, code, message) {
  sendJson(response, status, { error: code, message });
}

function bearer(request) {
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const key = header.slice(7).trim();
  return key && key.length <= 4096 ? key : null;
}

function validateOrigin(request) {
  if (!ORIGIN) return true;
  if (!CANONICAL_ORIGIN) return false;
  const origin = request.headers.origin;
  return !origin || origin === CANONICAL_ORIGIN;
}

function upstreamUrl(path) {
  const base = new URL(UPSTREAM_BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Invalid gateway upstream configuration.');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  return new URL(path.replace(/^\/+/, ''), base);
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
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

function sendMedia(response, media) {
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
    upstream = await fetch(target, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': mediaContentType(request),
        'x-lumina-media-kind': kind,
        'x-lumina-media-file-name': String(request.headers['x-lumina-media-file-name'] ?? ''),
      },
      body: bytes,
    });
  } catch {
    return sendError(response, 503, 'transcoder_unavailable', 'Gateway transcoding is temporarily unavailable.');
  }
  const expectedType = mediaOutputContentType(kind);
  const outputType = (upstream.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!upstream.ok || upstream.status >= 300 && upstream.status < 400 || outputType !== expectedType) {
    return sendError(response, 502, 'transcode_failed', 'Gateway transcoding did not return the required media format.');
  }
  const outputBytes = Buffer.from(await upstream.arrayBuffer());
  if (outputBytes.length === 0 || outputBytes.length > MAX_MEDIA_BYTES) {
    return sendError(response, 502, 'transcode_failed', 'Gateway transcoding returned an invalid media file.');
  }
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': expectedType,
    'content-length': outputBytes.length,
  });
  response.end(outputBytes);
}

async function handleMediaUpload(request, response, sessionId) {
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
    sessionId,
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

function upstreamMessage(payload, status) {
  const error = payload?.error;
  const message = error && typeof error === 'object' ? error.message : error;
  return typeof message === 'string' && message.trim()
    ? message.trim().slice(0, 500)
    : `Upstream image provider returned HTTP ${status}.`;
}

async function jsonResponse(response) {
  try { return await response.json(); } catch { return null; }
}

async function resultBytes(payload) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : payload;
  if (!item || typeof item !== 'object') return null;
  if (typeof item.b64_json === 'string') {
    const bytes = Buffer.from(item.b64_json, 'base64');
    return bytes.length <= MAX_RESULT_BYTES ? { bytes, contentType: 'image/png' } : null;
  }
  if (typeof item.url !== 'string') return null;
  let resultUrl;
  try { resultUrl = new URL(item.url); } catch { return null; }
  const allowedUrl = new URL(UPSTREAM_BASE_URL);
  if (resultUrl.origin !== allowedUrl.origin || resultUrl.protocol !== allowedUrl.protocol) return null;
  const result = await fetch(resultUrl, { redirect: 'manual' });
  if (!result.ok || result.status >= 300 && result.status < 400) return null;
  const bytes = Buffer.from(await result.arrayBuffer());
  return bytes.length <= MAX_RESULT_BYTES
    ? { bytes, contentType: result.headers.get('content-type') || 'application/octet-stream' }
    : null;
}

async function submit(body, key, source, sessionId) {
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
  const task = { id: `job-${randomUUID()}`, status: 'queued', source, sessionId, createdAt: Date.now(), updatedAt: Date.now() };
  tasks.set(task.id, task);
  saveTasks();
  let upstream;
  try {
    if (request.referenceImages?.length) {
      const form = new FormData();
      const bodyFields = {
        ...(request.extraParams && typeof request.extraParams === 'object' ? request.extraParams : {}),
        model: request.model,
        prompt: request.prompt,
        size: request.size,
        n: 1,
        response_format: 'b64_json',
        ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      };
      Object.entries(bodyFields).forEach(([name, value]) => form.append(name, String(value)));
      for (const [index, source] of request.referenceImages.entries()) {
        const match = source.match(/^data:([^;,]+)?;base64,(.*)$/s);
        if (!match) return { status: 400, value: { error: 'invalid_reference_image', message: 'Reference images must be data URLs.' } };
        const bytes = Buffer.from(match[2], 'base64');
        if (!bytes.length || bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
          return { status: 400, value: { error: 'invalid_reference_image', message: 'Reference image payload is invalid or too large.' } };
        }
        form.append('image', new Blob([bytes], { type: match[1] || 'image/png' }), `reference-${index + 1}.png`);
      }
      upstream = await fetch(upstreamUrl('images/edits'), {
        method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${key}` }, body: form,
      });
    } else {
      upstream = await fetch(upstreamUrl('images/generations'), {
        method: 'POST',
        redirect: 'manual',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(request.extraParams && typeof request.extraParams === 'object' ? request.extraParams : {}),
          model: request.model,
          prompt: request.prompt,
          size: request.size,
          ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
        }),
      });
    }
  } catch {
    task.status = 'failed';
    task.error = 'Unable to reach the configured image provider.';
    task.terminalAt = Date.now();
    task.updatedAt = Date.now();
    saveTasks();
    return { status: 202, value: { job_id: task.id, status: task.status, error: task.error } };
  }
  const payload = await jsonResponse(upstream);
  if (!upstream.ok) {
    task.status = 'failed';
    task.error = upstreamMessage(payload, upstream.status);
    task.terminalAt = Date.now();
  } else {
    const result = await resultBytes(payload).catch(() => null);
    if (result) {
      task.status = 'succeeded';
      task.bytes = result.bytes;
      task.contentType = result.contentType;
      task.resultAvailableAt = Date.now();
      task.terminalAt = task.resultAvailableAt;
    } else if (typeof payload?.id === 'string' && payload.id.trim()) {
      task.status = 'running';
      task.upstreamTaskId = payload.id.trim();
    } else {
      task.status = 'failed';
      task.error = 'The image provider returned no usable result.';
      task.terminalAt = Date.now();
    }
  }
  task.updatedAt = Date.now();
  saveTasks();
  return { status: 202, value: { job_id: task.id, status: task.status, ...(task.error ? { error: task.error } : {}) } };
}

async function poll(task, key) {
  if (task.status === 'succeeded') {
    return { status: 200, value: { job_id: task.id, status: task.status, result: `/api/generation/jobs/${task.id}/result` } };
  }
  if (task.status === 'failed') return { status: 200, value: { job_id: task.id, status: task.status, error: task.error } };
  if (!task.upstreamTaskId) return { status: 200, value: { job_id: task.id, status: task.status } };
  try {
    const upstream = await fetch(upstreamUrl(`images/generations/${encodeURIComponent(task.upstreamTaskId)}`), {
      redirect: 'manual', headers: { authorization: `Bearer ${key}` },
    });
    const payload = await jsonResponse(upstream);
    if (!upstream.ok) {
      task.status = 'failed'; task.error = upstreamMessage(payload, upstream.status);
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
    : { status: 200, value: { job_id: task.id, status: task.status, ...(task.error ? { error: task.error } : {}) } };
}

const server = createServer(async (request, response) => {
  const sessionId = requestSession(request);
  setSessionCookie(response, sessionId);
  const currentTime = Date.now();
  deleteExpiredTemporaryMedia(currentTime);
  for (const [taskId, task] of tasks) {
    const isTerminal = task.status === 'succeeded' || task.status === 'failed';
    const terminalAt = task.terminalAt ?? task.updatedAt;
    if ((!isTerminal && task.createdAt < currentTime - MAX_ACTIVE_TASK_AGE_MS)
      || (isTerminal && terminalAt < currentTime - TERMINAL_TASK_RETENTION_MS)) {
      tasks.delete(taskId);
      continue;
    }
    if (task.bytes) {
      const resultExpiresAt = task.resultFetchedAt
        ? task.resultFetchedAt + RESULT_CONFIRMATION_WINDOW_MS
        : (task.resultAvailableAt ?? terminalAt) + RESULT_RETENTION_MS;
      if (resultExpiresAt <= currentTime) delete task.bytes;
    }
  }
  saveTasks();
  if (!validateOrigin(request)) return sendError(response, 403, 'origin_not_allowed', 'The request origin is not allowed.');
  const parsed = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const mediaMatch = parsed.pathname.match(/^\/api\/generation\/media(?:\/([^/]+))?$/);
  if (mediaMatch) {
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
      if (!media || media.sessionId !== sessionId) {
        return sendError(response, 404, 'temporary_media_not_found', 'The temporary media is not available.');
      }
      temporaryMedia.delete(mediaKey);
      response.writeHead(204, { 'cache-control': 'no-store' });
      return response.end();
    }
    if (request.method !== 'POST' || mediaKey) {
      return sendError(response, 405, 'method_not_allowed', 'The media gateway operation is not allowed.');
    }
    const source = requestSource(request, sessionId);
    if (!consumeRateLimit(source)) {
      return sendError(response, 429, 'rate_limited', 'Too many gateway requests.');
    }
    try {
      return await handleMediaUpload(request, response, sessionId);
    } catch (error) {
      return sendError(response, error.status || 500, error.status === 413 ? 'media_too_large' : 'media_gateway_error', error.status ? error.message : 'Gateway media request failed.');
    }
  }
  const match = parsed.pathname.match(/^\/api\/generation\/jobs(?:\/([^/]+)(?:\/(result))?)?$/);
  if (!match) return sendError(response, 404, 'not_found', 'Gateway route not found.');
  const key = bearer(request);
  const [, taskId, result] = match;
  if (request.method === 'GET' && result === 'result') {
    const task = tasks.get(taskId);
    if (task?.sessionId !== sessionId || !task.bytes) return sendError(response, 404, 'result_not_found', 'The generation result is not available.');
    task.resultFetchedAt = Date.now();
    saveTasks();
    response.writeHead(200, { 'cache-control': 'no-store', 'content-type': task.contentType || 'application/octet-stream', 'content-length': task.bytes.length });
    return response.end(task.bytes);
  }
  if (!key) return sendError(response, 401, 'api_key_required', 'An ephemeral provider key is required.');
  if (request.method !== 'POST') return sendError(response, 405, 'method_not_allowed', 'The gateway operation is not allowed.');
  const source = requestSource(request, sessionId);
  if (!consumeRateLimit(source)) return sendError(response, 429, 'rate_limited', 'Too many gateway requests.');
  try {
    const body = await readBody(request);
    if (taskId && (!tasks.has(taskId) || tasks.get(taskId).sessionId !== sessionId)) return sendError(response, 404, 'job_not_found', 'The generation job was not found.');
    if (taskId && body?.operation !== 'poll') return sendError(response, 400, 'operation_not_allowed', 'Only the poll operation is allowed for a generation job.');
    if (!taskId && concurrentTaskCount(source) >= MAX_CONCURRENT_TASKS_PER_SOURCE) {
      return sendError(response, 429, 'concurrency_limited', 'Too many active generation tasks.');
    }
    const outcome = taskId ? await poll(tasks.get(taskId), key) : await submit(body, key, source, sessionId);
    return sendJson(response, outcome.status, outcome.value);
  } catch (error) {
    return sendError(response, error.status || 500, error.status === 413 ? 'request_too_large' : 'gateway_error', error.status ? error.message : 'Gateway request failed.');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Lumina GenerationGateway listening on http://127.0.0.1:${PORT}\n`);
});
