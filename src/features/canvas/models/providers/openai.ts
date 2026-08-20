import type { ModelProviderDefinition } from '../types';

export const OPENAI_IMAGE_PROVIDER_ID = 'openai';
export const OPENAI_CUSTOM_IMAGE_MODEL_ID = 'openai/custom';
export const AI_MEDIA_IMAGE_PROVIDER_ID = 'ai-media';
export const AI_MEDIA_GPT_IMAGE_2_MODEL_ID = 'ai-media/gpt-image-2';
export const CHAOMO_IMAGE_PROVIDER_ID = 'chaomo';

// Chaomo exposes the model ID verbatim through its OpenAI-compatible API.
// Keep the provider prefix in the canvas ID so the runtime can select Chaomo.
export const CHAOMO_GPT_IMAGE2_1K_MODEL_ID = 'chaomo/gpt-image2-1K';
export const CHAOMO_GPT_IMAGE2_1K_HIGHT_MODEL_ID = 'chaomo/gpt-image2-1K-Hight';
export const CHAOMO_GPT_IMAGE2_2K_HIGHT_MODEL_ID = 'chaomo/gpt-image2-2K-Hight';
export const CHAOMO_GPT_IMAGE2_4K_HIGHT_MODEL_ID = 'chaomo/gpt-image2-4K-Hight';
export const CHAOMO_GPT_IMAGE2_2K_DIRECT_MODEL_ID = 'chaomo/gpt-image2-2K-Direct';
export const CHAOMO_GPT_IMAGE2_4K_STABLE_MODEL_ID = 'chaomo/gpt-image2-4K-Stable';
export const CHAOMO_GPT_IMAGE2_4K_DIRECT_MODEL_ID = 'chaomo/gpt-image2-4K-Direct';
export const CHAOMO_GPT_IMAGE2_4K_MODEL_ID = 'chaomo/gpt-image2-4K';
export const CHAOMO_NANO_BANANA_2_MODEL_ID = 'chaomo/nano-banana-2';
export const CHAOMO_NANO_BANANA_PRO_MODEL_ID = 'chaomo/nano-banana-pro';

// IDs used by the first Chaomo integration. They remain valid for existing
// canvas documents and are resolved to the current model definitions.
export const CHAOMO_LEGACY_GPT_IMAGE_2_DIRECT_MODEL_ID = 'chaomo/gpt-image-2-direct';
export const CHAOMO_LEGACY_GPT_IMAGE_2_4K_NATIVE_MODEL_ID = 'chaomo/gpt-image-2-4k-native';

export const CHAOMO_IMAGE_MODEL_IDS = [
  CHAOMO_GPT_IMAGE2_1K_MODEL_ID,
  CHAOMO_GPT_IMAGE2_1K_HIGHT_MODEL_ID,
  CHAOMO_GPT_IMAGE2_2K_HIGHT_MODEL_ID,
  CHAOMO_GPT_IMAGE2_4K_HIGHT_MODEL_ID,
  CHAOMO_GPT_IMAGE2_2K_DIRECT_MODEL_ID,
  CHAOMO_GPT_IMAGE2_4K_STABLE_MODEL_ID,
  CHAOMO_GPT_IMAGE2_4K_DIRECT_MODEL_ID,
  CHAOMO_GPT_IMAGE2_4K_MODEL_ID,
  CHAOMO_NANO_BANANA_2_MODEL_ID,
  CHAOMO_NANO_BANANA_PRO_MODEL_ID,
] as const;

export const legacyProvider: ModelProviderDefinition = {
  id: OPENAI_IMAGE_PROVIDER_ID,
  name: 'OpenAI',
  label: 'OpenAI',
};

export const aiMediaProvider: ModelProviderDefinition = {
  id: AI_MEDIA_IMAGE_PROVIDER_ID,
  name: 'AI Media',
  label: 'AI Media',
};

export const chaomoProvider: ModelProviderDefinition = {
  id: CHAOMO_IMAGE_PROVIDER_ID,
  name: 'Chaomo',
  label: 'Chaomo',
};
