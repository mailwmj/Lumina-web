import type { ImageModelDefinition } from '../../types';
import {
  CHAOMO_GPT_IMAGE2_2K_DIRECT_MODEL_ID,
  CHAOMO_IMAGE_PROVIDER_ID,
} from '../../providers/openai';

const ASPECT_RATIOS = [
  '1:1',
  '5:4',
  '9:16',
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '4:5',
  '3:4',
  '2:3',
] as const;

export const imageModel: ImageModelDefinition = {
  id: CHAOMO_GPT_IMAGE2_2K_DIRECT_MODEL_ID,
  mediaType: 'image',
  displayName: 'gpt-image2-2K-Direct',
  providerId: CHAOMO_IMAGE_PROVIDER_ID,
  description: '2K Direct 高清生成与参考图编辑',
  eta: '2min',
  expectedDurationMs: 90000,
  defaultAspectRatio: '16:9',
  defaultResolution: '2K',
  aspectRatios: ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [{ value: '2K', label: '2K' }],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: CHAOMO_GPT_IMAGE2_2K_DIRECT_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
