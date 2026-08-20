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
});
