const DEFAULT_PREVIEW_MAX_DIMENSION = 512;
const LOCAL_PATH_PREFIX_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

export interface PreparedNodeImage {
  imageUrl: string;
  previewImageUrl: string;
  aspectRatio: string;
}

export interface PreparedNodeImagePreview {
  previewImageUrl: string;
  aspectRatio: string;
}

interface ErrorWithDetails extends Error {
  details?: string;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createImagePipelineError(message: string, details?: string, cause?: unknown): ErrorWithDetails {
  const error: ErrorWithDetails = new Error(message);
  const detailParts = [details, cause === undefined ? undefined : `cause: ${stringifyUnknown(cause)}`]
    .filter((part): part is string => Boolean(part));
  if (detailParts.length > 0) error.details = detailParts.join('\n');
  return error;
}

export function parseAspectRatio(value: string): number {
  const [width, height] = value.split(':').map((item) => Number(item));
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width / height
    : 1;
}

export function reduceAspectRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '1:1';
  const greatestCommonDivisor = (left: number, right: number): number => {
    let a = Math.abs(left);
    let b = Math.abs(right);
    while (b !== 0) {
      [a, b] = [b, a % b];
    }
    return a || 1;
  };
  const divisor = greatestCommonDivisor(Math.round(width), Math.round(height));
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

export function isLikelyLocalImagePath(imageUrl: string): boolean {
  if (!imageUrl) return false;
  const lower = imageUrl.toLowerCase();
  if (
    lower.startsWith('data:')
    || lower.startsWith('http://')
    || lower.startsWith('https://')
    || lower.startsWith('blob:')
    || lower.startsWith('file://')
    || lower.startsWith('asset:')
  ) {
    return false;
  }
  return LOCAL_PATH_PREFIX_PATTERN.test(imageUrl);
}

export function resolveImageDisplayUrl(imageUrl: string): string {
  return imageUrl;
}

export function resolveVideoDisplayUrl(videoUrl: string): string {
  return videoUrl;
}

export function resolveAudioDisplayUrl(audioUrl: string): string {
  return audioUrl;
}

export async function persistImageLocally(source: string, projectId?: string): Promise<string> {
  void projectId;
  return source;
}

export async function loadImageElement(source: string): Promise<HTMLImageElement> {
  const image = new Image();
  const displaySource = resolveImageDisplayUrl(source);
  if (
    displaySource.startsWith('http://')
    || displaySource.startsWith('https://')
    || displaySource.startsWith('asset:')
  ) {
    image.crossOrigin = 'anonymous';
  }
  return await new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(createImagePipelineError(
      '图片加载失败',
      `source=${source}\ndisplaySource=${displaySource}`,
    ));
    image.src = displaySource;
  });
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const reader = new FileReader();
  return await new Promise((resolve, reject) => {
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('图片转换失败'));
    reader.readAsDataURL(blob);
  });
}

export async function imageUrlToDataUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith('data:')) return imageUrl;
  try {
    const response = await fetch(resolveImageDisplayUrl(imageUrl));
    if (!response.ok) {
      throw new Error(`status=${response.status}`);
    }
    return await blobToDataUrl(await response.blob());
  } catch (error) {
    throw createImagePipelineError(
      isLikelyLocalImagePath(imageUrl) ? '无法读取本地图片数据' : '无法下载图片数据',
      `source=${imageUrl}`,
      error,
    );
  }
}

export function extractBase64Payload(dataUrl: string): string {
  const [, payload = ''] = dataUrl.split(',');
  return payload;
}

export async function readFileAsDataUrl(file: File): Promise<string> {
  return await blobToDataUrl(file);
}

export async function prepareNodeImageFromFile(
  file: File,
  maxPreviewDimension = DEFAULT_PREVIEW_MAX_DIMENSION,
  projectId?: string,
): Promise<PreparedNodeImage> {
  return await prepareNodeImage(await readFileAsDataUrl(file), maxPreviewDimension, projectId);
}

