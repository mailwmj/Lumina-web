import { describe, expect, it, vi } from 'vitest';

import type { GenerateImagePayload } from '@/features/canvas/application/ports';
import {
  buildFalImageBody,
  buildGeminiNativeImageBody,
  buildBltcyImageBody,
  buildGrsaiImageBody,
  buildKieImageBody,
  buildOpenAiCompatibleImageBody,
  buildPpioImageBody,
  buildImageGenerationRequest,
  buildRunningHubImageBody,
  discoverImageModelsViaWeb,
  pollImageGenerationViaWeb,
  resolveFhlImageSize,
  submitImageGenerationViaWeb,
} from './webImageApi';
import providerContractFixtures from './image-provider-contract-fixtures.json';

const payload: GenerateImagePayload = {
  model: 'ai-media/gpt-image-2',
  prompt: 'a red kite',
  size: '4K',
  aspectRatio: '4:3',
  referenceImages: [],
  extraParams: { custom: true },
};

describe('web image provider contracts', () => {
  it('maps AI Media, OpenAI-compatible, Chaomo, and FHL request fields', () => {
    expect(buildOpenAiCompatibleImageBody(payload, 'openai-images'))
      .toEqual(providerContractFixtures.requestBodies.openai);
    expect(buildOpenAiCompatibleImageBody({ ...payload, model: 'openai/vendor/model' }, 'openai-images'))
      .toMatchObject({ model: 'vendor/model', size: '1536x1024', quality: 'high' });
    expect(buildOpenAiCompatibleImageBody({ ...payload, model: 'chaomo/gpt-image2-4K-Direct' }, 'openai-images'))
      .toMatchObject({ model: 'gpt-image2-4K-Direct', ratio: '4:3', response_format: 'url', async: true, quality: 'medium' });
    expect(buildOpenAiCompatibleImageBody({ ...payload, model: 'fhl/gpt-image-2' }, 'fhl-images'))
      .toMatchObject({ model: 'gpt-image-2', size: '3840x2880', quality: 'auto', output_format: 'png', response_format: 'b64_json' });
    expect(resolveFhlImageSize('4K', '16:9')).toBe('3840x2160');
  });

  it('keeps provider-specific contract shapes and ordered inputs', () => {
    expect(buildGeminiNativeImageBody({ ...payload, model: 'gemini/gemini-3-pro-image-preview' }, [
      { mimeType: 'image/png', data: 'ONE' },
      { mimeType: 'image/jpeg', data: 'TWO' },
    ])).toEqual(providerContractFixtures.requestBodies.gemini);
    expect(buildFalImageBody({ ...payload, model: 'fal/nano-banana-pro', referenceImages: ['ONE'] })).toMatchObject({
      ...providerContractFixtures.requestBodies.fal,
    });
    expect(buildFalImageBody({ ...payload, model: 'fal/nano-banana-2', extraParams: { thinking_level: 'off' } }).input)
      .not.toHaveProperty('thinking_level');
    expect(buildGrsaiImageBody({ ...payload, model: 'grsai/nano-banana-pro', referenceImages: ['ONE'] })).toMatchObject({
      model: 'nano-banana-pro', urls: ['ONE'], aspectRatio: '4:3', imageSize: '4K',
    });
    expect(buildKieImageBody({ ...payload, model: 'kie/nano-banana-2', referenceImages: ['ONE'] })).toMatchObject({
      model: 'nano-banana-2', input: { image_input: ['ONE'], aspect_ratio: '4:3', resolution: '4K' },
    });
    expect(buildRunningHubImageBody({ ...payload, model: 'runninghub/rhart-image-n-g31-flash', referenceImages: ['ONE'] })).toEqual({
      prompt: 'a red kite', aspectRatio: '4:3', resolution: '4k', imageUrls: ['ONE'],
    });
    expect(buildBltcyImageBody({ ...payload, model: 'bltcy/nano-banana', referenceImages: [] }))
      .toMatchObject(providerContractFixtures.requestBodies.bltcy);
    expect(buildPpioImageBody({ ...payload, model: 'ppio/gemini-3.1-flash', referenceImages: ['ONE'] }))
      .toEqual(providerContractFixtures.requestBodies.ppio);
  });

  it('discovers OpenAI and Gemini catalogs with native headers and fallback', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'model-a', name: 'Model A' }, { id: 'model-a' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gemini-3-pro-image-preview' }] })));
    await expect(discoverImageModelsViaWeb({ base_url: 'https://gateway.example/v1', api_key: 'key' }, { fetchImpl }))
      .resolves.toEqual([{ id: 'model-a', label: 'Model A' }]);
    await expect(discoverImageModelsViaWeb({ base_url: 'https://gateway.example/v1beta', api_key: 'key', protocol: 'gemini-native' }, { fetchImpl }))
      .resolves.toEqual([{ id: 'gemini-3-pro-image-preview' }]);
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual({ headers: { 'x-goog-api-key': 'key' } });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('https://gateway.example/v1/models');
  });

  it('discovers Chaomo models through the same-origin Gateway', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'gpt-image2-4K' }],
    })));

    await expect(discoverImageModelsViaWeb({
      base_url: 'https://www.chaomoapi.com/v1',
      api_key: 'chaomo-key',
      gateway_provider: 'chaomo',
    }, { fetchImpl })).resolves.toEqual([{ id: 'gpt-image2-4K' }]);

    expect(fetchImpl).toHaveBeenCalledWith('/api/generation/providers/chaomo/models', {
      credentials: 'same-origin',
      headers: { authorization: 'Bearer chaomo-key' },
    });
  });

  it('registers a custom OpenAI-compatible provider before same-origin model discovery', async () => {
    const provider = 'custom-openai:tenant-a';
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'vendor-image-v1', display_name: 'Vendor Image' }],
      })));

    await expect(discoverImageModelsViaWeb({
      base_url: 'https://custom.example/v1',
      api_key: 'custom-key',
      protocol: 'openai-images',
      gateway_provider: provider,
    }, { fetchImpl })).resolves.toEqual([{ id: 'vendor-image-v1', label: 'Vendor Image' }]);

    expect(fetchImpl.mock.calls).toEqual([
      ['/api/generation/providers/custom', expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({ authorization: 'Bearer custom-key' }),
        body: JSON.stringify({
          operation: 'register',
          provider: { id: provider, base_url: 'https://custom.example/v1', protocol: 'openai-images' },
        }),
      })],
      [`/api/generation/providers/models?provider=${encodeURIComponent(provider)}`, expect.objectContaining({
        credentials: 'same-origin',
        headers: { authorization: 'Bearer custom-key' },
      })],
    ]);
  });

  it('fails the complete request when any local reference cannot be read', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new Blob(['image'], { type: 'image/png' })))
      .mockRejectedValueOnce(new TypeError('blocked'));
    await expect(submitImageGenerationViaWeb({ ...payload, model: 'openai/vendor/model', referenceImages: ['blob:one', 'blob:two'] }, {
      apiKey: 'key', baseUrl: 'https://gateway.example/v1', protocol: 'openai-images',
    }, { fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('parses baseline async response contracts for dedicated providers', async () => {
    const cases = [
      {
        protocol: 'fhl-images' as const,
        model: 'fhl/gpt-image-2',
        fixture: providerContractFixtures['fhl-images'],
      },
      {
        protocol: 'grsai' as const,
        model: 'grsai/nano-banana-2',
        fixture: providerContractFixtures.grsai,
      },
      {
        protocol: 'kie' as const,
        model: 'kie/nano-banana-2',
        fixture: providerContractFixtures.kie,
      },
      {
        protocol: 'runninghub' as const,
        model: 'runninghub/rhart-image-v1',
        fixture: providerContractFixtures.runninghub,
      },
    ];

    for (const item of cases) {
      const fetchImpl = vi.fn<typeof fetch>();
      fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(item.fixture.submitted), { status: 200 }));
      fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(item.fixture.status), { status: 200 }));
      if ('result' in item.fixture) {
        fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(item.fixture.result), { status: 200 }));
      }
      const submission = await submitImageGenerationViaWeb({ ...payload, model: item.model, providerId: item.protocol }, {
        apiKey: 'key', baseUrl: item.protocol === 'fhl-images' ? 'https://fhl' : `https://${item.protocol}.example`, protocol: item.protocol,
      }, { fetchImpl });
      expect(submission.status).toBe('running');
      const handle = submission.status === 'running' ? submission.handle : undefined;
      const polled = await pollImageGenerationViaWeb(handle!, 'key', { fetchImpl });
      expect(polled).toEqual({ status: 'succeeded', source: item.fixture.expected });
    }
  });

  it('uses provider auth and same-origin polling URLs', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'fal-1', status_url: 'https://evil.example/status' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }));
    const submission = await submitImageGenerationViaWeb({ ...payload, model: 'fal/nano-banana-2', providerId: 'fal' }, {
      apiKey: 'key', baseUrl: 'https://queue.fal.run', protocol: 'fal',
    }, { fetchImpl });
    const handle = submission.status === 'running' ? submission.handle : undefined;
    await pollImageGenerationViaWeb(handle!, 'key', { fetchImpl });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ headers: { authorization: 'Key key' } });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-1/status');
  });

  it('rejects a credential-like upstream task ID before it can become a browser task handle', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      task_id: 'https://queue.fal.run/tasks/42?access_token=provider-secret',
    }), { status: 202 }));

    await expect(submitImageGenerationViaWeb({ ...payload, model: 'fal/nano-banana-2', providerId: 'fal' }, {
      apiKey: 'key', baseUrl: 'https://queue.fal.run', protocol: 'fal',
    }, { fetchImpl })).rejects.toThrow();
  });

  it('returns a sanitized provider failure and request ID from task polling', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      request_id: 'req-provider-42',
      error: {
        message: 'Rejected Bearer provider-secret',
        api_key: 'provider-secret',
      },
    }), { status: 429 }));

    const result = await pollImageGenerationViaWeb({
      externalTaskId: 'provider-task-42',
      protocol: 'fal',
      baseUrl: 'https://queue.fal.run',
      model: 'fal/nano-banana-2',
    }, 'provider-secret', { fetchImpl });

    expect(result).toMatchObject({
      status: 'failed',
      error: 'Rejected Bearer [REDACTED]',
      requestId: 'req-provider-42',
      retryable: true,
    });
    expect(result.status === 'failed' && result.errorDetails).toBe('Provider request failed with HTTP 429.');
    expect(result.status === 'failed' && result.errorDetails).not.toContain('provider-secret');
  });

  it('uploads KIE references before creating the ordered task', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { downloadUrl: 'https://cdn/ref-1.png' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: { taskId: 'kie-1' } }), { status: 200 }));
    const request = await buildImageGenerationRequest({ ...payload, model: 'kie/nano-banana-2', providerId: 'kie', referenceImages: ['data:image/png;base64,ONE'] }, {
      apiKey: 'key', baseUrl: 'https://api.kie.ai', protocol: 'kie',
    }, { fetchImpl });
    expect(JSON.parse(String(request.body))).toMatchObject({ input: { image_input: ['https://cdn/ref-1.png'] } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://kieai.redpandaai.co/api/file-stream-upload');
  });

  it('sanitizes KIE reference upload failures and exposes the request ID', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      request_id: 'req-kie-upload-1',
      error: { message: 'Upload rejected Bearer kie-secret' },
    }), { status: 403 }));

    await expect(buildImageGenerationRequest({
      ...payload,
      model: 'kie/nano-banana-2',
      providerId: 'kie',
      referenceImages: ['data:image/png;base64,ONE'],
    }, {
      apiKey: 'kie-secret', baseUrl: 'https://api.kie.ai', protocol: 'kie',
    }, { fetchImpl })).rejects.toMatchObject({
      name: 'GenerationProviderError',
      message: 'Upload rejected Bearer [REDACTED]',
      details: 'Provider request failed with HTTP 403.',
      requestId: 'req-kie-upload-1',
    });
  });

  it('uploads local RunningHub references and preserves remote order', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { download_url: 'https://cdn/local.png' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { download_url: 'https://cdn/remote.png' } }), { status: 200 }));
    const request = await buildImageGenerationRequest({
      ...payload,
      model: 'runninghub/rhart-image-v1',
      providerId: 'runninghub',
      referenceImages: ['data:image/png;base64,ONE', 'data:image/png;base64,TWO'],
    }, {
      apiKey: 'key', baseUrl: 'https://www.runninghub.cn/openapi/v2', protocol: 'runninghub',
    }, { fetchImpl });
    expect(JSON.parse(String(request.body))).toMatchObject({ imageUrls: ['https://cdn/local.png', 'https://cdn/remote.png'] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sanitizes RunningHub reference upload failures and exposes the request ID', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      requestId: 'req-runninghub-upload-1',
      message: 'Upload rejected Bearer runninghub-secret',
    }), { status: 429 }));

    await expect(buildImageGenerationRequest({
      ...payload,
      model: 'runninghub/rhart-image-v1',
      providerId: 'runninghub',
      referenceImages: ['data:image/png;base64,ONE'],
    }, {
      apiKey: 'runninghub-secret',
      baseUrl: 'https://www.runninghub.cn/openapi/v2',
      protocol: 'runninghub',
    }, { fetchImpl })).rejects.toMatchObject({
      name: 'GenerationProviderError',
      message: 'Upload rejected Bearer [REDACTED]',
      details: 'Provider request failed with HTTP 429.',
      requestId: 'req-runninghub-upload-1',
    });
  });

  it('accepts PPIO synchronous image_urls responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ image_urls: ['https://cdn/ppio.png'] }), { status: 200 })
    );
    await expect(submitImageGenerationViaWeb({ ...payload, model: 'ppio/gemini-3.1-flash', providerId: 'ppio' }, {
      apiKey: 'key', baseUrl: 'https://api.ppio.com', protocol: 'ppio',
    }, { fetchImpl })).resolves.toEqual({ status: 'succeeded', source: 'https://cdn/ppio.png' });
  });
});
