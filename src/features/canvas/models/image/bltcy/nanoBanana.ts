import type { ImageModelDefinition } from '../../types';

export const BLTCY_NANO_BANANA_MODEL_ID = 'bltcy/nano-banana';

const BLTCY_NANO_BANANA_ASPECT_RATIOS = [
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '2:3', label: '2:3' },
  { value: '3:2', label: '3:2' },
  { value: '4:5', label: '4:5' },
  { value: '5:4', label: '5:4' },
  { value: '21:9', label: '21:9' },
  { value: '1:4', label: '1:4' },
  { value: '4:1', label: '4:1' },
  { value: '8:1', label: '8:1' },
  { value: '1:8', label: '1:8' },
];

export const imageModel: ImageModelDefinition = {
  id: BLTCY_NANO_BANANA_MODEL_ID,
  mediaType: 'image',
  displayName: 'Nano Banana',
  providerId: 'bltcy',
  description: 'Nano Banana 图像生成',
  eta: '30s',
  expectedDurationMs: 45000,
  defaultAspectRatio: '16:9',
  defaultResolution: '1K',
  aspectRatios: BLTCY_NANO_BANANA_ASPECT_RATIOS,
  resolutions: [
    { value: '1K', label: '1K' },
  ],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: 'nano-banana',
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
