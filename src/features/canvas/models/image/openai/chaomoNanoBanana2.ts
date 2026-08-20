import type { ImageModelDefinition } from '../../types';
import {
  CHAOMO_IMAGE_PROVIDER_ID,
  CHAOMO_NANO_BANANA_2_MODEL_ID,
} from '../../providers/openai';

const ASPECT_RATIOS = [
  '1:1',
  '1:4',
  '1:8',
  '2:3',
  '3:2',
  '3:4',
  '4:1',
  '4:3',
  '4:5',
  '5:4',
  '8:1',
  '9:16',
  '16:9',
  '21:9',
] as const;

export const imageModel: ImageModelDefinition = {
  id: CHAOMO_NANO_BANANA_2_MODEL_ID,
  mediaType: 'image',
  displayName: 'nano-banana-2',
  providerId: CHAOMO_IMAGE_PROVIDER_ID,
  description: 'Banana 2 图片生成与编辑，当前 1K',
  eta: '1min',
  expectedDurationMs: 90000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [{ value: '1K', label: '1K' }],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: CHAOMO_NANO_BANANA_2_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
