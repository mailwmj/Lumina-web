const MAXIMUM_ERROR_LENGTH = 2_000;
const REQUEST_ID_KEYS = ['request_id', 'requestId', 'x_request_id', 'xRequestId'];
const SENSITIVE_VALUE_PATTERN = /(["']?(?:api[_-]?key|access[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^"',\s}\]]+)/gi;
const SENSITIVE_QUERY_PATTERN = /([?&](?:api[_-]?key|access[_-]?token|token|secret|password|authorization)=)[^&#\s]+/gi;
const AUTHORIZATION_PATTERN = /\b(Bearer|Key)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_QUERY_PATTERN = /(https?:\/\/[^\s"'<>?#]+(?:\/[^\s"'<>?#]*)?)\?[^\s"'<>]+/gi;
const FULL_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SAFE_HTTP_DETAILS_PATTERN = /^Provider request failed with HTTP [1-5]\d{2}\.$/;
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ERROR_CODE_DETAILS_PATTERN = /^Error code: ([A-Za-z][A-Za-z0-9._:-]{0,127})$/;
const SAFE_GATEWAY_REQUEST_ID_DETAILS_PATTERN = /^Gateway request ID: ([A-Za-z0-9._:-]{1,512})$/;
const SAFE_PROVIDER_REQUEST_ID_DETAILS_PATTERN = /^Provider request ID: ([A-Za-z0-9._:-]{1,512})$/;

export interface GenerationProviderError extends Error {
  details?: string;
  requestId?: string;
  gatewayRequestId?: string;
  code?: string;
  status?: number;
}

interface CreateGenerationProviderErrorOptions {
  gatewayRequestId?: unknown;
  fallbackMessage?: string;
  errorCode?: unknown;
}

function bounded(value: string): string {
  return value.slice(0, MAXIMUM_ERROR_LENGTH);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeGenerationErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const code = value.trim();
  return SAFE_ERROR_CODE_PATTERN.test(code) ? code : undefined;
}

function extractGenerationErrorCode(value: unknown): string | undefined {
  const record = asRecord(value);
  const nestedError = asRecord(record?.error);
  return [nestedError?.code, record?.code, typeof record?.error === 'string' ? record.error : undefined]
    .map(normalizeGenerationErrorCode)
    .find(Boolean);
}

export function sanitizeGenerationProviderError(value: string): string {
  return bounded(value)
    .replace(AUTHORIZATION_PATTERN, '$1 [REDACTED]')
    .replace(SENSITIVE_VALUE_PATTERN, '$1[REDACTED]')
    .replace(SENSITIVE_QUERY_PATTERN, '$1[REDACTED]')
    .replace(URL_QUERY_PATTERN, '$1?[REDACTED]');
}

export function normalizeGenerationProviderRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const requestId = value.trim();
  return requestId.length > 0
    && requestId.length <= 512
    && SAFE_REQUEST_ID_PATTERN.test(requestId)
    ? requestId
    : undefined;
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
      const requestId = normalizeGenerationProviderRequestId(candidate?.[key]);
      if (requestId) {
        return requestId;
      }
    }
  }
  return undefined;
}

function providerErrorMessage(value: unknown, status: number, fallbackMessage?: string): string {
  const record = asRecord(value);
  const nestedError = asRecord(record?.error);
  const candidates = [
    nestedError?.message,
    record?.message,
    typeof record?.error === 'string' ? record.error : undefined,
  ];
  const message = candidates.find((candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()));
  return sanitizeGenerationProviderError(
    message?.trim() || fallbackMessage?.trim() || `Provider request failed with HTTP ${status}.`
  );
}

function generationErrorDetails(
  status: number,
  code: string | undefined,
  gatewayRequestId: string | undefined,
  providerRequestId: string | undefined,
): string {
  return [
    `Provider request failed with HTTP ${status}.`,
    code ? `Error code: ${code}` : '',
    gatewayRequestId ? `Gateway request ID: ${gatewayRequestId}` : '',
    providerRequestId ? `Provider request ID: ${providerRequestId}` : '',
  ].filter(Boolean).join('\n');
}

export function createGenerationProviderError(
  value: unknown,
  status: number,
  options: CreateGenerationProviderErrorOptions = {},
): GenerationProviderError {
  const gatewayRequestId = normalizeGenerationProviderRequestId(options.gatewayRequestId);
  const extractedRequestId = extractGenerationProviderRequestId(value);
  const providerRequestId = extractedRequestId === gatewayRequestId ? undefined : extractedRequestId;
  const code = normalizeGenerationErrorCode(options.errorCode) ?? extractGenerationErrorCode(value);
  const error = new Error(providerErrorMessage(value, status, options.fallbackMessage)) as GenerationProviderError;
  error.name = 'GenerationProviderError';
  error.requestId = providerRequestId;
  error.gatewayRequestId = gatewayRequestId;
  error.code = code;
  error.status = status;
  error.details = generationErrorDetails(status, code, gatewayRequestId, providerRequestId);
  return error;
}

export function getGenerationProviderRequestId(error: unknown): string | undefined {
  return error && typeof error === 'object'
    ? normalizeGenerationProviderRequestId((error as GenerationProviderError).requestId)
    : undefined;
}

export function getGenerationGatewayRequestId(error: unknown): string | undefined {
  return error && typeof error === 'object'
    ? normalizeGenerationProviderRequestId((error as GenerationProviderError).gatewayRequestId)
    : undefined;
}

export function getGenerationErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object'
    ? normalizeGenerationErrorCode((error as GenerationProviderError).code)
    : undefined;
}

export function getGenerationErrorLogFields(error: unknown): Record<string, unknown> {
  const safeLogText = (value: string) => sanitizeGenerationProviderError(value).replace(FULL_URL_PATTERN, '[REDACTED_URL]');
  if (!(error instanceof Error)) {
    return { errorMessage: safeLogText(String(error)) };
  }
  const candidate = error as GenerationProviderError;
  return {
    errorName: error.name,
    errorMessage: safeLogText(error.message),
    ...(error.stack ? { errorStack: safeLogText(error.stack) } : {}),
    ...(getGenerationErrorCode(candidate) ? { errorCode: candidate.code } : {}),
    ...(Number.isInteger(candidate.status) && Number(candidate.status) >= 100 && Number(candidate.status) <= 599
      ? { httpStatus: candidate.status }
      : {}),
    ...(getGenerationGatewayRequestId(candidate) ? { gatewayRequestId: candidate.gatewayRequestId } : {}),
    ...(getGenerationProviderRequestId(candidate) ? { providerRequestId: candidate.requestId } : {}),
  };
}

export function getSafeGenerationProviderErrorDetails(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAXIMUM_ERROR_LENGTH) {
    return undefined;
  }
  const lines = value.split('\n');
  if (!SAFE_HTTP_DETAILS_PATTERN.test(lines[0] ?? '')) {
    return undefined;
  }
  const valid = lines.slice(1).every((line) => (
    SAFE_ERROR_CODE_DETAILS_PATTERN.test(line)
    || SAFE_GATEWAY_REQUEST_ID_DETAILS_PATTERN.test(line)
    || SAFE_PROVIDER_REQUEST_ID_DETAILS_PATTERN.test(line)
  ));
  return valid && new Set(lines).size === lines.length ? value : undefined;
}
