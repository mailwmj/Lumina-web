import type { GenerateImagePayload } from '@/features/canvas/application/ports';
import {
  createGenerationProviderError,
  normalizeGenerationProviderRequestId,
} from '@/lib/generationProviderError';
import {
  FHL_IMAGE_DEFAULT_BASE_URL,
  CUSTOM_IMAGE_PROTOCOLS,
  type CustomImageProtocol,
} from '@/features/canvas/models/imageProviderProtocols';
import { listImageModels } from '@/features/canvas/models/registry';
import i18n from '@/i18n';
import { assertNetworkAvailable } from '@/runtime/networkAvailability';

export type WebImageProtocol = CustomImageProtocol;

export interface WebImageApiOptions {
  fetchImpl?: typeof fetch;
}

export interface WebImageRequest {
  endpoint: string;
  method: 'POST';
  headers: Record<string, string>;
  body: BodyInit;
}

export interface WebImageTaskHandle {
  externalTaskId?: string;
  statusUrl?: string;
  resultUrl?: string;
  protocol: WebImageProtocol;
  baseUrl: string;
  model: string;
}

export type WebImageSubmission =
  | { status: 'succeeded'; source: string }
  | { status: 'running'; handle: WebImageTaskHandle };

export type WebImagePollResult =
  | { status: 'running' }
  | { status: 'succeeded'; source: string }
  | {
    status: 'failed';
    error: string;
    errorDetails?: string;
    requestId?: string;
    retryable?: boolean;
  };

interface ImageRequestInput {
  model: string;
  prompt: string;
  size: string;
  aspectRatio: string;
  referenceImages?: string[];
  extraParams?: Record<string, unknown>;
}

interface ImageProviderConfig {
  apiKey: string;
  baseUrl: string;
  protocol?: CustomImageProtocol | WebImageProtocol;
}

