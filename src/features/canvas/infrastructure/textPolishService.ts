import { invoke, isTauri } from '@tauri-apps/api/core';
import type { TextApiConfig } from '@/stores/settingsStore';
import type { TextReasoningEffort } from '@/features/canvas/models/types';
import { logger } from '@/lib/logger';

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

  // Local URLs (asset://, file://, app://) or raw paths - need to convert via Tauri
  // For text polishing, we use data URL format which text APIs can accept directly
  if (lower.startsWith('asset://') || lower.startsWith('file://') || lower.startsWith('app://') ||
      lower.match(/^[a-z]:/) || lower.startsWith('/') || lower.startsWith('\\')) {
    logger.info('[TextPolish] Converting local image to data URL via Tauri command');
    try {
      const dataUrl = await invoke<string>('convert_image_to_data_url', { source: imageUrl });
      logger.info('[TextPolish] Converted to data URL, length:', dataUrl.length);
      return dataUrl;
    } catch (err) {
      logger.error('[TextPolish] Failed to convert local image:', err);
      throw err;
    }
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
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  if (!apiConfig.apiKey) {
    throw new Error('请先配置API密钥');
  }

  // Process reference images to convert blob URLs
  const processedImages = await processReferenceImages(payload.referenceImages);

  logger.info('[TextPolish] polishing text', {
    textLength: payload.text.length,
    apiConfig: {
      id: apiConfig.id,
      name: apiConfig.name,
      modelId: apiConfig.modelId,
      baseUrl: apiConfig.baseUrl,
    },
    referenceImagesCount: processedImages?.length ?? 0,
  });

  try {
    const result = await invoke<string>('polish_text', {
      request: {
        text: payload.text,
        model: apiConfig.modelId,
        api_key: apiConfig.apiKey,
        base_url: apiConfig.baseUrl,
        reference_images: processedImages ?? null,
        custom_prompt: (payload.customPrompt && payload.customPrompt.trim().length > 0) ? payload.customPrompt : null,
        video_duration: payload.videoDuration ?? null,
        video_resolution: payload.videoResolution ?? null,
        video_aspect_ratio: payload.videoAspectRatio ?? null,
        video_shot_type: payload.videoShotType ?? null,
        video_shot_size: payload.videoShotSize ?? null,
        video_angle: payload.videoAngle ?? null,
        video_camera_movement: payload.videoCameraMovement ?? null,
        video_camera_speed: payload.videoCameraSpeed ?? null,
        is_video_frame: payload.isVideoFrame ?? null,
        prompt_type: payload.promptType ?? null,
        reasoning_effort: payload.reasoningEffort ?? null,
      },
    });

    logger.info('[TextPolish] success', {
      resultLength: result.length,
    });

    return { polished: result };
  } catch (error) {
    logger.error('[TextPolish] failed', error);
    // 提取更详细的错误信息
    let message = '润色失败';
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error && typeof error === 'object') {
      // 尝试从 Tauri 错误对象提取信息
      const errObj = error as Record<string, unknown>;
      if (errObj.message) {
        message = String(errObj.message);
      } else if (errObj.error) {
        message = String(errObj.error);
      } else {
        message = JSON.stringify(error);
      }
    }
    logger.error('[TextPolish] error message:', message);
    throw new Error(message);
  }
}

export async function testTextApi(
  apiConfig: TextApiConfig
): Promise<{ success: boolean; message: string }> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  if (!apiConfig.apiKey) {
    throw new Error('请先配置API密钥');
  }

  if (!apiConfig.baseUrl) {
    throw new Error('请先配置API地址');
  }

  logger.info('[TextPolish] testing API', {
    apiConfig: {
      id: apiConfig.id,
      name: apiConfig.name,
      modelId: apiConfig.modelId,
      baseUrl: apiConfig.baseUrl,
    },
  });

  try {
    const result = await invoke<string>('test_text_api', {
      request: {
        text: '',
        model: apiConfig.modelId,
        api_key: apiConfig.apiKey,
        base_url: apiConfig.baseUrl,
        reference_images: null,
        custom_prompt: null,
        reasoning_effort: null,
      },
    });

    logger.info('[TextPolish] test success', result);
    return { success: true, message: result };
  } catch (error) {
    logger.error('[TextPolish] test failed', error);
    const message = error instanceof Error ? error.message : '测试失败';
    throw new Error(message);
  }
}
