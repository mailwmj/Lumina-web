import { afterEach, describe, expect, it, vi } from 'vitest';

import { polishText } from './textPolishService';

describe('text polish service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects provider work explicitly while offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });

    await expect(polishText({ text: 'offline request' }, {
      id: 'text-api-1',
      name: 'Test provider',
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelId: 'model-a',
      modelCatalog: null,
      selectedModelIds: [],
      enabled: true,
    })).rejects.toThrow('Network access is unavailable while offline.');
  });

  it('uses the browser text provider path for prompt polishing', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'polished prompt' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(polishText({
      text: 'raw prompt',
      customPrompt: 'Keep the meaning.',
      promptType: 'text',
      reasoningEffort: 'high',
    }, {
      id: 'text-api-1',
      name: 'Test provider',
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelId: 'model-a',
      modelCatalog: null,
      selectedModelIds: ['model-a'],
      enabled: true,
    })).resolves.toEqual({ polished: 'polished prompt' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generation/text',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    );
  });
});
