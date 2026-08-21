import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OPERATIONS = new Set(['submit', 'poll', 'result', 'result_confirm', 'media_publish', 'media_transcode', 'media_retrieve', 'media_release', 'unknown']);
const PROVIDERS = new Set(['ai-media', 'media', 'unknown']);
const FIELDS = new Set(['timestamp', 'request_id', 'operation', 'provider', 'status', 'duration_ms', 'bytes']);

function isSafeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !FIELDS.has(key))) return false;
  return Number.isFinite(value.timestamp)
    && typeof value.request_id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value.request_id)
    && OPERATIONS.has(value.operation)
    && PROVIDERS.has(value.provider)
    && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599
    && Number.isFinite(value.duration_ms) && value.duration_ms >= 0
    && Number.isFinite(value.bytes) && value.bytes >= 0;
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
  };
}
