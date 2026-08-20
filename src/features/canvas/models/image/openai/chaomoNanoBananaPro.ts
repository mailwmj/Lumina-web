import type { ImageModelDefinition } from '../../types';
import {
  CHAOMO_IMAGE_PROVIDER_ID,
  CHAOMO_NANO_BANANA_PRO_MODEL_ID,
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
  id: CHAOMO_NANO_BANANA_PRO_MODEL_ID,
  mediaType: 'image',
  displayName: 'nano-banana-pro',
  providerId: CHAOMO_IMAGE_PROVIDER_ID,
  description: 'Banana Pro 图片生成与高质量编辑，当前 1K',
  eta: '2min',
  expectedDurationMs: 120000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [{ value: '1K', label: '1K' }],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: CHAOMO_NANO_BANANA_PRO_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
