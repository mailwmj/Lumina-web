import type { ImageModelDefinition } from '../../types';
import {
  CHAOMO_GPT_IMAGE2_1K_MODEL_ID,
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
  id: CHAOMO_GPT_IMAGE2_1K_MODEL_ID,
  mediaType: 'image',
  displayName: 'gpt-image2-1K',
  providerId: CHAOMO_IMAGE_PROVIDER_ID,
  description: '常规 1K 图片生成与参考图编辑',
  eta: '1min',
  expectedDurationMs: 60000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [{ value: '1K', label: '1K' }],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: CHAOMO_GPT_IMAGE2_1K_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
