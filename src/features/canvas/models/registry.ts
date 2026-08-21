import type {
  ExtraParamDefinition,
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
import { provider as bltcyProvider } from './providers/bltcy';
import { provider as falProvider } from './providers/fal';
import { provider as grsaiProvider } from './providers/grsai';
import { provider as kieProvider } from './providers/kie';
import { provider as ppioProvider } from './providers/ppio';
import { provider as runninghubProvider } from './providers/runninghub';
import { imageModel as bltcyNanoBananaModel } from './image/bltcy/nanoBanana';
import { imageModel as bltcyGemini31FlashModel } from './image/bltcy/gemini31FlashPreview';
import { imageModel as falNanoBanana2Model } from './image/fal/nanoBanana2';
import { imageModel as falNanoBananaProModel } from './image/fal/nanoBananaPro';
import { imageModel as grsaiNanoBanana2Model } from './image/grsai/nanoBanana2';
import { imageModel as grsaiNanoBananaProModel } from './image/grsai/nanoBananaPro';
import { imageModel as kieNanoBanana2Model } from './image/kie/nanoBanana2';
import { imageModel as kieNanoBananaProModel } from './image/kie/nanoBananaPro';
import { imageModel as ppioGemini31FlashModel } from './image/ppio/gemini31Flash';
import { imageModel as runninghubG31FlashModel } from './image/runninghub/gartImageNG31Flash';
import { imageModel as runninghubRhartModel } from './image/runninghub/rhartImageV1';

const providers: ModelProviderDefinition[] = [
  aiMediaProvider,
  chaomoProvider,
  bltcyProvider,
  falProvider,
  grsaiProvider,
  kieProvider,
  ppioProvider,
  runninghubProvider,
];
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
  bltcyNanoBananaModel,
  bltcyGemini31FlashModel,
  falNanoBanana2Model,
  falNanoBananaProModel,
  grsaiNanoBanana2Model,
  grsaiNanoBananaProModel,
  kieNanoBanana2Model,
  kieNanoBananaProModel,
  ppioGemini31FlashModel,
  runninghubG31FlashModel,
  runninghubRhartModel,
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

function normalizeExtraParamValue(
  definition: ExtraParamDefinition,
  value: unknown,
): boolean | number | string | undefined {
  if (definition.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (definition.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const bounded = Math.min(definition.max ?? value, Math.max(definition.min ?? value, value));
    return definition.step && definition.step > 0
      ? Math.round(bounded / definition.step) * definition.step
      : bounded;
  }
  if (typeof value !== 'string') return undefined;
  if (definition.type === 'enum'
    && definition.options
    && !definition.options.some((option) => option.value === value)) return undefined;
  return value;
}

export function resolveImageModelExtraParams(
  model: ImageModelDefinition,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const schema = model.extraParamsSchema ?? [];
  if (schema.length === 0) return {};
  const result: Record<string, unknown> = {};
  for (const definition of schema) {
    const candidates = [
      input?.[definition.key],
      model.defaultExtraParams?.[definition.key],
      definition.defaultValue,
    ];
    const value = candidates
      .map((candidate) => normalizeExtraParamValue(definition, candidate))
      .find((candidate): candidate is boolean | number | string => candidate !== undefined);
    if (value !== undefined) result[definition.key] = value;
  }
  return result;
}

export function pickClosestImageModelAspectRatio(targetRatio: number, options: string[]): string {
  const safeTargetRatio = Number.isFinite(targetRatio) && targetRatio > 0 ? targetRatio : 1;
  return options.reduce((closest, option) => {
    const [width, height] = option.split(':').map(Number);
    const [closestWidth, closestHeight] = closest.split(':').map(Number);
    const distance = Math.abs(Math.log((width / height) / safeTargetRatio));
    const closestDistance = Math.abs(Math.log((closestWidth / closestHeight) / safeTargetRatio));
    return distance < closestDistance ? option : closest;
  }, options[0] ?? '1:1');
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
