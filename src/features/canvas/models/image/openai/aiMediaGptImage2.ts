import type { ImageModelDefinition } from '../../types';
import {
  AI_MEDIA_GPT_IMAGE_2_MODEL_ID,
  AI_MEDIA_IMAGE_PROVIDER_ID,
} from '../../providers/openai';

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const;

export const imageModel: ImageModelDefinition = {
  id: AI_MEDIA_GPT_IMAGE_2_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2 (AI Media)',
  providerId: AI_MEDIA_IMAGE_PROVIDER_ID,
  description: 'AI Media GPT Image 2 图片生成与编辑',
  eta: '1min',
  expectedDurationMs: 60000,
  defaultAspectRatio: '1:1',
  defaultResolution: '2K',
  aspectRatios: ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [
    { value: '1K', label: '1K' },
    { value: '2K', label: '2K' },
    { value: '4K', label: '4K' },
  ],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: AI_MEDIA_GPT_IMAGE_2_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
