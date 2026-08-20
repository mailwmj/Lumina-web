import type { ImageModelDefinition } from '../../types';
import {
  CHAOMO_GPT_IMAGE2_1K_HIGHT_MODEL_ID,
  CHAOMO_IMAGE_PROVIDER_ID,
} from '../../providers/openai';

export const imageModel: ImageModelDefinition = {
  id: CHAOMO_GPT_IMAGE2_1K_HIGHT_MODEL_ID,
  mediaType: 'image',
  displayName: 'gpt-image2-1K-Hight',
  providerId: CHAOMO_IMAGE_PROVIDER_ID,
  description: 'Hight 1K 文生图，固定输出 1024×1024',
  eta: '1min',
  expectedDurationMs: 60000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: [{ value: '1:1', label: '1:1' }],
  resolutions: [{ value: '1K', label: '1K' }],
  resolveRequest: () => ({
    requestModel: CHAOMO_GPT_IMAGE2_1K_HIGHT_MODEL_ID,
    modeLabel: '生成模式',
  }),
};
