import {
  generateImage,
  getGenerateImageJob,
  retryGenerateImageJob,
  setApiKey,
  submitGenerateImageJob,
} from '@/commands/ai';
import { persistImageLocally, isLikelyLocalImagePath } from '@/features/canvas/application/imageData';
import { uploadMediaToTos } from '@/commands/media';

import type {
  AiGateway,
  GenerateImagePayload,
} from '../application/ports';
import { submitGenerationJobBatch } from '../application/generationJobBatch';
import { logger } from '@/lib/logger';

function redactMediaSource(source: string): string {
  if (source.startsWith('data:')) {
    return `data:${source.slice(5).split(';', 1)[0] || 'unknown'}`;
  }
  try {
    const parsed = new URL(source);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return source.length > 100 ? `${source.slice(0, 100)}...` : source;
  }
}

async function materializeBlobUrl(source: string): Promise<string> {
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`读取 blob 媒体失败: HTTP ${response.status}`);
  }
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取 blob 媒体失败'));
    reader.readAsDataURL(blob);
  });
}

async function uploadSeedanceMedia(source: string, projectId?: string): Promise<string> {
  const materializedSource = source.startsWith('blob:')
    ? await materializeBlobUrl(source)
    : source;
  logger.info('[SeedanceMedia] uploading source:', redactMediaSource(materializedSource));
  const result = await uploadMediaToTos(materializedSource, projectId);
  logger.info('[SeedanceMedia] uploaded object:', result.key, 'expiresAt:', result.expiresAt);
  return result.url;
}

async function normalizeReferenceImages(payload: GenerateImagePayload): Promise<string[] | undefined> {
  const isKieModel = payload.model.startsWith('kie/');
  const isFalModel = payload.model.startsWith('fal/');
  const isRunninghubModel = payload.model.startsWith('runninghub/');
  const isOpenAiModel = payload.model.startsWith('openai/');
  const isGeminiNativeImageModel = payload.model.startsWith('gemini/');
  const isOpenAiCompatibleImageModel =
    isOpenAiModel
    || isGeminiNativeImageModel
    || payload.model.startsWith('ai-media/')
    || payload.model.startsWith('chaomo/')
    || payload.model.startsWith('fhl/');
  // Video models need an externally reachable URL. Local-like sources are uploaded to TOS.
  // Check both volcvideo/ prefix and doubao-seedance model name (for compatibility with stored model values without prefix)
  const isVideoModel = payload.providerId === 'volcvideo'
    || payload.model.startsWith('volcvideo/')
    || payload.model.includes('doubao-seedance');
  logger.info('[normalizeReferenceImages] model:', payload.model, 'isVideoModel:', isVideoModel, 'referenceImages count:', payload.referenceImages?.length ?? 0);
  if (payload.referenceImages) {
    payload.referenceImages.forEach((img, i) => {
      logger.info('[normalizeReferenceImages] image[{}] source: {}', i, redactMediaSource(img));
      logger.info('[normalizeReferenceImages] image[{}] isLikelyLocalImagePath:', i, isLikelyLocalImagePath(img));
    });
  }
  return payload.referenceImages
    ? await Promise.all(
      payload.referenceImages.map(async (imageUrl, index) =>
        isKieModel || isFalModel || isRunninghubModel || isOpenAiCompatibleImageModel
          ? imageUrl // KIE/FAL/RunningHub 使用 data URL（后端会上传到服务器）
          : isVideoModel
          ? (logger.info('[normalizeReferenceImages] image[' + index + '] uploading to TOS'), await uploadSeedanceMedia(imageUrl, payload.projectId))
          : await persistImageLocally(imageUrl, payload.projectId)
      )
    )
    : undefined;
}

async function normalizeVideoContent(payload: GenerateImagePayload) {
  if (!payload.videoContent) {
    return undefined;
  }

  return await Promise.all(payload.videoContent.map(async (item) => {
    if (item.type === 'text') {
      return item;
    }
    return {
      ...item,
      url: await uploadSeedanceMedia(item.url, payload.projectId),
    };
  }));
}

function submitNormalizedGenerateImageJob(
  payload: GenerateImagePayload,
  normalizedReferenceImages: string[] | undefined,
  normalizedVideoContent = payload.videoContent
): Promise<string> {
  return submitGenerateImageJob({
    prompt: payload.prompt,
    model: payload.model,
    provider_id: payload.providerId,
    size: payload.size,
    aspect_ratio: payload.aspectRatio,
    reference_images: normalizedReferenceImages,
    video_content: normalizedVideoContent,
    extra_params: payload.extraParams,
    provider_config: payload.providerConfig,
    draftTaskId: payload.draftTaskId,
    project_id: payload.projectId,
  });
}

export const tauriAiGateway: AiGateway = {
  setApiKey,
  generateImage: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);
    const normalizedVideoContent = await normalizeVideoContent(payload);

    return await generateImage({
      prompt: payload.prompt,
      model: payload.model,
      provider_id: payload.providerId,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      video_content: normalizedVideoContent,
      extra_params: payload.extraParams,
      provider_config: payload.providerConfig,
      draftTaskId: payload.draftTaskId,
    });
  },
  submitGenerateImageJob: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);
    const normalizedVideoContent = await normalizeVideoContent(payload);
    if (normalizedReferenceImages) {
      normalizedReferenceImages.forEach((img, i) => {
        logger.info('[submitGenerateImageJob] normalized image[{}]: {}', i, redactMediaSource(img));
      });
    }
    return await submitNormalizedGenerateImageJob(
      payload,
      normalizedReferenceImages,
      normalizedVideoContent
    );
  },
  submitGenerateImageJobs: async (payload, outputCount, onSettled, beforeSubmit) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);
    const normalizedVideoContent = await normalizeVideoContent(payload);
    beforeSubmit();
    const safeOutputCount = Math.max(1, Math.min(4, Math.floor(outputCount)));
    return submitGenerationJobBatch({
      outputCount: safeOutputCount,
      submit: () => submitNormalizedGenerateImageJob(
        payload,
        normalizedReferenceImages,
        normalizedVideoContent
      ),
      onSettled,
    });
  },
  getGenerateImageJob,
  retryGenerateImageJob,
};