export async function detectAspectRatio(imageUrl: string): Promise<string> {
  const image = await loadImageElement(imageUrl);
  return reduceAspectRatio(image.naturalWidth, image.naturalHeight);
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

function resolvePreviewMimeType(imageUrl: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (imageUrl.startsWith('data:image/png')) return 'image/png';
  if (imageUrl.startsWith('data:image/webp')) return 'image/webp';
  return 'image/jpeg';
}

function renderPreviewDataUrl(
  image: HTMLImageElement,
  sourceDataUrl: string,
  maxDimension: number,
  forceReencode = false,
  outputMimeType?: 'image/jpeg' | 'image/png' | 'image/webp',
): string {
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (!forceReencode && longestSide <= maxDimension) return sourceDataUrl;
  const scale = Math.min(1, maxDimension / longestSide);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return sourceDataUrl;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const mimeType = outputMimeType ?? resolvePreviewMimeType(sourceDataUrl);
  return mimeType === 'image/jpeg' || mimeType === 'image/webp'
    ? canvas.toDataURL(mimeType, 0.82)
    : canvas.toDataURL(mimeType);
}

export async function createPreviewDataUrl(
  imageUrl: string,
  maxDimension = DEFAULT_PREVIEW_MAX_DIMENSION,
  forceReencode = false,
  outputMimeType?: 'image/jpeg' | 'image/png' | 'image/webp',
): Promise<string> {
  const normalizedDataUrl = await imageUrlToDataUrl(imageUrl);
  const image = await loadImageElement(normalizedDataUrl);
  return renderPreviewDataUrl(
    image,
    normalizedDataUrl,
    Math.max(64, Math.floor(maxDimension)),
    forceReencode,
    outputMimeType,
  );
}

export async function createNodeImagePreview(
  imageUrl: string,
  maxPreviewDimension = DEFAULT_PREVIEW_MAX_DIMENSION,
  projectId?: string,
): Promise<PreparedNodeImagePreview> {
  const trimmedImageUrl = imageUrl.trim();
  if (!trimmedImageUrl) {
    throw createImagePipelineError('未获取到可用图片结果', 'imageUrl is empty');
  }
  const normalizedDataUrl = await imageUrlToDataUrl(trimmedImageUrl);
  const image = await loadImageElement(normalizedDataUrl);
  const previewDataUrl = renderPreviewDataUrl(
    image,
    normalizedDataUrl,
    Math.max(64, Math.floor(maxPreviewDimension)),
  );
  return {
    previewImageUrl: previewDataUrl === normalizedDataUrl
      ? trimmedImageUrl
      : await persistImageLocally(previewDataUrl, projectId),
    aspectRatio: reduceAspectRatio(image.naturalWidth, image.naturalHeight),
  };
}

export async function prepareNodeImage(
  imageUrl: string,
  maxPreviewDimension = DEFAULT_PREVIEW_MAX_DIMENSION,
  projectId?: string,
): Promise<PreparedNodeImage> {
  const trimmedImageUrl = imageUrl.trim();
  if (!trimmedImageUrl) {
    throw createImagePipelineError('未获取到可用图片结果', 'imageUrl is empty');
  }
  try {
    const normalizedDataUrl = await imageUrlToDataUrl(trimmedImageUrl);
    const image = await loadImageElement(normalizedDataUrl);
    const previewDataUrl = renderPreviewDataUrl(
      image,
      normalizedDataUrl,
      Math.max(64, Math.floor(maxPreviewDimension)),
    );
    return {
      imageUrl: await persistImageLocally(trimmedImageUrl, projectId),
      previewImageUrl: previewDataUrl === normalizedDataUrl
        ? trimmedImageUrl
        : await persistImageLocally(previewDataUrl, projectId),
      aspectRatio: reduceAspectRatio(image.naturalWidth, image.naturalHeight),
    };
  } catch (error) {
    throw createImagePipelineError('生成结果无法解析为图片', `source=${trimmedImageUrl}`, error);
  }
}
