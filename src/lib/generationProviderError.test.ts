import { describe, expect, it } from 'vitest';

import { createGenerationProviderError } from './generationProviderError';

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
    expect(error.details).toBe('Provider request failed with HTTP 429.');
    expect(error.details).not.toContain('provider-secret');
    expect(error.details).not.toContain('https://provider.example');
  });

  it('redacts a signed URL query from readable provider errors', () => {
    const error = createGenerationProviderError({
      message: 'Result upload failed: https://cdn.example/result.png?X-Amz-Signature=signed-value',
    }, 500);

    expect(error.message).toBe('Result upload failed: https://cdn.example/result.png?[REDACTED]');
  });
});
