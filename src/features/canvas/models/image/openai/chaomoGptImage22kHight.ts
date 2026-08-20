import type { ImageModelDefinition } from '../../types';
import {
  CHAOMO_GPT_IMAGE2_2K_HIGHT_MODEL_ID,
  CHAOMO_IMAGE_PROVIDER_ID,
} from '../../providers/openai';

export const imageModel: ImageModelDefinition = {
  id: CHAOMO_GPT_IMAGE2_2K_HIGHT_MODEL_ID,
  mediaType: 'image',
  displayName: 'gpt-image2-2K-Hight',
  providerId: CHAOMO_IMAGE_PROVIDER_ID,
  description: 'Hight 2K 文生图，固定输出 2048×2048',
  eta: '2min',
  expectedDurationMs: 90000,
  defaultAspectRatio: '1:1',
  defaultResolution: '2K',
  aspectRatios: [{ value: '1:1', label: '1:1' }],
  resolutions: [{ value: '2K', label: '2K' }],
  resolveRequest: () => ({
    requestModel: CHAOMO_GPT_IMAGE2_2K_HIGHT_MODEL_ID,
    modeLabel: '生成模式',
  }),
};
