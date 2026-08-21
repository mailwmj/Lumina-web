const MAXIMUM_ERROR_LENGTH = 2_000;
const REQUEST_ID_KEYS = ['request_id', 'requestId', 'x_request_id', 'xRequestId'];
const SENSITIVE_VALUE_PATTERN = /(["']?(?:api[_-]?key|access[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^"',\s}\]]+)/gi;
const SENSITIVE_QUERY_PATTERN = /([?&](?:api[_-]?key|access[_-]?token|token|secret|password|authorization)=)[^&#\s]+/gi;
const AUTHORIZATION_PATTERN = /\b(Bearer|Key)\s+[A-Za-z0-9._~+/=-]+/gi;

export interface GenerationProviderError extends Error {
  details?: string;
  requestId?: string;
}

function bounded(value: string): string {
  return value.slice(0, MAXIMUM_ERROR_LENGTH);
}

export function sanitizeGenerationProviderError(value: string): string {
  return bounded(value)
    .replace(AUTHORIZATION_PATTERN, '$1 [REDACTED]')
    .replace(SENSITIVE_VALUE_PATTERN, '$1[REDACTED]')
    .replace(SENSITIVE_QUERY_PATTERN, '$1[REDACTED]');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function extractGenerationProviderRequestId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const nestedError = asRecord(record.error);
  const nestedData = asRecord(record.data);
  for (const candidate of [record, nestedError, nestedData]) {
    for (const key of REQUEST_ID_KEYS) {
      const requestId = candidate?.[key];
      if (typeof requestId === 'string' && requestId.trim() && requestId.length <= 512) {
        return requestId.trim();
      }
    }
  }
  return undefined;
}

function providerErrorMessage(value: unknown, status: number): string {
  const record = asRecord(value);
  const nestedError = asRecord(record?.error);
  const candidates = [
    nestedError?.message,
    record?.message,
    typeof record?.error === 'string' ? record.error : undefined,
  ];
  const message = candidates.find((candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()));
  return sanitizeGenerationProviderError(message?.trim() || `Provider request failed with HTTP ${status}.`);
}

export function createGenerationProviderError(value: unknown, status: number): GenerationProviderError {
  const error = new Error(providerErrorMessage(value, status)) as GenerationProviderError;
  error.name = 'GenerationProviderError';
  error.requestId = extractGenerationProviderRequestId(value);
  error.details = `Provider request failed with HTTP ${status}.`;
  return error;
}

export function getGenerationProviderRequestId(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const requestId = (error as GenerationProviderError).requestId;
  return typeof requestId === 'string' && requestId.trim() ? requestId.trim() : undefined;
}
