import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OPERATIONS = new Set([
  'submit', 'poll', 'result', 'result_confirm',
  'media_publish', 'media_transcode', 'media_retrieve', 'media_release',
  'provider_register', 'model_discovery', 'text_proxy', 'video_proxy',
  'image_provider_proxy', 'image_provider_receipt', 'image_provider_result', 'unknown',
]);
const PROVIDERS = new Set([
  'ai-media', 'chaomo', 'custom', 'custom-openai', 'media', 'text', 'volcengine-seedance',
  'openai-images', 'fhl-images', 'gemini-native', 'fal', 'grsai', 'kie', 'runninghub',
  'bltcy', 'ppio', 'unknown',
]);
const BASE_FIELDS = ['timestamp', 'request_id', 'operation', 'provider', 'status', 'duration_ms', 'bytes'];
const RECEIPT_FIELDS = [
  'receipt_top_level_fields', 'receipt_nested_fields', 'receipt_candidate_field',
  'receipt_id_length', 'receipt_id_prefix', 'receipt_id_characters',
];
const FIELDS = new Set([...BASE_FIELDS, ...RECEIPT_FIELDS]);
const RECEIPT_FIELD_NAMES = new Set([
  'assets', 'data', 'id', 'object', 'output', 'poll_after_ms', 'poll_url', 'request_id',
  'requestId', 'response', 'result', 'result_url', 'status', 'status_url', 'task_id', 'taskId',
]);
const RECEIPT_CANDIDATE_FIELDS = new Set(['none', 'task_id', 'taskId', 'id', 'request_id', 'requestId']);
const RECEIPT_ID_PREFIXES = new Set(['none', 'imgtask', 'chaomo-task', 'task', 'other']);
const RECEIPT_ID_CHARACTERS = new Set(['none', 'alphanumeric', 'opaque-safe', 'unsafe']);

function isSafeStringArray(value, predicate) {
  return Array.isArray(value)
    && value.length <= 32
    && value.every((item) => typeof item === 'string' && predicate(item))
    && new Set(value).size === value.length;
}

function isSafeReceiptFields(record) {
  if (record.operation !== 'image_provider_receipt') {
    return RECEIPT_FIELDS.every((field) => !(field in record));
  }
  return isSafeStringArray(record.receipt_top_level_fields, (field) => RECEIPT_FIELD_NAMES.has(field))
    && isSafeStringArray(record.receipt_nested_fields, (field) => {
      const [container, member, extra] = field.split('.');
      return !extra && ['data', 'response', 'result'].includes(container) && RECEIPT_FIELD_NAMES.has(member);
    })
    && RECEIPT_CANDIDATE_FIELDS.has(record.receipt_candidate_field)
    && Number.isInteger(record.receipt_id_length)
    && record.receipt_id_length >= 0
    && record.receipt_id_length <= 128
    && RECEIPT_ID_PREFIXES.has(record.receipt_id_prefix)
    && RECEIPT_ID_CHARACTERS.has(record.receipt_id_characters);
}

function isSafeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !FIELDS.has(key))) return false;
  return Number.isFinite(value.timestamp)
    && typeof value.request_id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value.request_id)
    && OPERATIONS.has(value.operation)
    && PROVIDERS.has(value.provider)
    && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599
    && Number.isFinite(value.duration_ms) && value.duration_ms >= 0
    && Number.isFinite(value.bytes) && value.bytes >= 0
    && isSafeReceiptFields(value);
}

function readRecords(file, cutoff) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const record = JSON.parse(line);
        return isSafeRecord(record) && record.timestamp >= cutoff ? [record] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function createGatewayLogger({ file, now = Date.now, retentionMs = RETENTION_MS }) {
  const safeRetentionMs = Math.max(1, Math.min(retentionMs, RETENTION_MS));

  const prune = () => {
    try {
      const records = readRecords(file, now() - safeRetentionMs);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');
    } catch {
      // Logging must not make generation unavailable.
    }
  };

  prune();

  return {
    prune,
    record({ requestId, operation, provider, status, durationMs, bytes }) {
      const record = {
        timestamp: now(),
        request_id: requestId,
        operation,
        provider,
        status,
        duration_ms: durationMs,
        bytes,
      };
      if (!isSafeRecord(record)) return;
      try {
        appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      } catch {
        // Logging must not make generation unavailable.
      }
    },
    recordReceipt({ requestId, provider, status, bytes, diagnostic }) {
      const record = {
        timestamp: now(),
        request_id: requestId,
        operation: 'image_provider_receipt',
        provider,
        status,
        duration_ms: 0,
        bytes,
        receipt_top_level_fields: diagnostic?.topLevelFields,
        receipt_nested_fields: diagnostic?.nestedFields,
        receipt_candidate_field: diagnostic?.candidateField,
        receipt_id_length: diagnostic?.candidateIdLength,
        receipt_id_prefix: diagnostic?.candidateIdPrefix,
        receipt_id_characters: diagnostic?.candidateIdCharacters,
      };
      if (!isSafeRecord(record)) return;
      try {
        appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      } catch {
        // Logging must not make generation unavailable.
      }
    },
  };
}
