import type {
  ChaomoImageApiConfig,
  CustomImageApiConfig,
  ImageProviderId,
  ImageModelSelection,
  OpenAiImageApiConfig,
} from '@/stores/settingsStore';
import {
  DEFAULT_CUSTOM_IMAGE_PROTOCOL,
  normalizeCustomImageRemoteModelId,
  toCustomImageRequestModel,
  type CustomImageProtocol,
} from './imageProviderProtocols';

import type { ImageModelDefinition } from './types';
import { findImageModel, listImageModels, resolveImageModelIdAlias } from './registry';
import {
  CUSTOM_IMAGE_PROVIDER_ID_PREFIX,
  isCustomImageProviderId,
} from '@/stores/settingsStore';

const GENERIC_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const;
const GENERIC_RESOLUTIONS = ['1K', '2K', '4K'] as const;

export const UNCONFIGURED_IMAGE_MODEL: ImageModelDefinition = {
  id: 'unconfigured',
  mediaType: 'image',
  displayName: 'Unconfigured',
  providerId: 'unknown',
  description: '',
  eta: '1min',
  expectedDurationMs: 60000,
  defaultAspectRatio: '1:1',
  defaultResolution: '2K',
  aspectRatios: GENERIC_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: GENERIC_RESOLUTIONS.map((value) => ({ value, label: value })),
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: '',
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};

export interface ImageModelSettings {
  openAiImageApi: OpenAiImageApiConfig;
  chaomoImageApi: ChaomoImageApiConfig;
  customImageApis: CustomImageApiConfig[];
  lastImageModelSelection?: ImageModelSelection | null;
}

function providerConfigFor(
  providerId: string,
  settings: Pick<ImageModelSettings, 'openAiImageApi' | 'chaomoImageApi'>
) {
  if (providerId === 'ai-media') {
    return settings.openAiImageApi;
  }
  if (providerId === 'chaomo') {
    return settings.chaomoImageApi;
  }
  return null;
}

function createGenericImageModel(
  providerId: string,
  providerName: string | undefined,
  modelId: string,
  requestModel = modelId,
  description = 'OpenAI-compatible image model'
): ImageModelDefinition {
  return {
    id: modelId,
    mediaType: 'image',
    displayName: modelId.replace(`${providerId}/`, ''),
    providerId,
    ...(providerName ? { providerName } : {}),
    description,
    eta: '1min',
    expectedDurationMs: 60000,
    defaultAspectRatio: '1:1',
    defaultResolution: '2K',
    aspectRatios: GENERIC_ASPECT_RATIOS.map((value) => ({ value, label: value })),
    resolutions: GENERIC_RESOLUTIONS.map((value) => ({ value, label: value })),
    resolveRequest: ({ referenceImageCount }) => ({
      requestModel,
      modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
    }),
  };
}

function resolveConfiguredModel(
  providerId: ImageProviderId,
  modelId: string,
  providerName?: string,
  protocol: CustomImageProtocol = DEFAULT_CUSTOM_IMAGE_PROTOCOL
): ImageModelDefinition {
  const resolvedId = resolveImageModelIdAlias(modelId);
  const registeredModel = findImageModel(resolvedId);
  if (registeredModel) {
    return registeredModel;
  }

  if (providerId === 'ai-media' || providerId === 'chaomo') {
    return createGenericImageModel(providerId, providerName, resolvedId);
  }

  const configuredModelId = resolvedId.startsWith(`${providerId}/`)
    ? resolvedId.slice(providerId.length + 1)
    : resolvedId;
  const remoteModelId = normalizeCustomImageRemoteModelId(protocol, configuredModelId);
  return createGenericImageModel(
    providerId,
    providerName,
    resolvedId,
    toCustomImageRequestModel(protocol, remoteModelId),
    protocol === 'gemini-native'
      ? 'Gemini native image model'
      : protocol === 'fhl-images'
        ? 'FHL Images API model'
        : 'OpenAI-compatible image model'
  );
}

export function toConfiguredImageModelId(
  providerId: ImageProviderId,
  modelId: string,
  protocol: CustomImageProtocol = DEFAULT_CUSTOM_IMAGE_PROTOCOL
): string {
  const trimmed = isCustomImageProviderId(providerId)
    ? normalizeCustomImageRemoteModelId(protocol, modelId)
    : modelId.trim();
  return trimmed.startsWith(`${providerId}/`) ? trimmed : `${providerId}/${trimmed}`;
}

export function listConfiguredImageModels(settings: ImageModelSettings): ImageModelDefinition[] {
  const models: ImageModelDefinition[] = [];
  const seenModelIds = new Set<string>();

  (['ai-media', 'chaomo'] as const).forEach((providerId) => {
    const config = providerConfigFor(providerId, settings);
    if (!config?.apiKey.trim()) {
      return;
    }

    if (!config.modelCatalog) {
      listImageModels()
        .filter((model) => model.providerId === providerId)
        .forEach((model) => {
          if (!seenModelIds.has(model.id)) {
            seenModelIds.add(model.id);
            models.push(model);
          }
        });
      return;
    }

    const selectedModelIds = new Set(config.selectedModelIds);
    config.modelCatalog.models.forEach((model) => {
      if (!selectedModelIds.has(model.id) || seenModelIds.has(model.id)) {
        return;
      }
      seenModelIds.add(model.id);
      const configuredModel = resolveConfiguredModel(providerId, model.id);
      models.push(
        model.label && model.label !== configuredModel.displayName
          ? { ...configuredModel, displayName: model.label }
          : configuredModel
      );
    });
  });

  settings.customImageApis.forEach((config) => {
    if (!config.apiKey.trim() || !config.baseUrl.trim() || !config.modelCatalog) {
      return;
    }

    const selectedModelIds = new Set(config.selectedModelIds);
    config.modelCatalog.models.forEach((model) => {
      if (!selectedModelIds.has(model.id) || seenModelIds.has(model.id)) {
        return;
      }
      seenModelIds.add(model.id);
      const configuredModel = resolveConfiguredModel(
        config.id,
        model.id,
        config.name || undefined,
        config.protocol
      );
      models.push(
        model.label && model.label !== configuredModel.displayName
          ? { ...configuredModel, displayName: model.label }
          : configuredModel
      );
    });
  });

  return models;
}

export function resolveConfiguredImageModel(
  settings: ImageModelSettings,
  requestedModelId: string | undefined
): ImageModelDefinition | null {
  const models = listConfiguredImageModels(settings);
  if (models.length === 0) {
    return null;
  }

  const normalizedRequestedId = requestedModelId
    ? resolveImageModelIdAlias(requestedModelId)
    : undefined;
  const selectedByNode = normalizedRequestedId
    ? models.find((model) => model.id === normalizedRequestedId)
    : undefined;
  if (selectedByNode) {
    return selectedByNode;
  }

  if (normalizedRequestedId?.startsWith(CUSTOM_IMAGE_PROVIDER_ID_PREFIX)) {
    return null;
  }

  const lastSelection = settings.lastImageModelSelection;
  const selectedLastModel = lastSelection
    ? models.find(
      (model) =>
        model.providerId === lastSelection.providerId &&
        model.id === resolveImageModelIdAlias(lastSelection.modelId)
    )
    : undefined;

  return selectedLastModel ?? models[0];
}
