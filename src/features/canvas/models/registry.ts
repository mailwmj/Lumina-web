import type {
  ImageModelDefinition,
  ImageModelRuntimeContext,
  ModelProviderDefinition,
  ResolutionOption,
} from './types';
import { imageModel as aiMediaGptImage2Model } from './image/openai/aiMediaGptImage2';
import { imageModel as chaomoGptImage21kModel } from './image/openai/chaomoGptImage21k';
import { imageModel as chaomoGptImage21kHightModel } from './image/openai/chaomoGptImage21kHight';
import { imageModel as chaomoGptImage22kHightModel } from './image/openai/chaomoGptImage22kHight';
import { imageModel as chaomoGptImage24kHightModel } from './image/openai/chaomoGptImage24kHight';
import { imageModel as chaomoGptImage22kDirectModel } from './image/openai/chaomoGptImage22kDirect';
import { imageModel as chaomoGptImage24kStableModel } from './image/openai/chaomoGptImage24kStable';
import { imageModel as chaomoGptImage2DirectModel } from './image/openai/chaomoGptImage2Direct';
import { imageModel as chaomoGptImage24kNativeModel } from './image/openai/chaomoGptImage24kNative';
import { imageModel as chaomoNanoBanana2Model } from './image/openai/chaomoNanoBanana2';
import { imageModel as chaomoNanoBananaProModel } from './image/openai/chaomoNanoBananaPro';
import {
  AI_MEDIA_GPT_IMAGE_2_MODEL_ID,
  aiMediaProvider,
  CHAOMO_GPT_IMAGE2_4K_DIRECT_MODEL_ID,
  CHAOMO_GPT_IMAGE2_4K_MODEL_ID,
  CHAOMO_LEGACY_GPT_IMAGE_2_DIRECT_MODEL_ID,
  CHAOMO_LEGACY_GPT_IMAGE_2_4K_NATIVE_MODEL_ID,
  chaomoProvider,
} from './providers/openai';

const providers: ModelProviderDefinition[] = [aiMediaProvider, chaomoProvider];
const imageModels: ImageModelDefinition[] = [
  aiMediaGptImage2Model,
  chaomoGptImage21kModel,
  chaomoGptImage21kHightModel,
  chaomoGptImage22kHightModel,
  chaomoGptImage24kHightModel,
  chaomoGptImage22kDirectModel,
  chaomoGptImage24kStableModel,
  chaomoGptImage2DirectModel,
  chaomoGptImage24kNativeModel,
  chaomoNanoBanana2Model,
  chaomoNanoBananaProModel,
];

const providerMap = new Map<string, ModelProviderDefinition>(
  providers.map((provider) => [provider.id, provider])
);
const imageModelMap = new Map<string, ImageModelDefinition>(
  imageModels.map((model) => [model.id, model])
);

export const DEFAULT_IMAGE_MODEL_ID = AI_MEDIA_GPT_IMAGE_2_MODEL_ID;

const imageModelAliasMap = new Map<string, string>([
  [CHAOMO_LEGACY_GPT_IMAGE_2_DIRECT_MODEL_ID, CHAOMO_GPT_IMAGE2_4K_DIRECT_MODEL_ID],
  [CHAOMO_LEGACY_GPT_IMAGE_2_4K_NATIVE_MODEL_ID, CHAOMO_GPT_IMAGE2_4K_MODEL_ID],
]);

export function listImageModels(): ImageModelDefinition[] {
  return imageModels;
}

export function listModelProviders(): ModelProviderDefinition[] {
  return providers;
}

export function resolveImageModelIdAlias(modelId: string): string {
  return imageModelAliasMap.get(modelId) ?? modelId;
}

export function findImageModel(modelId: string): ImageModelDefinition | undefined {
  return imageModelMap.get(resolveImageModelIdAlias(modelId));
}

export function getImageModel(modelId: string): ImageModelDefinition {
  return findImageModel(modelId) ?? imageModelMap.get(DEFAULT_IMAGE_MODEL_ID)!;
}

export function resolveImageModelResolutions(
  model: ImageModelDefinition,
  context: ImageModelRuntimeContext = {}
): ResolutionOption[] {
  const resolvedOptions = model.resolveResolutions?.(context);
  return resolvedOptions && resolvedOptions.length > 0 ? resolvedOptions : model.resolutions;
}

export function resolveImageModelResolution(
  model: ImageModelDefinition,
  requestedResolution: string | undefined,
  context: ImageModelRuntimeContext = {}
): ResolutionOption {
  const resolutionOptions = resolveImageModelResolutions(model, context);

  return (
    (requestedResolution
      ? resolutionOptions.find((item) => item.value === requestedResolution)
      : undefined) ??
    resolutionOptions.find((item) => item.value === model.defaultResolution) ??
    resolutionOptions[0] ??
    model.resolutions[0]
  );
}

export function getModelProvider(
  providerId: string,
  fallbackName?: string
): ModelProviderDefinition {
  return (
    providerMap.get(providerId) ?? {
      id: providerId,
      name: fallbackName || providerId,
      label: fallbackName || providerId,
    }
  );
}
