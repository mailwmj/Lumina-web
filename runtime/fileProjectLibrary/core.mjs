import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { constants as fsConstants } from 'node:fs';

import fs from 'node:fs/promises';

import { createRequire } from 'node:module';

import path from 'node:path';

import { TextDecoder, TextEncoder } from 'node:util';



export { createHash, randomBytes, randomUUID, fs, fsConstants, path, TextDecoder, TextEncoder };

export const require = createRequire(import.meta.url);
export const ADMISSION_REGISTRY = require('../../docs/adr/0006-runtime-file-project-library/admission-registry-v1.json');

if (
  ADMISSION_REGISTRY?.format !== 'lumina-project-admission-registry'
  || ADMISSION_REGISTRY?.version !== 1
  || ADMISSION_REGISTRY?.canonicalization !== 'RFC8785-JCS-SHA256-v1'
) {
  throw new Error('Unsupported Lumina project admission registry.');
}

export const MAX_ID_BYTES = 256;
export const MAX_JSON_DEPTH = 256;
export const MAX_ASSET_METADATA_BYTES = ADMISSION_REGISTRY.limits.maxAssetMetadataDocumentBytes;
export const MAX_PROJECT_DOCUMENT_BYTES = ADMISSION_REGISTRY.limits.maxProjectDocumentBytes;
export const MAX_HISTORY_DOCUMENT_BYTES = ADMISSION_REGISTRY.limits.maxHistoryDocumentBytes;
export const MAX_DURABLE_ASSET_BYTES = ADMISSION_REGISTRY.limits.maxDurableLibraryAssetBytes;
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
export const MAX_WRITE_LEASE_MS = 5 * 60 * 1000;
export const ADMITTED_NODE_TYPES = new Set(ADMISSION_REGISTRY.schemas.CanvasNode.fields.type.enum);
export const DERIVED_DISPLAY_URL_FIELDS = new Set(
  Object.entries(ADMISSION_REGISTRY.fieldProfiles)
    .filter(([, profile]) => profile.classification === 'derived-display-url')
    .map(([name]) => name),
);
export const decoder = new TextDecoder('utf-8', { fatal: true });
export const encoder = new TextEncoder();

export class FileProjectLibraryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FileProjectLibraryError';
    this.code = code;
    Object.assign(this, details);
  }
}

export class CorruptLibraryError extends FileProjectLibraryError {
  constructor(message, details = {}) {
    super('corrupt_schema', message, details);
    this.name = 'CorruptLibraryError';
  }
}

export function validateLogicalId(value, label = 'id') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FileProjectLibraryError('invalid_id', `${label} must be a non-empty string.`);
  }
  const bytes = encoder.encode(value);
  if (bytes.length > MAX_ID_BYTES || value.includes('\u0000') || hasUnpairedSurrogate(value)) {
    throw new FileProjectLibraryError('invalid_id', `${label} is invalid or too large.`);
  }
  return value;
}

export function canonicalize(value) {
  assertJsonValue(value);
  return canonicalizeValue(value);
}

export function sha256(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(value);
  return createHash('sha256').update(bytes).digest('hex');
}


