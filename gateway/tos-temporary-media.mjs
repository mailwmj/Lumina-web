/* global AbortController, Buffer, URL, clearTimeout, fetch, process, setTimeout */

import { createHash, createHmac, randomUUID } from 'node:crypto';

const ALGORITHM = 'TOS4-HMAC-SHA256';
const SERVICE = 'tos';
const TERMINATOR = 'request';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const DEFAULT_REGION = 'cn-beijing';
const DEFAULT_ENDPOINT = 'https://tos-cn-beijing.volces.com';
const DEFAULT_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 86400;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding);
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function encodePath(pathname) {
  return pathname.split('/').map((segment) => encodeRfc3986(segment)).join('/');
}

function queryString(query) {
  return Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&');
}

function timestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

function signingKey(secretKey, date, region) {
  const dateKey = hmac(secretKey, date, undefined);
  const regionKey = hmac(dateKey, region, undefined);
  const serviceKey = hmac(regionKey, SERVICE, undefined);
  return hmac(serviceKey, TERMINATOR, undefined);
}

function scope(date, region) {
  return `${date}/${region}/${SERVICE}/${TERMINATOR}`;
}

function canonicalRequest(method, pathname, query, headers, signedHeaders) {
  const canonicalHeaders = signedHeaders.map((name) => (
    `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}`
  )).join('\n');
  return [
    method,
    encodePath(pathname),
    queryString(query),
    `${canonicalHeaders}\n`,
    signedHeaders.join(';'),
    UNSIGNED_PAYLOAD,
  ].join('\n');
}

function signature({ method, pathname, query, headers, signedHeaders, dateTime, region, secretKey }) {
  const date = dateTime.slice(0, 8);
  const stringToSign = [
    ALGORITHM,
    dateTime,
    scope(date, region),
    sha256(canonicalRequest(method, pathname, query, headers, signedHeaders)),
  ].join('\n');
  return hmac(signingKey(secretKey, date, region), stringToSign, 'hex');
}

