import { describe, expect, it } from 'vitest';

import {
  createGenerationProviderError,
  getGenerationErrorLogFields,
  getSafeGenerationProviderErrorDetails,
} from './generationProviderError';

describe('generation provider errors', () => {
  it('keeps the provider error and request ID while redacting credentials', () => {
    const error = createGenerationProviderError({
      request_id: 'req_42',
      error: {
        message: 'Upstream rejected Bearer provider-secret',
        api_key: 'provider-secret',
        documentation: 'https://provider.example/errors?access_token=provider-secret',
      },
    }, 429);

    expect(error.message).toBe('Upstream rejected Bearer [REDACTED]');
    expect(error.requestId).toBe('req_42');
    expect(error.details).toBe([
      'Provider request failed with HTTP 429.',
      'Provider request ID: req_42',
    ].join('\n'));
    expect(error.details).not.toContain('provider-secret');
    expect(error.details).not.toContain('https://provider.example');
  });

  it('redacts a signed URL query from readable provider errors', () => {
    const error = createGenerationProviderError({
      message: 'Result upload failed: https://cdn.example/result.png?X-Amz-Signature=signed-value',
    }, 500);

    expect(error.message).toBe('Result upload failed: https://cdn.example/result.png?[REDACTED]');
  });

  it('separates a gateway request ID from a provider request ID and keeps safe diagnostics', () => {
    const error = createGenerationProviderError({
      error: 'queue_capacity_exceeded',
      message: 'The generation queue is full.',
      request_id: 'gateway-request-42',
    }, 429, {
      gatewayRequestId: 'gateway-request-42',
    });

    expect(error.requestId).toBeUndefined();
    expect(error.gatewayRequestId).toBe('gateway-request-42');
    expect(error.code).toBe('queue_capacity_exceeded');
    expect(error.status).toBe(429);
    expect(error.details).toBe([
      'Provider request failed with HTTP 429.',
      'Error code: queue_capacity_exceeded',
      'Gateway request ID: gateway-request-42',
    ].join('\n'));
    expect(getSafeGenerationProviderErrorDetails(error.details)).toBe(error.details);
  });

  it('keeps diagnostics logs free of credentials and signed URL queries', () => {
    const error = createGenerationProviderError({
      request_id: 'provider-request-9',
      error: {
        code: 'provider_rejected',
        message: 'Rejected Bearer provider-secret at https://provider.test/error?token=provider-secret',
      },
    }, 400, { gatewayRequestId: 'gateway-request-9' });

    const fields = getGenerationErrorLogFields(error);
    expect(fields).toMatchObject({
      errorCode: 'provider_rejected',
      httpStatus: 400,
      gatewayRequestId: 'gateway-request-9',
      providerRequestId: 'provider-request-9',
    });
    expect(JSON.stringify(fields)).not.toContain('provider-secret');
    expect(JSON.stringify(fields)).not.toContain('https://provider.test');
    expect(JSON.stringify(fields)).toContain('[REDACTED]');
  });
});
