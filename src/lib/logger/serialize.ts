import type { LogFields } from './types';

const MAX_FIELD_BYTES = 10 * 1024;
const CIRCULAR_MARKER = '<circular>';

export function serializeFields(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  const seen = new WeakSet<object>();
  const result: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    result[key] = serializeValue(value, seen);
  }

  return truncateIfLarge(result);
}

function serializeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (value instanceof Error) {
    return {
      __error: true,
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) {
    return {
      __map: true,
      entries: Array.from(value.entries()).map(([k, v]) => [k, serializeValue(v, seen)]),
    };
  }
  if (value instanceof Set) {
    return {
      __set: true,
      values: Array.from(value.values()).map((v) => serializeValue(v, seen)),
    };
  }
  if (typeof value === 'object') {
    const obj = value as object;
    if (seen.has(obj)) return CIRCULAR_MARKER;
    seen.add(obj);
    const out: LogFields = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = serializeValue(v, seen);
    }
    return out;
  }
  return String(value);
}

function truncateIfLarge(obj: LogFields): LogFields {
  let serialized: string;
  try {
    serialized = JSON.stringify(obj);
  } catch {
    return { __serialization_error: true };
  }
  if (serialized.length <= MAX_FIELD_BYTES) return obj;
  return {
    __truncated: true,
    preview: serialized.slice(0, MAX_FIELD_BYTES),
    original_bytes: serialized.length,
  };
}