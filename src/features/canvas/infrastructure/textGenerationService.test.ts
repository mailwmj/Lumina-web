import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGenerateTextRequest,
  generateText,
  normalizeTextGenerationReferenceImages,
} from './textGenerationService';

describe('text generation service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds a generic request without prompt-polish fields', () => {
    const request = createGenerateTextRequest(
      {
        text: '原始用户文本',
        referenceImages: ['data:image/png;base64,AAAA'],
        reasoningEffort: 'high',
      },
      {
        apiKey: 'secret',
        baseUrl: 'https://gateway.example/v1',
        modelId: 'model-a',
      }
    );

    expect(request).toEqual({
      text: '原始用户文本',
      model: 'model-a',
      api_key: 'secret',
      base_url: 'https://gateway.example/v1',
      reference_images: ['data:image/png;base64,AAAA'],
      reasoning_effort: 'high',
    });
    expect(request).not.toHaveProperty('custom_prompt');
    expect(request).not.toHaveProperty('prompt_type');
  });

  it('converts every local image and fails the whole snapshot if one is unreadable', async () => {
    const convertLocal = vi.fn(async (source: string) => {
      if (source.includes('missing')) {
        throw new Error('unreadable');
      }
      return 'data:image/png;base64,LOCAL';
    });

    await expect(normalizeTextGenerationReferenceImages(
      ['/tmp/ok.png', '/tmp/missing.png'],
      convertLocal
    )).rejects.toThrow('unreadable');
    expect(convertLocal).toHaveBeenCalledTimes(2);
  });

  it('rejects text provider work explicitly while offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });

    await expect(generateText({ text: 'offline request' }, {
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelId: 'model-a',
    })).rejects.toThrow('Network access is unavailable while offline.');
  });

  it('uses the configured browser text provider path', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/generation/media' && init?.method === 'POST') {
        return new Response(JSON.stringify({
          key: 'media-00000000-0000-4000-8000-000000000001',
          url: '/api/generation/media/media-00000000-0000-4000-8000-000000000001',
          expiresAt: Date.now() + 60_000,
          contentType: 'image/png',
          sizeBytes: 3,
        }), { status: 201 });
      }
      if (url === '/api/generation/text' && init?.method === 'POST') {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'web result' } }],
        }), { status: 200 });
      }
      if (url.includes('/api/generation/media/') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateText({
      text: 'web prompt',
      referenceImages: ['data:image/png;base64,AAAA'],
    }, {
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelId: 'model-a',
    })).resolves.toBe('web result');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generation/text',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    );
    const textCall = fetchMock.mock.calls.find(([url]) => url === '/api/generation/text');
    expect(JSON.parse(String(textCall?.[1]?.body))).toMatchObject({
      operation: 'request',
      base_url: 'https://gateway.example/v1',
      reference_media_keys: ['media-00000000-0000-4000-8000-000000000001'],
    });
    expect(String(textCall?.[1]?.body)).not.toContain('AAAA');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generation/media/media-00000000-0000-4000-8000-000000000001',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
