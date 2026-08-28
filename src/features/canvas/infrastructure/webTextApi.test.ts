import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextApiConfig } from '@/stores/settingsStore';
import i18n from '@/i18n';
import { useLogStore } from '@/lib/logger';
import {
  buildTextGenerationRequest,
  buildTextPolishRequest,
  discoverTextModelsViaWeb,
  generateTextViaWeb,
  polishTextViaWeb,
  resolveChatCompletionsEndpoint,
  resolveModelsEndpoint,
  resolveResponsesEndpoint,
  testTextApiViaWeb,
} from './webTextApi';

function api(overrides: Partial<TextApiConfig> = {}): TextApiConfig {
  return {
    id: 'text-api',
    name: 'Text API',
    apiKey: 'secret',
    baseUrl: 'https://gateway.example/v1',
    modelId: 'model-a',
    modelCatalog: null,
    selectedModelIds: ['model-a'],
    enabled: true,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('web text API adapter', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves model and text endpoints for the configured provider', () => {
    expect(resolveModelsEndpoint('https://gateway.example/v1')).toBe(
      'https://gateway.example/v1/models'
    );
    expect(resolveChatCompletionsEndpoint('https://gateway.example')).toBe(
      'https://gateway.example/v1/chat/completions'
    );
    expect(resolveChatCompletionsEndpoint('https://ark.example/api/coding')).toBe(
      'https://ark.example/api/coding/v3/chat/completions'
    );
    expect(resolveResponsesEndpoint('https://gateway.example/api/v3')).toBe(
      'https://gateway.example/api/v3/responses'
    );
  });

  it('builds ordered multimodal chat and responses requests', () => {
    const payload = {
      text: 'describe the references',
      referenceImages: ['data:image/png;base64,ONE', 'https://images.example/two.png'],
      reasoningEffort: 'high' as const,
    };

    expect(buildTextGenerationRequest(payload, api())).toEqual({
      endpoint: 'https://gateway.example/v1/chat/completions',
      body: {
        model: 'model-a',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '图片 1：' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,ONE' } },
            { type: 'text', text: '图片 2：' },
            { type: 'image_url', image_url: { url: 'https://images.example/two.png' } },
            { type: 'text', text: 'describe the references' },
          ],
        }],
        stream: false,
        reasoning_effort: 'high',
      },
    });

    expect(buildTextGenerationRequest(payload, api({ baseUrl: 'https://gateway.example/api/v3' }))).toEqual({
      endpoint: 'https://gateway.example/api/v3/responses',
      body: {
        model: 'model-a',
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: '图片 1：' },
            { type: 'input_image', image_url: 'data:image/png;base64,ONE' },
            { type: 'input_text', text: '图片 2：' },
            { type: 'input_image', image_url: 'https://images.example/two.png' },
            { type: 'input_text', text: 'describe the references' },
          ],
        }],
        reasoning: { effort: 'high' },
      },
    });
  });

  it('discovers models, tests an API, and extracts chat or responses text', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-a' },
        'model-b',
      ] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'hello' } }] }))
      .mockResolvedValueOnce(jsonResponse({ output_text: 'response text' }));

    await expect(discoverTextModelsViaWeb({
      base_url: 'https://gateway.example/v1',
      api_key: 'secret',
    }, { fetchImpl })).resolves.toEqual([
      { id: 'model-a', label: 'Model A' },
      { id: 'model-b' },
    ]);

    await expect(testTextApiViaWeb(api(), { fetchImpl })).resolves.toEqual({
      success: true,
      message: '文本 API 连接成功！测试回复：hello',
    });
    await expect(generateTextViaWeb({ text: 'prompt' }, api({ baseUrl: 'https://gateway.example/api/v3' }), { fetchImpl }))
      .resolves.toBe('response text');

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/generation/text',
      '/api/generation/text',
      '/api/generation/text',
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).operation)).toEqual([
      'models',
      'request',
      'request',
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.credentials).toBe('same-origin');
    }
  });

  it('publishes ordered text references without putting image data in the request JSON', async () => {
    const textRequests: Array<Record<string, unknown>> = [];
    const released: string[] = [];
    let uploadIndex = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/generation/media' && init?.method === 'POST') {
        uploadIndex += 1;
        const key = `media-00000000-0000-4000-8000-${String(uploadIndex).padStart(12, '0')}`;
        return jsonResponse({
          key,
          url: `https://lumina.test/api/generation/media/${key}`,
          expiresAt: Date.now() + 60_000,
          contentType: 'image/png',
          sizeBytes: (init.body as Blob).size,
        }, 201);
      }
      if (url === '/api/generation/text' && init?.method === 'POST') {
        textRequests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ choices: [{ message: { content: 'described' } }] });
      }
      if (url.startsWith('/api/generation/media/') && init?.method === 'DELETE') {
        released.push(url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });

    await expect(generateTextViaWeb({
      text: 'describe in order',
      referenceImages: [
        'data:image/png;base64,AQID',
        'data:image/png;base64,BAUG',
      ],
    }, api(), { fetchImpl })).resolves.toBe('described');

    expect(textRequests).toHaveLength(1);
    expect(textRequests[0]).toMatchObject({
      operation: 'request',
      base_url: 'https://gateway.example/v1',
      protocol: 'chat',
      reference_media_keys: [
        'media-00000000-0000-4000-8000-000000000001',
        'media-00000000-0000-4000-8000-000000000002',
      ],
      request: {
        messages: [{
          content: [
            { type: 'text', text: '图片 1：' },
            { type: 'image_url', image_url: { url: 'lumina-media:0' } },
            { type: 'text', text: '图片 2：' },
            { type: 'image_url', image_url: { url: 'lumina-media:1' } },
            { type: 'text', text: 'describe in order' },
          ],
        }],
      },
    });
    expect(JSON.stringify(textRequests[0])).not.toContain('data:image');
    expect(released).toEqual([
      '/api/generation/media/media-00000000-0000-4000-8000-000000000001',
      '/api/generation/media/media-00000000-0000-4000-8000-000000000002',
    ]);
  });

  it('does not discover models while offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(discoverTextModelsViaWeb({
      base_url: 'https://gateway.example/v1',
      api_key: 'secret',
    }, { fetchImpl })).rejects.toThrow('Network access is unavailable while offline.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('extracts text from the canonical Responses message output shape', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'canonical response' }],
      }],
    }));

    await expect(generateTextViaWeb(
      { text: 'prompt' },
      api({ baseUrl: 'https://gateway.example/api/v3' }),
      { fetchImpl },
    )).resolves.toBe('canonical response');
  });

  it('keeps polish templates, image order, and reasoning effort in the request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'polished' } }] })
    );

    expect(buildTextPolishRequest({
      text: 'raw prompt',
      referenceImages: ['data:image/png;base64,ONE'],
      customPrompt: 'Keep the meaning.',
      promptType: 'text',
      reasoningEffort: 'minimal',
    }, api())).toEqual({
      endpoint: 'https://gateway.example/v1/chat/completions',
      body: {
        model: 'model-a',
        messages: [
          { role: 'system', content: 'Keep the meaning.' },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,ONE' } },
            { type: 'text', text: '请根据参考图片润色这个提示词：raw prompt\n\n参考图片已提供。' },
          ] },
        ],
        stream: false,
        reasoning_effort: 'minimal',
      },
    });

    await expect(polishTextViaWeb({ text: 'raw prompt' }, api(), { fetchImpl }))
      .resolves.toEqual({ polished: 'polished' });
  });

  it('keeps video polish metadata aligned with the fixed-parameter prefix', () => {
    const request = buildTextPolishRequest({
      text: 'scene',
      promptType: 'video',
      videoDuration: '8',
      videoResolution: '720p',
      videoAspectRatio: '16:9',
      videoShotType: '特写',
      videoCameraMovement: '推镜',
      isVideoFrame: true,
    }, api({ baseUrl: 'https://gateway.example/api/v3' }));
    const text = String((request.body.input as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text);

    expect(text).toContain('- 时长：8秒');
    expect(text).toContain('- 分辨率：720p');
    expect(text).toContain('- 画面宽高比：16:9');
    expect(text).toContain('- 模式：首尾帧视频（图1为首帧，图2为尾帧）');
    expect(text).not.toContain('- 景别：特写');
    expect(text).not.toContain('- 运镜方式：推镜');
  });

  it('rejects empty provider responses instead of returning a result', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '   ' } }] })
    );

    await expect(generateTextViaWeb({ text: 'prompt' }, api(), { fetchImpl }))
      .rejects.toThrow('API 返回内容为空');
  });

  it('correlates text generation failures without logging text, keys, or provider URLs', async () => {
    useLogStore.getState().clearBuffer();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: 'provider_unavailable',
      message: 'The text provider is unavailable.',
      request_id: 'gateway-text-42',
    }), {
      status: 503,
      headers: { 'x-request-id': 'gateway-text-42' },
    }));

    await expect(generateTextViaWeb(
      { text: 'diagnostic-secret-text' },
      api({ apiKey: 'diagnostic-secret-key' }),
      { fetchImpl },
    )).rejects.toMatchObject({
      code: 'provider_unavailable',
      gatewayRequestId: 'gateway-text-42',
      status: 503,
    });

    const entries = useLogStore.getState().snapshot()
      .filter((entry) => entry.target === 'generation.gateway');
    expect(entries.some((entry) => entry.message === 'Text generation failed'
      && entry.fields.gatewayRequestId === 'gateway-text-42')).toBe(true);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('diagnostic-secret-text');
    expect(serialized).not.toContain('diagnostic-secret-key');
    expect(serialized).not.toContain('https://gateway.example');
    useLogStore.getState().clearBuffer();
  });

  it('validates the text input and product image limit before the request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(generateTextViaWeb({ text: '' }, api(), { fetchImpl }))
      .rejects.toThrow('请输入文本或连接图片');
    await expect(generateTextViaWeb({
      text: 'prompt',
      referenceImages: Array.from({ length: 11 }, () => 'data:image/png;base64,AAAA'),
    }, api(), { fetchImpl })).rejects.toThrow('最多支持 10 张');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