function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(i18n.t('generationGateway.baseUrlInvalid'));
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(i18n.t('generationGateway.baseUrlInvalid'));
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function endpoint(baseUrl: string, suffix: string, fallbackPath = '/v1'): string {
  const url = normalizeBaseUrl(baseUrl);
  const path = url.pathname || fallbackPath;
  url.pathname = `${path.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
  return url.toString();
}

export function resolveImageModelsEndpoint(baseUrl: string, protocol: WebImageProtocol = 'openai-images'): string {
  if (protocol === 'gemini-native') {
    return endpoint(baseUrl, 'models', '/v1beta');
  }
  return endpoint(baseUrl, 'models');
}

export function resolveGeminiCompatibleModelsEndpoint(baseUrl: string): string {
  const url = normalizeBaseUrl(baseUrl);
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1beta$/, '');
  url.pathname = `${path || ''}/v1/models`;
  return url.toString();
}

function resolveImageSize(resolution: string, aspectRatio: string): string {
  const normalizedResolution = resolution.trim().toLowerCase();
  if (/^\d+x\d+$/.test(normalizedResolution)) {
    return normalizedResolution;
  }
  const longEdge = normalizedResolution === '2k' ? 2048 : normalizedResolution === '4k' ? 4096 : 1024;
  const [rawWidth, rawHeight] = aspectRatio.split(':').map(Number);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) {
    return `${longEdge}x${longEdge}`;
  }
  if (rawWidth > rawHeight) {
    return `${longEdge}x${Math.max(1, Math.round(longEdge * rawHeight / rawWidth))}`;
  }
  if (rawWidth < rawHeight) {
    return `${Math.max(1, Math.round(longEdge * rawWidth / rawHeight))}x${longEdge}`;
  }
  return `${longEdge}x${longEdge}`;
}

function resolveStandardImageSize(aspectRatio: string): string {
  const [rawWidth, rawHeight] = aspectRatio.split(':').map(Number);
  if (Number.isFinite(rawWidth) && Number.isFinite(rawHeight) && rawWidth > rawHeight) return '1536x1024';
  if (Number.isFinite(rawWidth) && Number.isFinite(rawHeight) && rawWidth < rawHeight) return '1024x1536';
  return '1024x1024';
}

const FHL_SIZE_MATRIX: Record<string, string> = {
  '1K|1:1': '1024x1024', '1K|3:2': '1536x1024', '1K|2:3': '1024x1536',
  '1K|4:3': '1536x1152', '1K|3:4': '1152x1536', '1K|5:4': '1520x1216',
  '1K|4:5': '1216x1520', '1K|16:9': '1536x864', '1K|9:16': '864x1536',
  '2K|1:1': '2048x2048', '2K|3:2': '2048x1360', '2K|2:3': '1360x2048',
  '2K|4:3': '2048x1536', '2K|3:4': '1536x2048', '2K|5:4': '2048x1632',
  '2K|4:5': '1632x2048', '2K|16:9': '2048x1152', '2K|9:16': '1152x2048',
  '4K|1:1': '2880x2880', '4K|3:2': '3520x2352', '4K|2:3': '2352x3520',
  '4K|4:3': '3840x2880', '4K|3:4': '2880x3840', '4K|5:4': '3840x3072',
  '4K|4:5': '3072x3840', '4K|16:9': '3840x2160', '4K|9:16': '2160x3840',
};

export function resolveFhlImageSize(resolution: string, aspectRatio: string): string {
  if (/^\d+x\d+$/i.test(resolution.trim())) return resolveImageSize(resolution, aspectRatio);
  return FHL_SIZE_MATRIX[`${resolution.trim().toUpperCase()}|${aspectRatio.trim()}`]
    ?? resolveImageSize(resolution, aspectRatio);
}

function resolveQuality(resolution: string): string | undefined {
  switch (resolution.trim().toLowerCase()) {
    case '1k': case 'low': return 'low';
    case '2k': case 'medium': return 'medium';
    case '4k': case 'high': return 'high';
    case 'auto': return 'auto';
    default: return undefined;
  }
}

export function resolveWebImageProtocol(
  model: string,
  providerId?: string,
  configuredProtocol?: CustomImageProtocol | WebImageProtocol,
): WebImageProtocol {
  if (configuredProtocol && CUSTOM_IMAGE_PROTOCOLS.includes(configuredProtocol as CustomImageProtocol)) {
    return configuredProtocol as WebImageProtocol;
  }
  const prefix = (providerId?.trim() || model.split('/', 1)[0] || '').toLowerCase();
  if (prefix === 'fhl') return 'fhl-images';
  if (prefix === 'gemini') return 'gemini-native';
  if (CUSTOM_IMAGE_PROTOCOLS.includes(prefix as CustomImageProtocol)
    && !['openai-images', 'fhl-images', 'gemini-native'].includes(prefix)) {
    return prefix as WebImageProtocol;
  }
  return 'openai-images';
}

function bareModel(model: string, protocol: WebImageProtocol): string {
  const prefix = protocol === 'fhl-images' ? 'fhl/'
    : protocol === 'gemini-native' ? 'gemini/'
      : `${protocol}/`;
  if (model.startsWith(prefix)) return model.slice(prefix.length);
  const customPrefixIndex = model.indexOf('/');
  if (model.startsWith('custom-openai:') && customPrefixIndex > 0) return model.slice(customPrefixIndex + 1);
  for (const providerPrefix of ['ai-media/', 'chaomo/', 'openai/', 'fhl/', 'gemini/']) {
    if (model.startsWith(providerPrefix)) return model.slice(providerPrefix.length);
  }
  return model;
}

export function buildOpenAiCompatibleImageBody(
  input: ImageRequestInput,
  protocol: 'openai-images' | 'fhl-images' = 'openai-images',
  asyncMode = false,
): Record<string, unknown> {
  const isAiMedia = input.model.startsWith('ai-media/');
  const isChaomo = input.model.startsWith('chaomo/');
  const model = bareModel(input.model, protocol);
  if (protocol === 'fhl-images') {
    return {
      ...(input.extraParams ?? {}),
      model,
      prompt: input.prompt,
      n: 1,
      size: resolveFhlImageSize(input.size, input.aspectRatio),
      quality: 'auto',
      output_format: 'png',
      response_format: 'b64_json',
    };
  }
  const body: Record<string, unknown> = {
    ...(input.extraParams ?? {}),
    model,
    prompt: input.prompt,
    n: 1,
  };
  if (isChaomo) {
    body.ratio = input.aspectRatio;
    body.response_format = 'url';
    body.async = true;
    if (!/Hight$/i.test(model) && model !== 'gpt-image2-4K') body.quality = 'medium';
  } else {
    body.size = isAiMedia ? resolveImageSize(input.size, input.aspectRatio) : resolveStandardImageSize(input.aspectRatio);
    const quality = resolveQuality(input.size);
    if (quality) body.quality = quality;
    if (asyncMode || isAiMedia) body.async = true;
    if (isAiMedia) body.response_format = 'b64_json';
  }
  return body;
}

export function buildGeminiNativeImageBody(input: ImageRequestInput, inlineImages: Array<{ mimeType: string; data: string }> = []): Record<string, unknown> {
  return {
    contents: [{
      role: 'user',
      parts: [
        { text: input.prompt },
        ...inlineImages.map((image) => ({ inlineData: image })),
      ],
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: input.aspectRatio, imageSize: input.size },
    },
  };
}

export function buildFalImageBody(input: ImageRequestInput): Record<string, unknown> {
  const model = bareModel(input.model, 'fal');
  const path = model === 'nano-banana-pro'
    ? (input.referenceImages?.length ? 'fal-ai/nano-banana-pro/edit' : 'fal-ai/nano-banana-pro')
    : (input.referenceImages?.length ? 'fal-ai/nano-banana-2/edit' : 'fal-ai/nano-banana-2');
  return {
    modelPath: path,
    input: {
      prompt: input.prompt,
      num_images: 1,
      aspect_ratio: input.aspectRatio,
      output_format: 'png',
      safety_tolerance: 6,
      resolution: input.size,
      limit_generations: true,
      enable_web_search: input.extraParams?.enable_web_search === true,
      ...(input.referenceImages?.length ? { image_urls: input.referenceImages } : {}),
      ...(input.extraParams?.thinking_level === 'minimal' || input.extraParams?.thinking_level === 'high'
        ? { thinking_level: input.extraParams.thinking_level }
        : {}),
    },
  };
}

export function buildGrsaiImageBody(input: ImageRequestInput): Record<string, unknown> {
  const requestedModel = bareModel(input.model, 'grsai');
  const variant = typeof input.extraParams?.grsai_pro_model === 'string'
    ? input.extraParams.grsai_pro_model.trim().toLowerCase()
    : requestedModel;
  const model = requestedModel === 'nano-banana-2'
    ? requestedModel
    : variant.startsWith('nano-banana-pro') ? variant : 'nano-banana-pro';
  return {
    model,
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    imageSize: input.size,
    ...(input.referenceImages?.length ? { urls: input.referenceImages } : {}),
    webHook: '-1',
    shutProgress: true,
  };
}

export function buildKieImageBody(input: ImageRequestInput): Record<string, unknown> {
  const model = bareModel(input.model, 'kie');
  return {
    model,
    input: {
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio,
      resolution: input.size,
      output_format: 'png',
      image_input: input.referenceImages ?? [],
      ...(model === 'nano-banana-2' ? { google_search: input.extraParams?.enable_web_search === true } : {}),
    },
  };
}

export function buildRunningHubImageBody(input: ImageRequestInput): Record<string, unknown> {
  const model = bareModel(input.model, 'runninghub');
  const isV1 = model === 'rhart-image-v1';
  return {
    prompt: input.prompt,
    ...(input.aspectRatio && (input.aspectRatio !== 'auto' || isV1) ? { aspectRatio: input.aspectRatio } : {}),
    ...(!isV1 && input.size ? { resolution: input.size.toLowerCase() } : {}),
    imageUrls: input.referenceImages ?? [],
  };
}

export function buildBltcyImageBody(input: ImageRequestInput): Record<string, unknown> {
  const model = bareModel(input.model, 'bltcy');
  return {
    model,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio,
    ...(model === 'gemini-3.1-flash-image-preview' && input.size ? { image_size: input.size } : {}),
    response_format: 'url',
    image: input.referenceImages ?? [],
  };
}

export function buildPpioImageBody(input: ImageRequestInput): Record<string, unknown> {
  const hasImages = Boolean(input.referenceImages?.length);
  return {
    prompt: input.prompt,
    size: input.size,
    aspect_ratio: input.aspectRatio,
    ...(hasImages ? { image_base64s: input.referenceImages } : {}),
    output_format: 'image/png',
  };
}

function dataUrlToBlob(source: string): Blob | null {
  const match = source.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;
  try {
    const mimeType = match[1] || 'application/octet-stream';
    const payload = match[3] ?? '';
    if (match[2]) {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new Blob([bytes], { type: mimeType });
    }
    return new Blob([decodeURIComponent(payload)], { type: mimeType });
  } catch {
    return null;
  }
}

export async function sourceToDataUrl(source: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (source.startsWith('data:')) return source;
  let response: Response;
  try {
    response = await fetchImpl(source);
  } catch (error) {
    if (error instanceof TypeError) throw new Error(i18n.t('generationGateway.corsRequired'));
    throw error;
  }
  if (!response.ok) throw new Error(i18n.t('generationGateway.referenceImageReadFailed', { status: response.status }));
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(i18n.t('generationGateway.referenceImageUnreadable')));
    reader.readAsDataURL(blob);
  });
}

async function materializeReferenceSources(
  sources: readonly string[],
  fetchImpl: typeof fetch,
): Promise<string[]> {
  return await Promise.all(sources.map((source) => (
    isHttpUrl(source) ? source : sourceToDataUrl(source, fetchImpl)
  )));
}

function dataUrlParts(source: string): { mimeType: string; data: string } {
  const blob = dataUrlToBlob(source);
  if (!blob) throw new Error(i18n.t('generationGateway.referenceImageDecodeFailed'));
  return { mimeType: blob.type || 'image/png', data: source.split(',', 2)[1] ?? '' };
}

function dataUrlPayload(source: string): string {
  return dataUrlParts(source).data;
}

function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function extractUploadedUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const candidates = [record, record.data].filter(
    (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  );
  for (const candidate of candidates) {
    const url = ['downloadUrl', 'download_url', 'fileUrl', 'file_url', 'url']
      .map((key) => candidate[key])
      .find((value): value is string => typeof value === 'string' && /^https?:\/\//.test(value));
    if (url) return url;
  }
  return null;
}

async function uploadKieReferences(
  references: readonly string[],
  apiKey: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  return await Promise.all(references.map(async (source, index) => {
    const blob = dataUrlToBlob(source);
    if (!blob) throw new Error(i18n.t('generationGateway.referenceImageDecodeFailed'));
    const fileName = `reference-${index + 1}.png`;
    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('uploadPath', 'images/storyboard-copilot');
    form.append('fileName', fileName);
    let response: Response;
    try {
      response = await fetchImpl(endpoint(resolveKieUploadBaseUrl(baseUrl), 'api/file-stream-upload', ''), {
        method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form,
      });
    } catch (error) {
      if (error instanceof TypeError) throw new Error(i18n.t('generationGateway.corsRequired'));
      throw error;
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw createGenerationProviderError(body, response.status);
    const url = extractUploadedUrl(body);
    if (!url) throw new Error(i18n.t('generationGateway.invalidSubmission'));
    return url;
  }));
}

async function uploadRunningHubReferences(
  references: readonly string[],
  apiKey: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  return await Promise.all(references.map(async (source, index) => {
    if (isHttpUrl(source)) return source;
    const blob = dataUrlToBlob(source);
    if (!blob) throw new Error(i18n.t('generationGateway.referenceImageDecodeFailed'));
    const form = new FormData();
    form.append('file', blob, `reference-${index + 1}.png`);
    let response: Response;
    try {
      response = await fetchImpl(endpoint(baseUrl || 'https://www.runninghub.cn/openapi/v2', 'media/upload/binary', ''), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } catch (error) {
      if (error instanceof TypeError) throw new Error(i18n.t('generationGateway.corsRequired'));
      throw error;
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw createGenerationProviderError(body, response.status);
    const url = extractUploadedUrl(body);
    if (!url) throw new Error(i18n.t('generationGateway.invalidSubmission'));
    return url;
  }));
}

export async function buildImageGenerationRequest(
  payload: GenerateImagePayload,
  config: ImageProviderConfig,
  options: WebImageApiOptions = {},
): Promise<WebImageRequest> {
  assertNetworkAvailable();
  const fetchImpl = options.fetchImpl ?? fetch;
  const protocol = resolveWebImageProtocol(payload.model, payload.providerId, config.protocol);
  const providerSources = await materializeReferenceSources(payload.referenceImages ?? [], fetchImpl);
  const references = protocol === 'fal' || protocol === 'runninghub'
    ? providerSources
    : await Promise.all(providerSources.map((source) => sourceToDataUrl(source, fetchImpl)));
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error(i18n.t('generationGateway.apiKeyRequired'));
  const providerReferences = protocol === 'kie'
    ? await uploadKieReferences(references, apiKey, config.baseUrl, fetchImpl)
    : protocol === 'runninghub'
      ? await uploadRunningHubReferences(providerSources, apiKey, config.baseUrl, fetchImpl)
      : protocol === 'fal'
        ? providerSources
        : protocol === 'grsai' || protocol === 'ppio'
      ? references.map(dataUrlPayload)
      : references;
  const input: ImageRequestInput = {
    model: payload.model,
    prompt: payload.prompt,
    size: payload.size,
    aspectRatio: payload.aspectRatio,
    referenceImages: providerReferences,
    extraParams: payload.extraParams,
  };
  if (protocol === 'gemini-native') {
    return {
      endpoint: endpoint(config.baseUrl, `models/${bareModel(payload.model, protocol)}:generateContent`, '/v1beta'),
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(buildGeminiNativeImageBody(input, references.map(dataUrlParts))),
    };
  }
  if (protocol === 'fal') {
    if (providerReferences.some((source) => source.startsWith('data:'))) {
      throw new Error(i18n.t('generationGateway.referenceImageRequiresPublicUrl'));
    }
    const body = buildFalImageBody(input);
    return {
      endpoint: endpoint(config.baseUrl || 'https://queue.fal.run', String(body.modelPath), ''),
      method: 'POST',
      headers: { authorization: `Key ${apiKey}`, 'content-type': 'application/json', 'x-fal-no-retry': '1' },
      body: JSON.stringify(body.input),
    };
  }
  if (protocol === 'grsai') {
    return {
      endpoint: endpoint(config.baseUrl, 'v1/draw/nano-banana', ''),
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildGrsaiImageBody(input)),
    };
  }
  if (protocol === 'kie') {
    return {
      endpoint: endpoint(config.baseUrl || 'https://api.kie.ai', 'api/v1/jobs/createTask', ''),
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildKieImageBody(input)),
    };
  }
  if (protocol === 'runninghub') {
    const model = bareModel(payload.model, protocol);
    const operation = model === 'rhart-image-v1' ? 'edit' : 'image-to-image';
    return {
      endpoint: endpoint(config.baseUrl || 'https://www.runninghub.cn/openapi/v2', `${model}/${operation}`, ''),
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildRunningHubImageBody(input)),
    };
  }
  if (protocol === 'bltcy') {
    const model = bareModel(payload.model, protocol);
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', payload.prompt);
    form.append('aspect_ratio', payload.aspectRatio);
    form.append('response_format', 'url');
    if (model === 'gemini-3.1-flash-image-preview' && payload.size) form.append('image_size', payload.size);
    if (references.length === 0) {
      form.append('image', '');
    } else {
      references.forEach((source, index) => {
        const blob = dataUrlToBlob(source);
        if (!blob) throw new Error(i18n.t('generationGateway.referenceImageDecodeFailed'));
        form.append('image', blob, `reference-${index + 1}.png`);
      });
    }
    return {
      endpoint: endpoint(config.baseUrl || 'https://api.bltcy.ai', 'v1/images/edits', ''),
      method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form,
    };
  }
  if (protocol === 'ppio') {
    return {
      endpoint: endpoint(config.baseUrl || 'https://api.ppio.com', `v3/gemini-3.1-flash-image-${references.length ? 'edit' : 'text-to-image'}`, ''),
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildPpioImageBody(input)),
    };
  }
  const hasReferences = references.length > 0;
  if (!hasReferences) {
    return {
      endpoint: endpoint(config.baseUrl, 'images/generations'),
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildOpenAiCompatibleImageBody(input, protocol)),
    };
  }
  const form = new FormData();
  const body = buildOpenAiCompatibleImageBody(input, protocol);
  Object.entries(body).forEach(([key, value]) => form.append(key, String(value)));
  for (const [index, source] of references.entries()) {
    const blob = dataUrlToBlob(source);
    if (!blob) throw new Error(i18n.t('generationGateway.referenceImageDecodeFailed'));
    form.append(protocol === 'fhl-images' ? (index === 0 ? 'image' : 'image[]') : 'image', blob, `reference-${index + 1}.png`);
  }
  return {
    endpoint: endpoint(config.baseUrl, 'images/edits'),
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  };
}

function extractSource(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const nestedRecords: Record<string, unknown>[] = [record];
  for (const key of ['data', 'response', 'result']) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) nestedRecords.push(value as Record<string, unknown>);
  }
  for (const candidate of nestedRecords) {
    const items = Array.isArray(candidate.data) ? candidate.data
      : Array.isArray(candidate.images) ? candidate.images
        : Array.isArray(candidate.results) ? candidate.results : [candidate];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const data = item as Record<string, unknown>;
      const base64 = data.b64_json ?? data.base64;
      if (typeof base64 === 'string' && base64.trim()) return `data:image/png;base64,${base64.trim()}`;
      const url = data.url ?? data.signed_url;
      if (typeof url === 'string' && url.trim()) return url.trim();
      const nestedImage = data.image;
      if (nestedImage && typeof nestedImage === 'object' && !Array.isArray(nestedImage)
        && typeof (nestedImage as Record<string, unknown>).url === 'string') {
        return String((nestedImage as Record<string, unknown>).url);
      }
    }
    const imageUrls = candidate.image_urls ?? candidate.resultUrls;
    if (Array.isArray(imageUrls)) {
      const firstUrl = imageUrls.find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
      if (firstUrl) return firstUrl.trim();
    }
    const resultJson = candidate.resultJson;
    if (typeof resultJson === 'string') {
      try {
        const parsed = JSON.parse(resultJson) as Record<string, unknown>;
        const source = extractSource(parsed);
        if (source) return source;
      } catch {
        // Ignore malformed provider result details and let polling continue.
      }
    }
  }
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const parts = ((candidate as Record<string, unknown>).content as Record<string, unknown> | undefined)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const inline = (part as Record<string, unknown>).inlineData ?? (part as Record<string, unknown>).inline_data;
      if (!inline || typeof inline !== 'object') continue;
      const data = (inline as Record<string, unknown>).data;
      if (typeof data === 'string' && data.trim()) {
        const mime = typeof (inline as Record<string, unknown>).mimeType === 'string'
          ? (inline as Record<string, unknown>).mimeType as string : 'image/png';
        return `data:${mime};base64,${data}`;
      }
    }
  }
  return null;
}

function extractExternalTaskId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const candidates = [record, record.data].filter(
    (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  );
  for (const candidate of candidates) {
    for (const key of ['request_id', 'requestId', 'task_id', 'taskId', 'id']) {
      const taskId = normalizeGenerationProviderRequestId(candidate[key]);
      if (taskId) {
        return taskId;
      }
    }
  }
  return null;
}

function responseError(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const error = (payload as Record<string, unknown>).error;
    const message = error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>).message : error;
    if (typeof message === 'string' && message.trim()) return message.trim();
    if (typeof (payload as Record<string, unknown>).message === 'string') return String((payload as Record<string, unknown>).message);
  }
  return i18n.t('generationGateway.httpError', { status });
}

export async function submitImageGenerationViaWeb(
  payload: GenerateImagePayload,
  config: ImageProviderConfig,
  options: WebImageApiOptions = {},
): Promise<WebImageSubmission> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = await buildImageGenerationRequest(payload, config, options);
  let response: Response;
  try {
    response = await fetchImpl(request.endpoint, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(i18n.t('generationGateway.corsRequired'));
    }
    throw error;
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw createGenerationProviderError(body, response.status);
  const source = extractSource(body);
  if (source) return { status: 'succeeded', source };
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const externalTaskId = extractExternalTaskId(body);
  if (!externalTaskId) throw new Error(i18n.t('generationGateway.invalidSubmission'));
  return {
    status: 'running',
    handle: {
      externalTaskId,
      statusUrl: sameProviderOrigin(config.baseUrl, record.status_url ?? record.statusUrl),
      resultUrl: sameProviderOrigin(config.baseUrl, record.response_url ?? record.responseUrl),
      protocol: resolveWebImageProtocol(payload.model, payload.providerId, config.protocol),
      baseUrl: config.baseUrl,
      model: payload.model,
    },
  };
}

function pollEndpoint(handle: WebImageTaskHandle): { endpoint: string; method: 'GET' | 'POST'; body?: BodyInit } {
  if (handle.statusUrl) return { endpoint: handle.statusUrl, method: 'GET' };
  if (handle.protocol === 'grsai') {
    return {
      endpoint: endpoint(handle.baseUrl, 'v1/draw/result', ''),
      method: 'POST',
      body: JSON.stringify({ id: handle.externalTaskId }),
    };
  }
  if (handle.protocol === 'kie') {
    const url = new URL(endpoint(handle.baseUrl || 'https://api.kie.ai', 'api/v1/jobs/recordInfo', ''));
    url.searchParams.set('taskId', handle.externalTaskId ?? '');
    return { endpoint: url.toString(), method: 'GET' };
  }
  if (handle.protocol === 'runninghub') {
    return {
      endpoint: endpoint(handle.baseUrl || 'https://www.runninghub.cn/openapi/v2', 'query', ''),
      method: 'POST',
      body: JSON.stringify({ taskId: handle.externalTaskId }),
    };
  }
  if (handle.protocol === 'fal') {
    const model = bareModel(handle.model, 'fal');
    const path = model === 'nano-banana-pro' ? 'fal-ai/nano-banana-pro' : 'fal-ai/nano-banana-2';
    return {
      endpoint: endpoint(handle.baseUrl || 'https://queue.fal.run', `${path}/requests/${encodeURIComponent(handle.externalTaskId ?? '')}/status`, ''),
      method: 'GET',
    };
  }
  return {
    endpoint: endpoint(handle.baseUrl, `images/generations/${encodeURIComponent(handle.externalTaskId ?? '')}`),
    method: 'GET',
  };
}

function sameProviderOrigin(baseUrl: string, candidate: unknown): string | undefined {
  if (typeof candidate !== 'string' || !candidate.trim()) return undefined;
  try {
    const base = normalizeBaseUrl(baseUrl);
    const url = new URL(candidate, base.origin);
    return url.origin === base.origin ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function providerAuthHeaders(protocol: WebImageProtocol, apiKey: string): Record<string, string> {
  if (protocol === 'gemini-native') return { 'x-goog-api-key': apiKey };
  if (protocol === 'fal') return { authorization: `Key ${apiKey}` };
  return { authorization: `Bearer ${apiKey}` };
}

function isRetryablePollResponse(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function pollImageGenerationViaWeb(
  handle: WebImageTaskHandle,
  apiKey: string,
  options: WebImageApiOptions = {},
): Promise<WebImagePollResult> {
  assertNetworkAvailable();
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = pollEndpoint(handle);
  const headers = providerAuthHeaders(handle.protocol, apiKey);
  if (request.method === 'POST') headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetchImpl(request.endpoint, {
      method: request.method,
      headers,
      ...(request.body ? { body: request.body } : {}),
    });
  } catch (error) {
    if (error instanceof TypeError) throw new Error(i18n.t('generationGateway.corsRequired'));
    throw error;
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = createGenerationProviderError(body, response.status);
    return {
      status: 'failed',
      error: error.message,
      errorDetails: error.details,
      requestId: error.requestId,
      retryable: isRetryablePollResponse(response.status),
    };
  }
  let source = extractSource(body);
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const nestedData = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as Record<string, unknown> : undefined;
  const status = String(record.status ?? record.state ?? nestedData?.state ?? nestedData?.status ?? '').toLowerCase();
  if (!source && status === 'completed' && handle.resultUrl) {
    try {
      const resultResponse = await fetchImpl(handle.resultUrl, { headers });
      const resultBody = await resultResponse.json().catch(() => null);
      if (resultResponse.ok) source = extractSource(resultBody);
    } catch (error) {
      if (error instanceof TypeError) throw new Error(i18n.t('generationGateway.corsRequired'));
    }
  }
  if (source) return { status: 'succeeded', source };
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
    const error = createGenerationProviderError(body, response.status);
    return {
      status: 'failed',
      error: error.message,
      errorDetails: error.details,
      requestId: error.requestId,
    };
  }
  return { status: 'running' };
}

export interface DiscoveredWebImageModel { id: string; label?: string }

function parseModels(payload: unknown): DiscoveredWebImageModel[] {
  const records = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? ((payload as Record<string, unknown>).data ?? (payload as Record<string, unknown>).models)
    : payload;
  if (!Array.isArray(records)) return [];
  const seen = new Set<string>();
  return records.flatMap((item): DiscoveredWebImageModel[] => {
    const record = typeof item === 'string' ? { id: item } : item && typeof item === 'object' ? item as Record<string, unknown> : null;
    const id = typeof record?.id === 'string' ? record.id.trim() : typeof record?.name === 'string' ? record.name.trim().replace(/^models\//, '') : '';
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const label = ['displayName', 'display_name', 'label', 'name']
      .map((key) => record?.[key])
      .find((value): value is string => typeof value === 'string' && Boolean(value.trim()) && value.trim() !== id)
      ?.trim();
    const supportedMethods = record?.supportedGenerationMethods ?? record?.supported_generation_methods;
    if (Array.isArray(supportedMethods)
      && !supportedMethods.some((method) => typeof method === 'string' && method === 'generateContent')) return [];
    return [{ id, ...(label ? { label } : {}) }];
  });
}

export async function discoverImageModelsViaWeb(
  request: { base_url: string; api_key: string; protocol?: CustomImageProtocol },
  options: WebImageApiOptions = {},
): Promise<DiscoveredWebImageModel[]> {
  assertNetworkAvailable();
  const apiKey = request.api_key.trim();
  if (!apiKey) throw new Error(i18n.t('generationGateway.apiKeyRequired'));
  const fetchImpl = options.fetchImpl ?? fetch;
  const protocol = request.protocol ?? 'openai-images';
  const staticModels = listImageModels()
    .filter((model) => model.providerId === protocol)
    .map((model) => ({ id: model.id.slice(`${protocol}/`.length), label: model.displayName }));
  if (staticModels.length > 0) return staticModels;
  const headers: Record<string, string> = protocol === 'gemini-native'
    ? { 'x-goog-api-key': apiKey }
    : { authorization: `Bearer ${apiKey}` };
  let response: Response;
  try {
    response = await fetchImpl(resolveImageModelsEndpoint(request.base_url, protocol), { headers });
  } catch (error) {
    if (error instanceof TypeError) throw new Error(i18n.t('generationGateway.corsRequired'));
    throw error;
  }
  let payload = await response.json().catch(() => null);
  if (!response.ok && protocol === 'gemini-native' && response.status === 404) {
    try {
      response = await fetchImpl(resolveGeminiCompatibleModelsEndpoint(request.base_url), { headers });
    } catch (error) {
      if (error instanceof TypeError) throw new Error(i18n.t('generationGateway.corsRequired'));
      throw error;
    }
    payload = await response.json().catch(() => null);
  }
  if (!response.ok) throw new Error(responseError(payload, response.status));
  return parseModels(payload);
}

export const DEFAULT_FHL_IMAGE_BASE_URL = FHL_IMAGE_DEFAULT_BASE_URL;

const DEFAULT_KIE_IMAGE_BASE_URL = 'https://api.kie.ai';
const DEFAULT_KIE_UPLOAD_BASE_URL = 'https://kieai.redpandaai.co';

function resolveKieUploadBaseUrl(baseUrl: string): string {
  try {
    const normalized = normalizeBaseUrl(baseUrl || DEFAULT_KIE_IMAGE_BASE_URL).origin;
    return normalized === DEFAULT_KIE_IMAGE_BASE_URL ? DEFAULT_KIE_UPLOAD_BASE_URL : baseUrl;
  } catch {
    return baseUrl;
  }
}
