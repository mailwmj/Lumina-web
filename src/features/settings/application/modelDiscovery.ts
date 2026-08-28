import {
  discoverImageModelsViaWeb,
  type DiscoveredWebImageModel,
} from '@/features/canvas/infrastructure/webImageApi';
import type { CustomImageProtocol } from '@/features/canvas/models/imageProviderProtocols';
import { createImageProviderGatewayFetch } from '@/features/canvas/infrastructure/imageProviderGatewayFetch';
import {
  discoverTextModelsViaWeb,
  type DiscoveredTextModel,
} from '@/features/canvas/infrastructure/webTextApi';

export interface ConfiguredImageModelDiscovery {
  baseUrl: string;
  apiKey: string;
  protocol?: CustomImageProtocol;
  gatewayProvider?: string;
}

export async function discoverConfiguredImageModels(
  config: ConfiguredImageModelDiscovery,
): Promise<DiscoveredWebImageModel[]> {
  const request = {
    base_url: config.baseUrl,
    api_key: config.apiKey,
    ...(config.protocol ? { protocol: config.protocol } : {}),
    ...(config.gatewayProvider ? { gateway_provider: config.gatewayProvider } : {}),
  };
  if (config.gatewayProvider) {
    return await discoverImageModelsViaWeb(request);
  }
  const fetchImpl = createImageProviderGatewayFetch({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    protocol: config.protocol ?? 'openai-images',
  });
  return await discoverImageModelsViaWeb(request, { fetchImpl });
}

export interface ConfiguredTextModelDiscovery {
  baseUrl: string;
  apiKey: string;
}

export async function discoverConfiguredTextModels(
  config: ConfiguredTextModelDiscovery,
): Promise<DiscoveredTextModel[]> {
  return await discoverTextModelsViaWeb({
    base_url: config.baseUrl,
    api_key: config.apiKey,
  });
}
