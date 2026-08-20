import { describe, expect, it } from 'vitest';

import type { ImageModelSettings } from './availableModels';
import {
  listConfiguredImageModels,
  resolveConfiguredImageModel,
} from './availableModels';

function createSettings(): ImageModelSettings {
  return {
    customImageApis: [],
    openAiImageApi: {
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      modelCatalog: {
        models: [
          { id: 'ai-media/gpt-image-2' },
          { id: 'ai-media/custom-image-model', label: 'Custom Image' },
        ],
        refreshedAt: 1,
      },
      selectedModelIds: ['ai-media/custom-image-model'],
    },
    chaomoImageApi: {
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      modelCatalog: {
        models: [{ id: 'chaomo/gpt-image2-4K' }],
        refreshedAt: 1,
      },
      selectedModelIds: ['chaomo/gpt-image2-4K'],
    },
    lastImageModelSelection: {
      providerId: 'chaomo',
      modelId: 'chaomo/gpt-image2-4K',
    },
  };
}

describe('available image models', () => {
  it('only exposes models selected in provider settings', () => {
    expect(listConfiguredImageModels(createSettings()).map((model) => model.id)).toEqual([
      'ai-media/custom-image-model',
      'chaomo/gpt-image2-4K',
    ]);
  });

  it('uses the last selection when a new or previously selected model is unavailable', () => {
    const settings = createSettings();

    expect(resolveConfiguredImageModel(settings, undefined)?.id).toBe('chaomo/gpt-image2-4K');
    expect(resolveConfiguredImageModel(settings, 'ai-media/gpt-image-2')?.id).toBe(
      'chaomo/gpt-image2-4K'
    );
  });

  it('falls back to Chaomo when it is the only configured provider', () => {
    const settings = createSettings();
    settings.openAiImageApi = {
      apiKey: '',
      baseUrl: 'https://example.test/v1',
      modelCatalog: null,
      selectedModelIds: [],
    };

    expect(resolveConfiguredImageModel(settings, 'ai-media/gpt-image-2')?.id).toBe(
      'chaomo/gpt-image2-4K'
    );
  });

  it('exposes built-in Chaomo models when only its API key is configured', () => {
    const settings = createSettings();
    settings.openAiImageApi = {
      apiKey: '',
      baseUrl: 'https://example.test/v1',
      modelCatalog: null,
      selectedModelIds: [],
    };
    settings.chaomoImageApi = {
      apiKey: 'chaomo-key',
      baseUrl: 'https://example.test/v1',
      modelCatalog: null,
      selectedModelIds: [],
    };

    const models = listConfiguredImageModels(settings);

    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.providerId === 'chaomo')).toBe(true);
    expect(models.some((model) => model.id === 'chaomo/gpt-image2-4K')).toBe(true);
    expect(resolveConfiguredImageModel(settings, 'ai-media/gpt-image-2')?.providerId).toBe(
      'chaomo'
    );
  });

  it('keeps a custom provider identity while routing its remote model through OpenAI', () => {
    const settings = createSettings();
    settings.openAiImageApi.apiKey = '';
    settings.chaomoImageApi.apiKey = '';
    settings.customImageApis = [{
      id: 'custom-openai:internal',
      name: 'Internal Gateway',
      protocol: 'openai-images',
      apiKey: 'custom-key',
      baseUrl: 'https://gateway.example/v1',
      modelCatalog: {
        models: [{ id: 'custom-openai:internal/vendor/image-model' }],
        refreshedAt: 1,
      },
      selectedModelIds: ['custom-openai:internal/vendor/image-model'],
    }];

    const [model] = listConfiguredImageModels(settings);

    expect(model.providerId).toBe('custom-openai:internal');
    expect(model.providerName).toBe('Internal Gateway');
    expect(model.resolveRequest({ referenceImageCount: 0 }).requestModel).toBe(
      'openai/vendor/image-model'
    );
  });

  it('routes Gemini Native models through the Gemini adapter and normalizes model resource names', () => {
    const settings = createSettings();
    settings.openAiImageApi.apiKey = '';
    settings.chaomoImageApi.apiKey = '';
    settings.customImageApis = [{
      id: 'custom-openai:gemini',
      name: 'Gemini Gateway',
      protocol: 'gemini-native',
      apiKey: 'custom-key',
      baseUrl: 'https://gateway.example/v1beta',
      modelCatalog: {
        models: [{ id: 'custom-openai:gemini/gemini-3-pro-image-preview' }],
        refreshedAt: 1,
      },
      selectedModelIds: ['custom-openai:gemini/gemini-3-pro-image-preview'],
    }];

    const [model] = listConfiguredImageModels(settings);

    expect(model.resolveRequest({ referenceImageCount: 1 }).requestModel).toBe(
      'gemini/gemini-3-pro-image-preview'
    );
  });

  it('routes FHL Images models through the dedicated FHL adapter', () => {
    const settings = createSettings();
    settings.openAiImageApi.apiKey = '';
    settings.chaomoImageApi.apiKey = '';
    settings.customImageApis = [{
      id: 'custom-openai:fhl',
      name: 'FHL',
      protocol: 'fhl-images',
      apiKey: 'custom-key',
      baseUrl: 'https://www.fhl.mom',
      modelCatalog: {
        models: [{ id: 'custom-openai:fhl/gpt-image-2' }],
        refreshedAt: 1,
      },
      selectedModelIds: ['custom-openai:fhl/gpt-image-2'],
    }];

    const [model] = listConfiguredImageModels(settings);

    expect(model.resolveRequest({ referenceImageCount: 0 }).requestModel).toBe(
      'fhl/gpt-image-2'
    );
  });

  it('does not silently fall back when a configured custom model is unavailable', () => {
    const settings = createSettings();
    settings.customImageApis = [{
      id: 'custom-openai:gemini',
      name: 'Gemini Gateway',
      protocol: 'gemini-native',
      apiKey: 'custom-key',
      baseUrl: 'https://gateway.example/v1beta',
      modelCatalog: {
        models: [{ id: 'custom-openai:gemini/gemini-3-pro-image-preview' }],
        refreshedAt: 1,
      },
      selectedModelIds: ['custom-openai:gemini/gemini-3-pro-image-preview'],
    }];

    expect(resolveConfiguredImageModel(
      settings,
      'custom-openai:gemini/previous-openai-model'
    )).toBeNull();
  });
});
