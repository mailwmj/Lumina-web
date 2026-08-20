import type { ImageModelDefinition } from '../../types';

export const RUNNINGHUB_RHART_MODEL_ID = 'runninghub/rhart-image-v1';

const RUNNINGHUB_ASPECT_RATIOS = [
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
  { value: '5:4', label: '5:4' },
  { value: '4:5', label: '4:5' },
  { value: '21:9', label: '21:9' },
];

export const imageModel: ImageModelDefinition = {
  id: RUNNINGHUB_RHART_MODEL_ID,
  mediaType: 'image',
  displayName: 'RHart Image V1',
  providerId: 'runninghub',
  description: 'RHart Image V1 图像生成',
  eta: '60s',
  expectedDurationMs: 60000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: RUNNINGHUB_ASPECT_RATIOS,
  resolutions: [
    { value: '1K', label: '1K' },
  ],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: 'rhart-image-v1',
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
