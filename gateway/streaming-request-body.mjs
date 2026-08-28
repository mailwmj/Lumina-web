/* global Buffer */

const BASE64_CHUNK_BYTES = 48 * 1024;

function literal(value) {
  return Buffer.from(value, 'utf8');
}

function appendJsonTokens(tokens, value, media, ancestors) {
  if (typeof value === 'string') {
    const match = value.match(/^lumina-media:(\d{1,2})$/);
    if (match) {
      const reference = media[Number(match[1])];
      if (!reference) throw new Error('invalid media placeholder');
      tokens.push({ media: reference });
      return;
    }
    tokens.push(literal(JSON.stringify(value)));
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    tokens.push(literal(JSON.stringify(value) ?? 'null'));
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('cyclic JSON value');
    ancestors.add(value);
    tokens.push(literal('['));
    value.forEach((item, index) => {
      if (index > 0) tokens.push(literal(','));
      appendJsonTokens(tokens, item === undefined ? null : item, media, ancestors);
    });
    tokens.push(literal(']'));
    ancestors.delete(value);
    return;
  }
  if (!value || typeof value !== 'object') throw new Error('unsupported JSON value');
  if (ancestors.has(value)) throw new Error('cyclic JSON value');
  ancestors.add(value);
  tokens.push(literal('{'));
  let index = 0;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
    if (index > 0) tokens.push(literal(','));
    tokens.push(literal(`${JSON.stringify(key)}:`));
    appendJsonTokens(tokens, item, media, ancestors);
    index += 1;
  }
  tokens.push(literal('}'));
  ancestors.delete(value);
}

function mediaTokenLength(reference) {
  const prefix = Buffer.byteLength(`"data:${reference.contentType};base64,`);
  return prefix + Math.ceil(reference.bytes.length / 3) * 4 + 1;
}

async function* jsonTokenChunks(tokens) {
  for (const token of tokens) {
    if (Buffer.isBuffer(token)) {
      yield token;
      continue;
    }
    const { bytes, contentType } = token.media;
    yield literal(`"data:${contentType};base64,`);
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
      const end = Math.min(bytes.length, offset + BASE64_CHUNK_BYTES);
      yield Buffer.from(bytes.subarray(offset, end).toString('base64'), 'ascii');
    }
    yield literal('"');
  }
}

export function createJsonMediaRequestBody(value, media) {
  const tokens = [];
  appendJsonTokens(tokens, value, media, new Set());
  const byteLength = tokens.reduce((total, token) => (
    total + (Buffer.isBuffer(token) ? token.length : mediaTokenLength(token.media))
  ), 0);
  if (!Number.isSafeInteger(byteLength)) throw new Error('JSON request body is too large');
  return {
    byteLength,
    contentType: 'application/json',
    [Symbol.asyncIterator]: () => jsonTokenChunks(tokens),
  };
}

function safeBoundaryOrFilename(value) {
  const normalized = String(value);
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(normalized)) throw new Error('invalid multipart token');
  return normalized;
}

function quotedPartName(value) {
  const normalized = String(value);
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (!normalized || normalized.length > 256 || hasControlCharacter) {
    throw new Error('invalid multipart field name');
  }
  return normalized.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function createMultipartRequestBody({ boundary, fields, files }) {
  const normalizedBoundary = safeBoundaryOrFilename(boundary);
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(literal(
      `--${normalizedBoundary}\r\nContent-Disposition: form-data; name="${quotedPartName(name)}"\r\n\r\n${String(value)}\r\n`,
    ));
  }
  for (const file of files) {
    if (!Buffer.isBuffer(file.bytes) || file.bytes.length < 1
      || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(file.contentType)) {
      throw new Error('invalid multipart file');
    }
    chunks.push(literal(
      `--${normalizedBoundary}\r\nContent-Disposition: form-data; name="${quotedPartName(file.name)}"; filename="${safeBoundaryOrFilename(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ));
    chunks.push(file.bytes);
    chunks.push(literal('\r\n'));
  }
  chunks.push(literal(`--${normalizedBoundary}--\r\n`));
  const byteLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (!Number.isSafeInteger(byteLength)) throw new Error('multipart request body is too large');
  return {
    byteLength,
    contentType: `multipart/form-data; boundary=${normalizedBoundary}`,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}
