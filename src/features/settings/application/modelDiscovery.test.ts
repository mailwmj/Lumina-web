import { beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverImageModelsViaWeb } from '@/features/canvas/infrastructure/webImageApi';
import { discoverTextModelsViaWeb } from '@/features/canvas/infrastructure/webTextApi';
import { createImageProviderGatewayFetch } from '@/features/canvas/infrastructure/imageProviderGatewayFetch';
import {
  discoverConfiguredImageModels,
  discoverConfiguredTextModels,
} from './modelDiscovery';

vi.mock('@/features/canvas/infrastructure/webImageApi', () => ({
  discoverImageModelsViaWeb: vi.fn(),
}));

vi.mock('@/features/canvas/infrastructure/webTextApi', () => ({
  discoverTextModelsViaWeb: vi.fn(),
}));

vi.mock('@/features/canvas/infrastructure/imageProviderGatewayFetch', () => ({
  createImageProviderGatewayFetch: vi.fn(),
}));

describe('model discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes configured image model discovery through the Web adapter', async () => {
    const providerFetch = vi.fn<typeof fetch>();
    vi.mocked(createImageProviderGatewayFetch).mockReturnValue(providerFetch);
    vi.mocked(discoverImageModelsViaWeb).mockResolvedValue([{ id: 'image-model' }]);

    await expect(discoverConfiguredImageModels({
      baseUrl: 'https://images.example/v1',
      apiKey: 'image-key',
      protocol: 'gemini-native',
    })).resolves.toEqual([{ id: 'image-model' }]);

    expect(createImageProviderGatewayFetch).toHaveBeenCalledWith({
      apiKey: 'image-key',
      baseUrl: 'https://images.example/v1',
      protocol: 'gemini-native',
    });
    expect(discoverImageModelsViaWeb).toHaveBeenCalledWith({
      base_url: 'https://images.example/v1',
      api_key: 'image-key',
      protocol: 'gemini-native',
    }, { fetchImpl: providerFetch });
  });

  it('keeps managed image model discovery on its existing same-origin route', async () => {
    vi.mocked(discoverImageModelsViaWeb).mockResolvedValue([{ id: 'managed-model' }]);

    await expect(discoverConfiguredImageModels({
      baseUrl: 'https://www.chaomoapi.com/v1',
      apiKey: 'chaomo-key',
      protocol: 'openai-images',
      gatewayProvider: 'chaomo',
    })).resolves.toEqual([{ id: 'managed-model' }]);

    expect(createImageProviderGatewayFetch).not.toHaveBeenCalled();
    expect(discoverImageModelsViaWeb).toHaveBeenCalledWith({
      base_url: 'https://www.chaomoapi.com/v1',
      api_key: 'chaomo-key',
      protocol: 'openai-images',
      gateway_provider: 'chaomo',
    });
  });

  it('routes configured text model discovery through the Web adapter', async () => {
    vi.mocked(discoverTextModelsViaWeb).mockResolvedValue([{ id: 'text-model' }]);

    await expect(discoverConfiguredTextModels({
      baseUrl: 'https://text.example/v1',
      apiKey: 'text-key',
    })).resolves.toEqual([{ id: 'text-model' }]);

    expect(discoverTextModelsViaWeb).toHaveBeenCalledWith({
      base_url: 'https://text.example/v1',
      api_key: 'text-key',
    });
  });
});
