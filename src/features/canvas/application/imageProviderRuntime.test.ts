import { describe, expect, it } from 'vitest';

import { resolveImageProviderRuntime } from './imageProviderRuntime';

const settings = {
  openAiImageApi: {
    apiKey: 'ai-media-key',
    baseUrl: 'https://ai-media.example/v1',
    modelCatalog: null,
    selectedModelIds: [],
  },
  chaomoImageApi: {
    apiKey: 'chaomo-key',
    baseUrl: 'https://chaomo.example/v1',
    modelCatalog: null,
    selectedModelIds: [],
  },
  customImageApis: [{
    id: 'custom-openai:internal' as const,
    name: 'Internal Gateway',
    protocol: 'openai-images' as const,
    apiKey: 'custom-key',
    baseUrl: 'https://gateway.example/v1',
    modelCatalog: null,
    selectedModelIds: [],
  }],
};

describe('image provider runtime', () => {
  it('preserves the dedicated runtime for built-in providers', () => {
    expect(resolveImageProviderRuntime('ai-media', settings)).toEqual({
      apiKey: 'ai-media-key',
      backendProviderId: 'ai-media',
      providerConfig: { base_url: 'https://ai-media.example/v1' },
    });
    expect(resolveImageProviderRuntime('chaomo', settings)).toEqual({
      apiKey: 'chaomo-key',
      backendProviderId: 'chaomo',
      providerConfig: { base_url: 'https://chaomo.example/v1' },
    });
  });

  it('routes custom providers through the standard OpenAI backend', () => {
    expect(resolveImageProviderRuntime('custom-openai:internal', settings)).toEqual({
      apiKey: 'custom-key',
      backendProviderId: 'openai',
      providerConfig: {
        base_url: 'https://gateway.example/v1',
        api_key: 'custom-key',
      },
    });
  });

  it('routes Gemini Native custom providers through the Gemini backend', () => {
    const geminiSettings = {
      ...settings,
      customImageApis: [{
        ...settings.customImageApis[0],
        protocol: 'gemini-native' as const,
        baseUrl: 'https://gateway.example/v1beta',
      }],
    };

    expect(resolveImageProviderRuntime('custom-openai:internal', geminiSettings)).toEqual({
      apiKey: 'custom-key',
      backendProviderId: 'gemini',
      providerConfig: {
        base_url: 'https://gateway.example/v1beta',
        api_key: 'custom-key',
      },
    });
  });

  it('routes FHL custom providers through the dedicated FHL backend', () => {
    const fhlSettings = {
      ...settings,
      customImageApis: [{
        ...settings.customImageApis[0],
        protocol: 'fhl-images' as const,
        baseUrl: 'https://www.fhl.mom',
      }],
    };

    expect(resolveImageProviderRuntime('custom-openai:internal', fhlSettings)).toEqual({
      apiKey: 'custom-key',
      backendProviderId: 'fhl',
      providerConfig: {
        base_url: 'https://www.fhl.mom',
        api_key: 'custom-key',
      },
    });
  });
});
