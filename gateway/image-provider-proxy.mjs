/* global Buffer, URL */

const IMAGE_PROTOCOLS = new Set([
  'openai-images',
  'fhl-images',
  'gemini-native',
  'fal',
  'grsai',
  'kie',
  'runninghub',
  'bltcy',
  'ppio',
]);

function decodedHeader(value, maximumLength = 4096) {
  if (typeof value !== 'string' || !value || value.length > maximumLength * 3) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length <= maximumLength ? decoded : null;
  } catch {
    return null;
  }
}

function safeUrl(value, allowQuery) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
      || (!allowQuery && url.search)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function relativePath(base, target) {
  if (target.origin !== base.origin) return null;
  const prefix = base.pathname.replace(/\/+$/, '');
  if (target.pathname === prefix) return '/';
  if (!target.pathname.startsWith(`${prefix}/`)) return null;
  return target.pathname.slice(prefix.length);
}

const SAFE_PATH_SEGMENT = '[A-Za-z0-9._~-]{1,256}';

function safeGetTarget(protocol, base, target) {
  if (target.origin !== base.origin) return false;
  if ([...target.searchParams.keys()].some((name) => /token|secret|key|sign|auth/i.test(name))) return false;
  if (protocol === 'kie' && relativePath(base, target) === '/api/v1/jobs/recordInfo') {
    return target.pathname.endsWith('/api/v1/jobs/recordInfo')
      && target.searchParams.has('taskId')
      && [...target.searchParams.keys()].every((name) => name === 'taskId')
      && new RegExp(`^${SAFE_PATH_SEGMENT}$`).test(target.searchParams.get('taskId') ?? '');
  }
  if (target.search) return false;
  const path = relativePath(base, target);
  if (protocol === 'gemini-native') {
    const fallbackModelsPath = `${base.pathname.replace(/\/v1beta\/?$/, '')}/v1/models`.replace(/^\/\//, '/');
    return path === '/models'
      || target.pathname === fallbackModelsPath
      || (path !== null && new RegExp(`^/tasks/${SAFE_PATH_SEGMENT}$`).test(path));
  }
  if (path === null) return false;
  if (protocol === 'openai-images' || protocol === 'fhl-images') {
    return path === '/models'
      || new RegExp(`^/images/generations/${SAFE_PATH_SEGMENT}$`).test(path)
      || new RegExp(`^/tasks/${SAFE_PATH_SEGMENT}$`).test(path);
  }
  if (protocol === 'fal') {
    return new RegExp(`^/fal-ai/nano-banana-(?:2|pro)/requests/${SAFE_PATH_SEGMENT}(?:/status)?$`).test(path)
      || new RegExp(`^/tasks/${SAFE_PATH_SEGMENT}$`).test(path);
  }
  return false;
}

function safePostTarget(protocol, base, target) {
  const sameOrigin = target.origin === base.origin;
  if (protocol === 'kie' && base.origin === 'https://api.kie.ai'
    && target.origin === 'https://kieai.redpandaai.co') {
    return !target.search && target.pathname === '/api/file-stream-upload';
  }
  if (!sameOrigin || target.search) return false;
  const path = relativePath(base, target);
  if (path === null) return false;
  if (protocol === 'openai-images' || protocol === 'fhl-images') {
    return path === '/images/generations' || path === '/images/edits';
  }
  if (protocol === 'gemini-native') {
    return /^\/models\/[A-Za-z0-9._~-]{1,256}:generateContent$/.test(path);
  }
  if (protocol === 'fal') {
    return /^\/fal-ai\/nano-banana-(?:2|pro)(?:\/edit)?$/.test(path);
  }
  if (protocol === 'grsai') {
    return path === '/v1/draw/nano-banana' || path === '/v1/draw/result';
  }
  if (protocol === 'kie') {
    return path === '/api/v1/jobs/createTask';
  }
  if (protocol === 'runninghub') {
    return path === '/media/upload/binary' || path === '/query'
      || new RegExp(`^/${SAFE_PATH_SEGMENT}/(?:edit|image-to-image)$`).test(path);
  }
  if (protocol === 'bltcy') return path === '/v1/images/edits';
  if (protocol === 'ppio') {
    return /^\/v3\/gemini-3\.1-flash-image-(?:edit|text-to-image)$/.test(path);
  }
  return false;
}

export function imageProviderProxyRequest(headers) {
  const protocol = String(headers['x-lumina-image-protocol'] ?? '').trim();
  const method = String(headers['x-lumina-image-method'] ?? '').trim().toUpperCase();
  const baseValue = decodedHeader(headers['x-lumina-image-base-url']);
  const targetValue = decodedHeader(headers['x-lumina-image-target-url']);
  if (!IMAGE_PROTOCOLS.has(protocol) || !['GET', 'POST'].includes(method) || !baseValue || !targetValue) return null;
  const base = safeUrl(baseValue, false);
  const target = safeUrl(targetValue, true);
  if (!base || !target || target.toString().length > 4096) return null;
  const allowed = method === 'GET'
    ? safeGetTarget(protocol, base, target)
    : safePostTarget(protocol, base, target);
  return allowed ? { protocol, method, base, target } : null;
}

export function imageProviderAuthHeaders(protocol, key, contentType) {
  const headers = protocol === 'gemini-native'
    ? { 'x-goog-api-key': key }
    : protocol === 'fal'
      ? { authorization: `Key ${key}`, 'x-fal-no-retry': '1' }
      : { authorization: `Bearer ${key}` };
  if (contentType) headers['content-type'] = contentType;
  return headers;
}

function base64Details(value) {
  if (typeof value !== 'string') return null;
  const encoded = value.replace(/^data:[^;,]+;base64,/i, '');
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return {
    decodedLength: Math.floor(encoded.length * 3 / 4) - padding,
    encodedLength: Buffer.byteLength(encoded),
  };
}

export function maximumImageProviderRequestBytes({
  maxAggregateImageBytes,
  maxImageCount,
  maxMetadataBytes,
}) {
  if (![maxAggregateImageBytes, maxImageCount, maxMetadataBytes]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) return 0;
  const aggregateBase64Bytes = Math.ceil(maxAggregateImageBytes / 3) * 4;
  const perImagePaddingBytes = Math.max(0, maxImageCount - 1) * 4;
  return aggregateBase64Bytes + perImagePaddingBytes + maxMetadataBytes;
}

export function imageProviderResponseReservationBytes({
  maxProviderResponseBytes,
  maxResultBytes,
}) {
  if (![maxProviderResponseBytes, maxResultBytes]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) return 0;
  return maxProviderResponseBytes * 3 + maxResultBytes;
}

function jsonImageReferences(protocol, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  if (protocol === 'gemini-native') {
    const contents = Array.isArray(payload.contents) ? payload.contents : [];
    return contents.flatMap((content) => (
      content && typeof content === 'object' && Array.isArray(content.parts)
        ? content.parts.flatMap((part) => {
          if (!part || typeof part !== 'object') return [];
          const inline = part.inlineData ?? part.inline_data;
          return inline && typeof inline === 'object' && typeof inline.data === 'string'
            ? [inline.data]
            : [];
        })
        : []
    ));
  }
  if (protocol === 'fal') return Array.isArray(payload.image_urls) ? payload.image_urls : [];
  if (protocol === 'grsai') return Array.isArray(payload.urls) ? payload.urls : [];
  if (protocol === 'ppio') return Array.isArray(payload.image_base64s) ? payload.image_base64s : [];
  return [];
}

function multipartBoundary(contentType) {
  const match = String(contentType).match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = match?.[1] ?? match?.[2] ?? '';
  return boundary.length >= 1 && boundary.length <= 70 && /^[A-Za-z0-9'()+_,./:=? -]+$/.test(boundary)
    ? boundary
    : null;
}

function multipartPartSizes(body, contentType) {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  if (!body.subarray(0, delimiter.length).equals(delimiter)) return null;
  const files = [];
  let metadataBytes = 0;
  let cursor = 0;
  for (;;) {
    cursor += delimiter.length;
    if (body.subarray(cursor, cursor + 2).toString('ascii') === '--') return { files, metadataBytes };
    if (body.subarray(cursor, cursor + 2).toString('ascii') !== '\r\n') return null;
    cursor += 2;
    const headerEnd = body.indexOf('\r\n\r\n', cursor, 'ascii');
    if (headerEnd < 0 || headerEnd - cursor > 16 * 1024) return null;
    const headers = body.subarray(cursor, headerEnd).toString('latin1');
    const contentStart = headerEnd + 4;
    const boundaryStart = body.indexOf(nextDelimiter, contentStart);
    if (boundaryStart < 0) return null;
    const size = boundaryStart - contentStart;
    if (/^content-disposition:[^\r\n]*\bfilename=(?:"[^"]*"|[^;\r\n]+)/im.test(headers)) {
      files.push(size);
    } else {
      metadataBytes += size + (headerEnd - cursor);
    }
    cursor = boundaryStart + 2;
  }
}

export function imageProviderRequestBodyAllowed(
  descriptor,
  contentType,
  body,
  {
    maxImageBytes = 50 * 1024 * 1024,
    maxImageCount = 10,
    maxAggregateImageBytes = 250 * 1024 * 1024,
    maxMetadataBytes = 1024 * 1024,
  } = {},
) {
  if (!descriptor || descriptor.method !== 'POST' || !Buffer.isBuffer(body) || body.length < 1) return false;
  const mediaType = String(contentType).split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'multipart/form-data') {
    const parts = multipartPartSizes(body, contentType);
    if (!parts || parts.files.length > maxImageCount || parts.metadataBytes > maxMetadataBytes) return false;
    return parts.files.every((size) => size > 0 && size <= maxImageBytes)
      && parts.files.reduce((total, size) => total + size, 0) <= maxAggregateImageBytes;
  }
  if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) return false;
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return false;
  }
  const references = jsonImageReferences(descriptor.protocol, payload);
  if (references.length > maxImageCount) return false;
  let aggregateBytes = 0;
  let encodedBytes = 0;
  for (const reference of references) {
    if (typeof reference !== 'string' || /^https?:\/\//i.test(reference)) continue;
    const details = base64Details(reference);
    if (!details || details.decodedLength < 1 || details.decodedLength > maxImageBytes) return false;
    aggregateBytes += details.decodedLength;
    encodedBytes += details.encodedLength;
  }
  return aggregateBytes <= maxAggregateImageBytes
    && body.length - encodedBytes <= maxMetadataBytes;
}