export function makeLibraryKey(prefix) {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

export function compareUtf8(left, right) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

export function parseJsonString(value, label) {
  if (typeof value !== 'string') throw new FileProjectLibraryError('invalid_project', `${label} must be JSON text.`);
  try {
    const parsed = parseJsonText(value);
    assertJsonValue(parsed);
    return parsed;
  } catch (error) {
    throw new FileProjectLibraryError('invalid_project', `${label} is not valid JSON.`, { cause: error });
  }
}

export function parseStrictJson(bytes, label) {
  try {
    const text = decoder.decode(bytes instanceof Uint8Array ? bytes : encoder.encode(bytes));
    if (text.charCodeAt(0) === 0xfeff) throw new Error('BOM');
    const value = parseJsonText(text);
    assertJsonValue(value);
    if (canonicalize(value) !== text) throw new Error('non-canonical JSON');
    return value;
  } catch (error) {
    if (error instanceof CorruptLibraryError) throw error;
    throw new CorruptLibraryError(`${label} is not a valid canonical JSON document.`, { cause: error });
  }
}

export function parseJsonText(text) {
  let index = 0;
  let depth = 0;

  const fail = (message) => {
    throw new SyntaxError(`${message} at byte ${index}.`);
  };
  const skipWhitespace = () => {
    while (index < text.length && /[\u0020\u0009\u000a\u000d]/u.test(text[index])) index += 1;
  };
  const parseString = () => {
    const start = index;
    if (text[index] !== '"') fail('Expected a JSON string');
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '\\') {
        index += 2;
        if (index > text.length) fail('Unterminated JSON escape');
        continue;
      }
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch (error) {
          throw new SyntaxError(`Invalid JSON string: ${error.message}`);
        }
      }
      if (character < ' ') fail('Control character in JSON string');
      index += 1;
    }
    fail('Unterminated JSON string');
  };
  const parseNumber = () => {
    const match = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) fail('Invalid JSON number');
    index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) fail('Non-finite JSON number');
    return number;
  };
  const parseValue = () => {
    skipWhitespace();
    if (depth > MAX_JSON_DEPTH) fail('JSON nesting is too deep');
    const character = text[index];
    if (character === '"') return parseString();
    if (character === '-' || (character >= '0' && character <= '9')) return parseNumber();
    if (text.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (text.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (text.startsWith('null', index)) {
      index += 4;
      return null;
    }
    if (character === '[') {
      index += 1;
      depth += 1;
      const result = [];
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        depth -= 1;
        return result;
      }
      while (true) {
        result.push(parseValue());
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          depth -= 1;
          return result;
        }
        if (text[index] !== ',') fail('Expected a comma in JSON array');
        index += 1;
      }
    }
    if (character === '{') {
      index += 1;
      depth += 1;
      const result = Object.create(null);
      const keys = new Set();
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        depth -= 1;
        return result;
      }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail(`Duplicate JSON member ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') fail('Expected a colon in JSON object');
        index += 1;
        Object.defineProperty(result, key, {
          value: parseValue(),
          enumerable: true,
          configurable: true,
          writable: true,
        });
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          depth -= 1;
          return result;
        }
        if (text[index] !== ',') fail('Expected a comma in JSON object');
        index += 1;
      }
    }
    fail('Unexpected JSON token');
  };

  const value = parseValue();
  skipWhitespace();
  if (index !== text.length) fail('Trailing JSON data');
  return value;
}

export function assertExactFields(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CorruptLibraryError(`${label} must be an object.`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new CorruptLibraryError(`${label} contains unknown member ${key}.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new CorruptLibraryError(`${label} is missing member ${key}.`);
  }
}

export function assertJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && hasUnpairedSurrogate(value)) throw new FileProjectLibraryError('invalid_json', 'JSON contains an unpaired surrogate.');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FileProjectLibraryError('invalid_json', 'JSON contains a non-finite number.');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertJsonValue);
    return;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (hasUnpairedSurrogate(key)) throw new FileProjectLibraryError('invalid_json', 'JSON contains an unpaired key.');
      assertJsonValue(item);
    });
    return;
  }
  throw new FileProjectLibraryError('invalid_json', 'JSON contains an unsupported value.');
}

export function canonicalizeValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeValue).join(',')}]`;
  const keys = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeValue(value[key])}`).join(',')}}`;
}

export function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function isSensitiveName(value) {
  const normalized = value.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
  return ['apikey', 'token', 'secret', 'password', 'authorization', 'credential', 'cookie', 'privatekey', 'clientsecret', 'accesskey', 'gatewayurl', 'signature', 'signedurl'].some((part) => normalized.includes(part));
}

export function containsCredentialLikeString(value) {
  const trimmed = value.trim();
  return /^(?:bearer|basic|token)\s+\S+/iu.test(trimmed)
    || /^(?:sk-|rk-|pk-|akia|ghp_|github_pat_|xox)[A-Za-z0-9_-]{8,}/iu.test(trimmed)
    || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(trimmed)
    || /^blob:|^data:/iu.test(trimmed);
}

export function containsUnsafeUrl(value) {
  const trimmed = value.trim();
  if (/^(?:data:|blob:)/iu.test(trimmed)) return true;
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return !['http:', 'https:'].includes(parsed.protocol)
      || Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
  } catch {
    return true;
  }
}

export function walk(value, visitor) {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      visitor('', item);
      walk(item, visitor);
    });
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      visitor(key, item);
      walk(item, visitor);
    });
  }
}