function normalizedEndpoint(value, allowInsecure) {
  try {
    const url = new URL(value || DEFAULT_ENDPOINT);
    if ((!allowInsecure && url.protocol !== 'https:')
      || (allowInsecure && !['http:', 'https:'].includes(url.protocol))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function configFromEnvironment(environment) {
  const values = {
    bucket: String(environment.LUMINA_TOS_BUCKET ?? '').trim(),
    accessKey: String(environment.LUMINA_TOS_ACCESS_KEY ?? '').trim(),
    secretKey: String(environment.LUMINA_TOS_SECRET_KEY ?? '').trim(),
  };
  const configuredCount = Object.values(values).filter(Boolean).length;
  if (configuredCount === 0) return null;
  if (configuredCount !== 3) throw new Error('TOS temporary media configuration is incomplete.');
  const region = String(environment.LUMINA_TOS_REGION ?? DEFAULT_REGION).trim();
  const allowInsecure = environment.NODE_ENV === 'test';
  const endpoint = normalizedEndpoint(environment.LUMINA_TOS_ENDPOINT, allowInsecure);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(values.bucket)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(region) || !endpoint) {
    throw new Error('TOS temporary media configuration is invalid.');
  }
  const rawTtlValue = String(environment.LUMINA_TOS_URL_TTL_SECONDS ?? '').trim();
  const rawTtl = rawTtlValue ? Number(rawTtlValue) : Number.NaN;
  const urlTtlSeconds = Number.isFinite(rawTtl)
    ? Math.max(60, Math.min(MAX_TTL_SECONDS, Math.floor(rawTtl)))
    : DEFAULT_TTL_SECONDS;
  return {
    ...values,
    endpoint,
    region,
    securityToken: String(environment.LUMINA_TOS_SECURITY_TOKEN ?? '').trim() || null,
    urlTtlSeconds,
    forcePathStyle: allowInsecure && environment.LUMINA_TOS_FORCE_PATH_STYLE === '1',
  };
}

function objectTarget(config, objectKey) {
  const path = `/${objectKey.split('/').map((segment) => encodeRfc3986(segment)).join('/')}`;
  if (config.forcePathStyle) {
    return new URL(`/${encodeRfc3986(config.bucket)}${path}`, config.endpoint);
  }
  const target = new URL(path, config.endpoint);
  target.hostname = `${config.bucket}.${target.hostname}`;
  return target;
}

function signedHeaders(config, target, method, now) {
  const dateTime = timestamp(now);
  const headers = {
    host: target.host,
    'x-tos-content-sha256': UNSIGNED_PAYLOAD,
    'x-tos-date': dateTime,
    ...(config.securityToken ? { 'x-tos-security-token': config.securityToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const value = signature({
    method,
    pathname: target.pathname,
    query: {},
    headers,
    signedHeaders: names,
    dateTime,
    region: config.region,
    secretKey: config.secretKey,
  });
  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${config.accessKey}/${scope(dateTime.slice(0, 8), config.region)}, SignedHeaders=${names.join(';')}, Signature=${value}`,
  };
}

export function createTosPresignedGetUrl(config, objectKey, now = new Date()) {
  const target = objectTarget(config, objectKey);
  const dateTime = timestamp(now);
  const signedHeaderNames = ['host'];
  const query = {
    'X-Tos-Algorithm': ALGORITHM,
    'X-Tos-Content-Sha256': UNSIGNED_PAYLOAD,
    'X-Tos-Credential': `${config.accessKey}/${scope(dateTime.slice(0, 8), config.region)}`,
    'X-Tos-Date': dateTime,
    'X-Tos-Expires': String(config.urlTtlSeconds),
    'X-Tos-SignedHeaders': signedHeaderNames.join(';'),
    ...(config.securityToken ? { 'X-Tos-Security-Token': config.securityToken } : {}),
  };
  query['X-Tos-Signature'] = signature({
    method: 'GET',
    pathname: target.pathname,
    query,
    headers: { host: target.host },
    signedHeaders: signedHeaderNames,
    dateTime,
    region: config.region,
    secretKey: config.secretKey,
  });
  target.search = queryString(query);
  return target.toString();
}

function extensionFor(contentType) {
  return {
    'image/avif': 'avif', 'image/bmp': 'bmp', 'image/gif': 'gif', 'image/jpeg': 'jpg',
    'image/png': 'png', 'image/webp': 'webp', 'audio/aac': 'aac', 'audio/flac': 'flac',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
    'audio/webm': 'webm', 'audio/x-wav': 'wav', 'video/avi': 'avi', 'video/mp4': 'mp4',
    'video/mpeg': 'mpeg', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  }[contentType] ?? 'bin';
}

function segment(value, fallback) {
  const normalized = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

export function createTosTemporaryMediaStore({
  environment = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
  createId = randomUUID,
  requestTimeoutMs = 5 * 60 * 1000,
} = {}) {
  const config = configFromEnvironment(environment);
  const request = async (method, objectKey, body, contentType, parentSignal) => {
    if (!config) throw new Error('TOS temporary media delivery is not configured.');
    const target = objectTarget(config, objectKey);
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timeout;
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    if (Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
      timeout = setTimeout(abort, requestTimeoutMs);
      timeout.unref?.();
    }
    let response;
    try {
      response = await fetchImpl(target, {
        method,
        redirect: 'manual',
        headers: {
          ...signedHeaders(config, target, method, now()),
          ...(contentType ? {
            'cache-control': 'private, max-age=0, no-cache',
            'content-type': contentType,
          } : {}),
        },
        ...(body ? { body } : {}),
        signal: controller.signal,
      });
    } catch {
      throw new Error('TOS temporary media request failed.');
    } finally {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abort);
    }
    if (method === 'DELETE' && response.status === 404) return;
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      throw new Error(`TOS temporary media request failed with HTTP ${response.status}.`);
    }
  };
  return {
    available: Boolean(config),
    async upload({ bytes, contentType, projectId, signal }) {
      if (!config) throw new Error('TOS temporary media delivery is not configured.');
      const objectKey = `lumina/${segment(projectId, 'unassigned')}/staging/${createId()}/input.${extensionFor(contentType)}`;
      const body = Buffer.isBuffer(bytes)
        ? bytes
        : bytes instanceof Uint8Array
          ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : Buffer.from(bytes);
      try {
        await request('PUT', objectKey, body, contentType, signal);
      } catch (error) {
        void request('DELETE', objectKey).catch(() => undefined);
        throw error;
      }
      const createdAt = now();
      return {
        objectKey,
        url: createTosPresignedGetUrl(config, objectKey, createdAt),
        expiresAt: createdAt.getTime() + config.urlTtlSeconds * 1000,
      };
    },
    async release(objectKey) {
      if (!config || !objectKey) return;
      await request('DELETE', objectKey);
    },
  };
}

export const __test = { configFromEnvironment, encodeRfc3986, queryString, signedHeaders };