export function imageProviderResultTarget(baseUrl, source) {
  const base = safeUrl(baseUrl, false);
  if (!base || typeof source !== 'string' || !source.trim() || source.length > 4096) return null;
  try {
    const target = new URL(source.trim(), base);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) return null;
    return { base, target };
  } catch {
    return null;
  }
}

export function imageProviderResultSources(payload, maximumSources = 32) {
  const sources = new Set();
  const add = (value) => {
    if (sources.size >= maximumSources || typeof value !== 'string') return;
    const source = value.trim();
    if ((/^https?:\/\//i.test(source) || /^\/(?!\/)/.test(source)) && source.length <= 4096) sources.add(source);
  };
  const inspect = (value, depth = 0) => {
    if (depth > 2 || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value;
    const records = [record, record.data, record.response, record.result, record.output]
      .filter((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate));
    for (const candidate of records) {
      const items = Array.isArray(candidate.data) ? candidate.data
        : Array.isArray(candidate.images) ? candidate.images
          : Array.isArray(candidate.results) ? candidate.results
            : Array.isArray(candidate.assets) ? candidate.assets : [candidate];
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        add(item.url);
        add(item.signed_url);
        add(item.download_url);
        if (item.image && typeof item.image === 'object' && !Array.isArray(item.image)) {
          add(item.image.url);
          add(item.image.signed_url);
        }
      }
      const imageUrls = candidate.image_urls ?? candidate.resultUrls;
      if (Array.isArray(imageUrls)) imageUrls.forEach(add);
      if (typeof candidate.resultJson === 'string' && candidate.resultJson.length <= 1024 * 1024) {
        try {
          inspect(JSON.parse(candidate.resultJson), depth + 1);
        } catch {
          // Malformed provider result details do not create a download capability.
        }
      }
    }
  };
  inspect(payload);
  return [...sources];
}

export function isImageProviderProtocol(value) {
  return IMAGE_PROTOCOLS.has(value);
}
