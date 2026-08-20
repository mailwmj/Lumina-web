import { describe, expect, it, vi } from 'vitest';

import {
  createGenerateTextRequest,
  normalizeTextGenerationReferenceImages,
} from './textGenerationService';

describe('text generation service', () => {
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
});
