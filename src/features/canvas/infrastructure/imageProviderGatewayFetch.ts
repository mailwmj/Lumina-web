import type { CustomImageProtocol } from '@/features/canvas/models/imageProviderProtocols';
import i18n from '@/i18n';
import { createGenerationProviderError } from '@/lib/generationProviderError';

const IMAGE_PROVIDER_GATEWAY_PATH = '/api/generation/image-provider';
const IMAGE_PROVIDER_RESULT_PATH = `${IMAGE_PROVIDER_GATEWAY_PATH}/result`;
const DEFAULT_KIE_ORIGIN = 'https://api.kie.ai';
const DEFAULT_KIE_UPLOAD_ORIGIN = 'https://kieai.redpandaai.co';
const MAX_IMAGE_PROVIDER_RESULT_BYTES = 50 * 1024 * 1024;
const PERMANENT_RESULT_ERROR_CODES = new Set([
  'invalid_provider_result',
  'provider_result_too_large',
  'unsupported_provider_result_type',
]);

interface ImageProviderResultError extends Error {
  code?: string;
  retryable?: boolean;
}

interface ImageProviderGatewayFetchOptions {
  apiKey: string;
  baseUrl: string;
  protocol: CustomImageProtocol;
  fetchImpl?: typeof fetch;
}

interface MaterializeImageProviderResultOptions extends ImageProviderGatewayFetchOptions {
  source: string;
}

function inputUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function providerRequestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  if (init?.headers) return new Headers(init.headers);
  return input instanceof Request ? new Headers(input.headers) : new Headers();
}

function providerRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function providerRequestBody(input: RequestInfo | URL, init?: RequestInit): BodyInit | null | undefined {
  if (init && 'body' in init) return init.body;
  return input instanceof Request ? input.body : undefined;
}

function allowedProviderOrigins(protocol: CustomImageProtocol, baseUrl: string): Set<string> {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error(i18n.t('generationGateway.baseUrlInvalid'));
  }
  const origins = new Set([base.origin]);
  if (protocol === 'kie' && base.origin === DEFAULT_KIE_ORIGIN) {
    origins.add(DEFAULT_KIE_UPLOAD_ORIGIN);
  }
  return origins;
}

function isProviderRequest(headers: Headers): boolean {
  return Boolean(headers.get('authorization') || headers.get('x-goog-api-key'));
}

function assertAllowedProviderTarget(
  protocol: CustomImageProtocol,
  baseUrl: string,
  target: string,
): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(i18n.t('generationGateway.baseUrlInvalid'));
  }
  if (!allowedProviderOrigins(protocol, baseUrl).has(url.origin)
    || url.username || url.password || url.hash) {
    throw new Error(i18n.t('generationGateway.baseUrlNotSupported'));
  }
}

export function createImageProviderGatewayFetch(
  options: ImageProviderGatewayFetchOptions,
): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const upstreamHeaders = providerRequestHeaders(input, init);
    if (!isProviderRequest(upstreamHeaders)) {
      return await fetchImpl(input, init);
    }

    const target = inputUrl(input);
    assertAllowedProviderTarget(options.protocol, options.baseUrl, target);
    const method = providerRequestMethod(input, init);
    const headers = new Headers({
      authorization: `Bearer ${options.apiKey}`,
      'x-lumina-image-protocol': options.protocol,
      'x-lumina-image-base-url': encodeURIComponent(options.baseUrl),
      'x-lumina-image-target-url': encodeURIComponent(target),
      'x-lumina-image-method': method,
    });
    const contentType = upstreamHeaders.get('content-type');
    if (contentType) headers.set('content-type', contentType);
    const body = providerRequestBody(input, init);
    return await fetchImpl(IMAGE_PROVIDER_GATEWAY_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      ...(body === undefined || body === null ? {} : { body }),
    });
  };
}

function sameOriginResultUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.trim();
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate;
  if (typeof location === 'undefined') return null;
  try {
    const url = new URL(candidate, location.origin);
    return url.origin === location.origin && !url.username && !url.password && !url.hash
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function providerResultError(code: string, message: string, retryable: boolean): ImageProviderResultError {
  const error = new Error(message) as ImageProviderResultError;
  error.name = 'ImageProviderResultError';
  error.code = code;
  error.retryable = retryable;
  return error;
}

function errorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const candidate = typeof record.code === 'string' ? record.code : record.error;
  return typeof candidate === 'string' && /^[a-z0-9_]{1,64}$/u.test(candidate)
    ? candidate
    : null;
}

function validateImageDataUrl(source: string): void {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/iu.exec(source);
  if (!match) {
    throw providerResultError(
      'invalid_provider_result',
      i18n.t('generationGateway.invalidResponse'),
      false,
    );
  }
  const base64 = match[2] ?? '';
  const unpaddedLength = base64.endsWith('==')
    ? base64.length - 2
    : base64.endsWith('=') ? base64.length - 1 : base64.length;
  const padding = base64.length - unpaddedLength;
  const remainder = base64.length % 4;
  if (base64.length === 0 || (padding > 0 ? remainder !== 0 : remainder === 1)) {
    throw providerResultError(
      'invalid_provider_result',
      i18n.t('generationGateway.invalidResponse'),
      false,
    );
  }
  const decodedBytes = Math.floor(base64.length * 3 / 4) - padding;
  if (decodedBytes > MAX_IMAGE_PROVIDER_RESULT_BYTES) {
    throw providerResultError(
      'provider_result_too_large',
      i18n.t('generationGateway.invalidResponse'),
      false,
    );
  }
}

export function isPermanentImageProviderResultError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as ImageProviderResultError;
  return candidate.retryable === false
    || (typeof candidate.code === 'string' && PERMANENT_RESULT_ERROR_CODES.has(candidate.code));
}

export async function materializeImageProviderResult(
  options: MaterializeImageProviderResultOptions,
): Promise<string> {
  if (options.source.startsWith('data:')) {
    validateImageDataUrl(options.source);
    return options.source;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(IMAGE_PROVIDER_RESULT_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      protocol: options.protocol,
      base_url: options.baseUrl,
      source: options.source,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = errorCode(payload) ?? 'image_provider_result_unavailable';
    const error = createGenerationProviderError(payload, response.status, {
      errorCode: code,
      fallbackMessage: i18n.t('generationGateway.httpError', { status: response.status }),
      gatewayRequestId: response.headers.get('x-request-id'),
    }) as ImageProviderResultError;
    error.name = 'ImageProviderResultError';
    error.retryable = !PERMANENT_RESULT_ERROR_CODES.has(code);
    throw error;
  }
  const url = sameOriginResultUrl(
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).url
      : null,
  );
  if (!url) throw new Error(i18n.t('generationGateway.invalidResponse'));
  return url;
}
