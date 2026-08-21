import type { TextApiConfig } from '@/stores/settingsStore';
import type { TextReasoningEffort } from '@/features/canvas/models/types';
import i18n from '@/i18n';
import { logger } from '@/lib/logger';
import { assertNetworkAvailable } from '@/runtime/networkAvailability';
import { polishTextViaWeb, testTextApiViaWeb } from './webTextApi';

export interface TextPolishPayload {
  text: string;
  referenceImages?: string[];
  // 视频元信息字段
  videoDuration?: string;
  videoResolution?: string;
  videoAspectRatio?: string;
  videoShotType?: string;
  videoShotSize?: string;
  videoAngle?: string;
  videoCameraMovement?: string;
  videoCameraSpeed?: string;
  // 是否为首尾帧模式
  isVideoFrame?: boolean;
  // 自定义润色提示词模板（可选）
  customPrompt?: string;
  // 提示词模板类型：image、text 或 video
  promptType?: string;
  reasoningEffort?: TextReasoningEffort;
}

export interface TextPolishResult {
  polished: string;
}

export interface TextPolishError {
  message: string;
  details?: string;
}

/**
 * Convert blob URL to data URL for image upload
 */
async function blobToDataUrl(blobUrl: string): Promise<string> {
  try {
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    logger.warn('[TextPolish] Failed to convert blob to data URL:', err);
    return blobUrl; // fallback to original
  }
}

/**
 * Convert image URL to data URL for text polishing API
 * Unlike Seedance media uploads (which use TOS), this always returns a data URL
 * because text APIs accept inline base64 images directly
 */
async function convertImageToDataUrl(imageUrl: string): Promise<string> {
  const lower = imageUrl.toLowerCase();

  // Already a data URL - return as-is
  if (lower.startsWith('data:')) {
    logger.info('[TextPolish] Already data URL, using directly');
    return imageUrl;
  }

  // Blob URL - convert to data URL via fetch
  if (lower.startsWith('blob:')) {
    logger.info('[TextPolish] Converting blob URL to data URL');
    return await blobToDataUrl(imageUrl);
  }

  // HTTP(S) URL - return as-is (should be publicly accessible)
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    logger.info('[TextPolish] Using HTTP URL directly');
    return imageUrl;
  }

  // Browser sessions never persist native paths. Treat a legacy path as unreadable
  // instead of attempting to access the user's filesystem.
  if (lower.startsWith('asset://') || lower.startsWith('file://') || lower.startsWith('app://') ||
      lower.match(/^[a-z]:/) || lower.startsWith('/') || lower.startsWith('\\')) {
    throw new Error('浏览器无法读取本机图片路径，请重新上传图片');
  }

  // Unknown format - return as-is
  logger.warn('[TextPolish] Unknown image URL format, using as-is:', imageUrl.substring(0, 80));
  return imageUrl;
}

/**
 * Process reference images for text polishing - always returns data URLs
 * Text APIs accept inline base64 images, so we don't need external hosting
 */
async function processReferenceImages(images: string[] | undefined): Promise<string[] | undefined> {
  if (!images || images.length === 0) return undefined;

  const processedImages: string[] = [];
  for (const img of images) {
    logger.info('[TextPolish] Processing image URL:', img.substring(0, 80));
    try {
      const dataUrl = await convertImageToDataUrl(img);
      processedImages.push(dataUrl);
      logger.info('[TextPolish] Image processed successfully, data URL length:', dataUrl.length);
    } catch (err) {
      logger.error('[TextPolish] Failed to process image:', err);
      // Skip image on failure
      logger.warn('[TextPolish] Skipping image due to error');
    }
  }
  logger.info('[TextPolish] Final processed images count:', processedImages.length);
  return processedImages;
}

export async function polishText(
  payload: TextPolishPayload,
  apiConfig: TextApiConfig
): Promise<TextPolishResult> {
  assertNetworkAvailable();
  if (!apiConfig.apiKey) {
    throw new Error(i18n.t('generationGateway.textApiKeyRequired'));
  }

  // Process reference images to convert blob URLs
  const processedImages = await processReferenceImages(payload.referenceImages);

  return await polishTextViaWeb({
    ...payload,
    referenceImages: processedImages,
  }, apiConfig);
}

export async function testTextApi(
  apiConfig: TextApiConfig
): Promise<{ success: boolean; message: string }> {
  assertNetworkAvailable();
  if (!apiConfig.apiKey) {
    throw new Error(i18n.t('generationGateway.textApiKeyRequired'));
  }

  if (!apiConfig.baseUrl) {
    throw new Error(i18n.t('generationGateway.textBaseUrlRequired'));
  }

  return await testTextApiViaWeb(apiConfig);
}
