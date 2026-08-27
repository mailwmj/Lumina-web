import type {
  ChaomoImageApiConfig,
  CustomImageApiConfig,
  AdditionalImageApiConfig,
  OpenAiImageApiConfig,
} from '@/stores/settingsStore';
import {
  AI_MEDIA_IMAGE_PROVIDER_ID,
  CHAOMO_IMAGE_PROVIDER_ID,
  OPENAI_IMAGE_PROVIDER_ID,
} from '@/features/canvas/models/providers/openai';
import { getCustomImageProtocolDefinition } from '@/features/canvas/models/imageProviderProtocols';

interface ImageProviderSettings {
  openAiImageApi: OpenAiImageApiConfig;
  chaomoImageApi: ChaomoImageApiConfig;
  customImageApis: CustomImageApiConfig[];
  additionalImageApis?: AdditionalImageApiConfig[];
}

export interface ImageProviderRuntime {
  apiKey: string;
  backendProviderId: string;
  providerConfig: Record<string, string>;
}

export function resolveImageProviderRuntime(
  providerId: string,
  settings: ImageProviderSettings
): ImageProviderRuntime {
  if (providerId === CHAOMO_IMAGE_PROVIDER_ID) {
    return {
      apiKey: settings.chaomoImageApi.apiKey,
      backendProviderId: CHAOMO_IMAGE_PROVIDER_ID,
      providerConfig: {
        base_url: settings.chaomoImageApi.baseUrl,
        provider_id: CHAOMO_IMAGE_PROVIDER_ID,
      },
    };
  }

  if (providerId === AI_MEDIA_IMAGE_PROVIDER_ID || providerId === OPENAI_IMAGE_PROVIDER_ID) {
    return {
      apiKey: settings.openAiImageApi.apiKey,
      backendProviderId: AI_MEDIA_IMAGE_PROVIDER_ID,
      providerConfig: {
        base_url: settings.openAiImageApi.baseUrl,
        provider_id: AI_MEDIA_IMAGE_PROVIDER_ID,
      },
    };
  }

  const customProvider = settings.customImageApis.find((config) => config.id === providerId);
  if (customProvider) {
    return {
      apiKey: customProvider.apiKey,
      backendProviderId: getCustomImageProtocolDefinition(customProvider.protocol).backendProviderId,
      providerConfig: {
        base_url: customProvider.baseUrl,
        api_key: customProvider.apiKey,
        protocol: customProvider.protocol,
        ...(customProvider.protocol === 'openai-images'
          ? { gateway_provider: customProvider.id }
          : {}),
      },
    };
  }

  const additionalProvider = (settings.additionalImageApis ?? []).find((config) => config.id === providerId);
  if (additionalProvider) {
    return {
      apiKey: additionalProvider.apiKey,
      backendProviderId: additionalProvider.id,
      providerConfig: {
        base_url: additionalProvider.baseUrl,
        api_key: additionalProvider.apiKey,
        protocol: additionalProvider.protocol,
      },
    };
  }

  return { apiKey: '', backendProviderId: providerId, providerConfig: {} };
}
