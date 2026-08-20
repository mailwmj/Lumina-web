import type { ImageModelDefinition } from '../../types';
import {
  CHAOMO_GPT_IMAGE2_4K_HIGHT_MODEL_ID,
  CHAOMO_IMAGE_PROVIDER_ID,
} from '../../providers/openai';

export const imageModel: ImageModelDefinition = {
  id: CHAOMO_GPT_IMAGE2_4K_HIGHT_MODEL_ID,
  mediaType: 'image',
  displayName: 'gpt-image2-4K-Hight',
  providerId: CHAOMO_IMAGE_PROVIDER_ID,
  description: 'Hight 4K 文生图，固定输出 4096×4096',
  eta: '3min',
  expectedDurationMs: 180000,
  defaultAspectRatio: '1:1',
  defaultResolution: '4K',
  aspectRatios: [{ value: '1:1', label: '1:1' }],
  resolutions: [{ value: '4K', label: '4K' }],
  resolveRequest: () => ({
    requestModel: CHAOMO_GPT_IMAGE2_4K_HIGHT_MODEL_ID,
    modeLabel: '生成模式',
  }),
};
