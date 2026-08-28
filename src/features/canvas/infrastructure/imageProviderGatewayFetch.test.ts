import { describe, expect, it, vi } from 'vitest';

import {
  createImageProviderGatewayFetch,
  isPermanentImageProviderResultError,
  materializeImageProviderResult,
} from './imageProviderGatewayFetch';

describe('imageProviderGatewayFetch', () => {
  it('leaves unauthenticated reference reads on the original fetch implementation', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('image', { status: 200 }));
    const providerFetch = createImageProviderGatewayFetch({
      apiKey: 'provider-key',
      baseUrl: 'https://api.kie.ai',
      protocol: 'kie',
      fetchImpl,
    });

    await providerFetch('blob:reference-one');
    await providerFetch('https://images.example/reference-two.png');

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'blob:reference-one',
      'https://images.example/reference-two.png',
    ]);
  });

  it('allows the fixed KIE upload origin and forwards only the provider content type', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const providerFetch = createImageProviderGatewayFetch({
      apiKey: 'provider-key',
      baseUrl: 'https://api.kie.ai',
      protocol: 'kie',
      fetchImpl,
    });

    await providerFetch('https://kieai.redpandaai.co/api/file-stream-upload', {
      method: 'POST',
      headers: {
        authorization: 'Bearer upstream-key',
        'content-type': 'application/json',
        'x-provider-debug': 'must-not-pass',
      },
      body: '{}',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/generation/image-provider');
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer provider-key');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('x-provider-debug')).toBe(false);
    expect(decodeURIComponent(headers.get('x-lumina-image-target-url') ?? ''))
      .toBe('https://kieai.redpandaai.co/api/file-stream-upload');
  });

  it('rejects authenticated requests outside the configured provider origins', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const providerFetch = createImageProviderGatewayFetch({
      apiKey: 'provider-key',
      baseUrl: 'https://queue.fal.run',
      protocol: 'fal',
      fetchImpl,
    });

    await expect(providerFetch('https://internal.example/provider', {
      headers: { authorization: 'Key provider-key' },
    })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('materializes absolute and provider-relative results into a same-origin result URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      url: '/api/generation/image-provider/result/result-42',
    }), { status: 200 }));

    await expect(materializeImageProviderResult({
      apiKey: 'provider-key',
      baseUrl: 'https://queue.fal.run',
      protocol: 'fal',
      source: 'data:image/png;base64,AQID',
      fetchImpl,
    })).resolves.toBe('data:image/png;base64,AQID');
    await expect(materializeImageProviderResult({
      apiKey: 'provider-key',
      baseUrl: 'https://queue.fal.run',
      protocol: 'fal',
      source: 'https://results.example/result-42.png',
      fetchImpl,
    })).resolves.toBe('/api/generation/image-provider/result/result-42');
    await expect(materializeImageProviderResult({
      apiKey: 'provider-key',
      baseUrl: 'https://queue.fal.run',
      protocol: 'fal',
      source: '/provider/results/result-43.png',
      fetchImpl,
    })).resolves.toBe('/api/generation/image-provider/result/result-42');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/generation/image-provider/result');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      protocol: 'fal',
      base_url: 'https://queue.fal.run',
      source: 'https://results.example/result-42.png',
    });
  });

  it('accepts an exact 50 MiB data result and permanently rejects one extra decoded byte', async () => {
    const exactBytes = 50 * 1024 * 1024;
    const encodedLength = Math.ceil(exactBytes / 3) * 4;
    const sharedBase64 = 'A'.repeat(encodedLength - 1);
    const exact = `data:image/png;base64,${sharedBase64}=`;
    const oversized = `data:image/png;base64,${sharedBase64}A`;
    const options = {
      apiKey: 'provider-key',
      baseUrl: 'https://queue.fal.run',
      protocol: 'fal' as const,
    };

    await expect(materializeImageProviderResult({ ...options, source: exact })).resolves.toBe(exact);
    const error = await materializeImageProviderResult({ ...options, source: oversized })
      .then(() => null, (value: unknown) => value);
    expect(error).toMatchObject({ code: 'provider_result_too_large', retryable: false });
    expect(isPermanentImageProviderResultError(error)).toBe(true);
  });

  it('preserves permanent Gateway result errors for the direct task state machine', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_provider_result',
    }), { status: 422 }));

    const error = await materializeImageProviderResult({
      apiKey: 'provider-key',
      baseUrl: 'https://queue.fal.run',
      protocol: 'fal',
      source: 'https://results.example/invalid.png',
      fetchImpl,
    }).then(() => null, (value: unknown) => value);

    expect(error).toMatchObject({ code: 'invalid_provider_result', retryable: false });
    expect(isPermanentImageProviderResultError(error)).toBe(true);
  });
});
