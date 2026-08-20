import { invoke } from '@tauri-apps/api/core';

import {
  generateText as invokeGenerateText,
  type GenerateTextRequest,
} from '@/commands/ai';
import type {
  GenerateTextPayload,
  TextProviderRuntimeConfig,
} from '@/features/canvas/application/ports';

type LocalImageConverter = (source: string) => Promise<string>;

async function blobToDataUrl(blobUrl: string): Promise<string> {
  const response = await fetch(blobUrl);
  if (!response.ok) {
    throw new Error(`参考图片读取失败 (${response.status})`);
  }
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('参考图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

async function defaultLocalImageConverter(source: string): Promise<string> {
  return await invoke<string>('convert_image_to_data_url', { source });
}

function isRemoteOrInlineImage(source: string): boolean {
  const normalized = source.toLowerCase();
  return normalized.startsWith('http://')
    || normalized.startsWith('https://')
    || normalized.startsWith('data:image/');
}

function isLocalImage(source: string): boolean {
  const normalized = source.toLowerCase();
  return normalized.startsWith('asset://')
    || normalized.startsWith('file://')
    || normalized.startsWith('app://')
    || normalized.startsWith('/')
    || normalized.startsWith('\\')
    || /^[a-z]:[\\/]/i.test(source);
}

export async function normalizeTextGenerationReferenceImages(
  images: string[],
  convertLocal: LocalImageConverter = defaultLocalImageConverter
): Promise<string[]> {
  return await Promise.all(images.map(async (rawSource) => {
    const source = rawSource.trim();
    if (!source) {
      throw new Error('参考图片为空，请重新连接图片');
    }
    if (isRemoteOrInlineImage(source)) {
      return source;
    }
    if (source.toLowerCase().startsWith('blob:')) {
      const converted = await blobToDataUrl(source);
      if (!converted.startsWith('data:image/')) {
        throw new Error('参考图片转换失败');
      }
      return converted;
    }
    if (isLocalImage(source)) {
      const converted = await convertLocal(source);
      if (!isRemoteOrInlineImage(converted)) {
        throw new Error('参考图片转换失败');
      }
      return converted;
    }
    throw new Error('参考图片格式无法读取，请重新连接或上传图片');
  }));
}

export function createGenerateTextRequest(
  payload: GenerateTextPayload,
  apiConfig: TextProviderRuntimeConfig
): GenerateTextRequest {
  return {
    text: payload.text,
    model: apiConfig.modelId,
    api_key: apiConfig.apiKey,
    base_url: apiConfig.baseUrl,
    reference_images: payload.referenceImages,
    reasoning_effort: payload.reasoningEffort,
  };
}

export async function generateText(
  payload: GenerateTextPayload,
  apiConfig: TextProviderRuntimeConfig
): Promise<string> {
  if (!apiConfig.apiKey.trim()) {
    throw new Error('请先配置 API 密钥');
  }
  if (!apiConfig.baseUrl.trim()) {
    throw new Error('请先配置 API 地址');
  }
  if (!apiConfig.modelId.trim()) {
    throw new Error('请选择文本模型');
  }

  const referenceImages = await normalizeTextGenerationReferenceImages(
    payload.referenceImages ?? []
  );
  return await invokeGenerateText(createGenerateTextRequest(
    { ...payload, referenceImages },
    apiConfig
  ));
}
