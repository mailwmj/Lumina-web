import {
  discoverImageModelsViaWeb,
  type DiscoveredWebImageModel,
} from '@/features/canvas/infrastructure/webImageApi';
import type { CustomImageProtocol } from '@/features/canvas/models/imageProviderProtocols';
import {
  discoverTextModelsViaWeb,
  type DiscoveredTextModel,
} from '@/features/canvas/infrastructure/webTextApi';

export interface ConfiguredImageModelDiscovery {
  baseUrl: string;
  apiKey: string;
  protocol?: CustomImageProtocol;
}

export async function discoverConfiguredImageModels(
  config: ConfiguredImageModelDiscovery,
): Promise<DiscoveredWebImageModel[]> {
  return await discoverImageModelsViaWeb({
    base_url: config.baseUrl,
    api_key: config.apiKey,
    ...(config.protocol ? { protocol: config.protocol } : {}),
  });
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
