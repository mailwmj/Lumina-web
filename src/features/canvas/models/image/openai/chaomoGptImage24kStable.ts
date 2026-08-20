import type { ImageModelDefinition } from '../../types';
import {
  CHAOMO_GPT_IMAGE2_4K_STABLE_MODEL_ID,
  CHAOMO_IMAGE_PROVIDER_ID,
} from '../../providers/openai';

const ASPECT_RATIOS = ['1:1', '5:4', '9:16', '21:9', '16:9', '4:3', '2:3'] as const;

export const imageModel: ImageModelDefinition = {
  id: CHAOMO_GPT_IMAGE2_4K_STABLE_MODEL_ID,
  mediaType: 'image',
  displayName: 'gpt-image2-4K-Stable',
  providerId: CHAOMO_IMAGE_PROVIDER_ID,
  description: '4K Stable 稳定生成与参考图编辑',
  eta: '2min',
  expectedDurationMs: 150000,
  defaultAspectRatio: '16:9',
  defaultResolution: '4K',
  aspectRatios: ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [{ value: '4K', label: '4K' }],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: CHAOMO_GPT_IMAGE2_4K_STABLE_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
