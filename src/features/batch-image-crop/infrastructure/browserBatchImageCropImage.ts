import {
  BATCH_CROP_MAX_FILE_BYTES,
  createCenteredCrop,
  normalizeRotationDegrees,
  type BatchCropTarget,
  type NormalizedCropRect,
  type PreparedBatchCropImageData,
} from '../domain';

const BATCH_CROP_MAX_PIXELS = 120_000_000;
const PREVIEW_LONGEST_EDGE = 2560;
const THUMBNAIL_LONGEST_EDGE = 160;

export interface DecodedBrowserImage {
  width: number;
  height: number;
  close?: () => void;
}

export interface BrowserImageCanvasDependencies {
  createCanvas: () => HTMLCanvasElement;
  decodeImage: (file: Blob) => Promise<DecodedBrowserImage>;
}

export interface BrowserBatchCropRenderRequest {
  sourcePath: string;
  rotationDegrees: number;
  crop: NormalizedCropRect;
  target: Pick<BatchCropTarget, 'width' | 'height'>;
}

export function createDefaultBrowserImageDecoder(file: Blob): Promise<DecodedBrowserImage> {
  if (typeof globalThis.createImageBitmap !== 'function') {
    return Promise.reject(new Error('INVALID_IMAGE'));
  }
  return globalThis.createImageBitmap(file, { imageOrientation: 'from-image' });
}

export function validateBrowserImageDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('INVALID_IMAGE');
  }
  if (width * height > BATCH_CROP_MAX_PIXELS) throw new Error('IMAGE_DIMENSIONS_TOO_LARGE');
}

function validateFile(file: File): void {
  const supported = file.type === 'image/jpeg' || file.type === 'image/png'
    || (!file.type && /\.(jpe?g|png)$/i.test(file.name));
  if (!supported) throw new Error('UNSUPPORTED_FORMAT');
  if (file.size > BATCH_CROP_MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE');
}

function rotatedDimensions(width: number, height: number, rotationDegrees: number) {
  return normalizeRotationDegrees(rotationDegrees) % 180 === 0
    ? { width, height }
    : { width: height, height: width };
}

function fittedDimensions(width: number, height: number, maximumEdge: number) {
  const scale = Math.min(1, maximumEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('INVALID_IMAGE')), type, quality);
  });
}

export function drawRotatedImage(
  context: CanvasRenderingContext2D,
  image: DecodedBrowserImage,
  rotationDegrees: number,
  destination: { width: number; height: number },
): void {
  const rotation = normalizeRotationDegrees(rotationDegrees);
  const source = image as unknown as CanvasImageSource;
  const scale = rotation % 180 === 0 ? destination.width / image.width : destination.width / image.height;
  context.save();
  if (rotation === 90) {
    context.translate(destination.width, 0);
    context.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    context.translate(destination.width, destination.height);
    context.rotate(Math.PI);
  } else if (rotation === 270) {
    context.translate(0, destination.height);
    context.rotate(-Math.PI / 2);
  }
  context.drawImage(source, 0, 0, image.width * scale, image.height * scale);
  context.restore();
}

function sourceCropForRotation(image: DecodedBrowserImage, rotationDegrees: number, crop: NormalizedCropRect) {
  const rotation = normalizeRotationDegrees(rotationDegrees);
  const rotated = rotatedDimensions(image.width, image.height, rotation);
  const x = Math.max(0, Math.min(rotated.width - 1, Math.round(crop.x * rotated.width)));
  const y = Math.max(0, Math.min(rotated.height - 1, Math.round(crop.y * rotated.height)));
  const width = Math.max(1, Math.min(rotated.width - x, Math.round(crop.width * rotated.width)));
  const height = Math.max(1, Math.min(rotated.height - y, Math.round(crop.height * rotated.height)));
  if (rotation === 90) return { x: y, y: image.height - x - width, width: height, height: width };
  if (rotation === 180) return { x: image.width - x - width, y: image.height - y - height, width, height };
  if (rotation === 270) return { x: image.width - y - height, y: x, width: height, height: width };
  return { x, y, width, height };
}

export async function prepareBrowserBatchCropImage(
  file: File,
  rotationDegrees: number,
  target: Pick<BatchCropTarget, 'width' | 'height'>,
  registerUrl: (blob: Blob) => string,
  dependencies: BrowserImageCanvasDependencies,
): Promise<PreparedBatchCropImageData> {
  validateFile(file);
  const image = await dependencies.decodeImage(file);
  try {
    validateBrowserImageDimensions(image.width, image.height);
    const dimensions = rotatedDimensions(image.width, image.height, rotationDegrees);
    const createPreview = async (maximumEdge: number) => {
      const destination = fittedDimensions(dimensions.width, dimensions.height, maximumEdge);
      const canvas = dependencies.createCanvas();
      canvas.width = destination.width;
      canvas.height = destination.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('INVALID_IMAGE');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, destination.width, destination.height);
      drawRotatedImage(context, image, rotationDegrees, destination);
      return await canvasBlob(canvas, 'image/jpeg', maximumEdge === THUMBNAIL_LONGEST_EDGE ? 0.82 : 0.9);
    };
    const [preview, thumbnail] = await Promise.all([createPreview(PREVIEW_LONGEST_EDGE), createPreview(THUMBNAIL_LONGEST_EDGE)]);
    const crop = createCenteredCrop(dimensions.width, dimensions.height, target.width, target.height);
    return {
      sourceKey: `${file.name}:${file.size}:${file.lastModified}`,
      sourcePath: registerUrl(file),
      fileName: file.name,
      fileSize: file.size,
      previewPath: registerUrl(preview),
      thumbnailPath: registerUrl(thumbnail),
      width: dimensions.width,
      height: dimensions.height,
      suggestion: { crop, requiresReview: crop.width * crop.height < 0.8 },
    };
  } finally {
    image.close?.();
  }
}

export async function renderBrowserBatchCrop(
  request: BrowserBatchCropRenderRequest,
  readSource: (sourcePath: string) => Promise<Blob>,
  dependencies: BrowserImageCanvasDependencies,
): Promise<Blob> {
  const image = await dependencies.decodeImage(await readSource(request.sourcePath));
  try {
    validateBrowserImageDimensions(image.width, image.height);
    const canvas = dependencies.createCanvas();
    canvas.width = request.target.width;
    canvas.height = request.target.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('INVALID_IMAGE');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const crop = sourceCropForRotation(image, request.rotationDegrees, request.crop);
    const rotation = normalizeRotationDegrees(request.rotationDegrees);
    context.save();
    if (rotation === 90) {
      context.translate(request.target.width, 0);
      context.rotate(Math.PI / 2);
      context.drawImage(image as unknown as CanvasImageSource, crop.x, crop.y, crop.width, crop.height, 0, 0, request.target.height, request.target.width);
    } else if (rotation === 180) {
      context.translate(request.target.width, request.target.height);
      context.rotate(Math.PI);
      context.drawImage(image as unknown as CanvasImageSource, crop.x, crop.y, crop.width, crop.height, 0, 0, request.target.width, request.target.height);
    } else if (rotation === 270) {
      context.translate(0, request.target.height);
      context.rotate(-Math.PI / 2);
      context.drawImage(image as unknown as CanvasImageSource, crop.x, crop.y, crop.width, crop.height, 0, 0, request.target.height, request.target.width);
    } else {
      context.drawImage(image as unknown as CanvasImageSource, crop.x, crop.y, crop.width, crop.height, 0, 0, request.target.width, request.target.height);
    }
    context.restore();
    return await canvasBlob(canvas, 'image/jpeg', 1);
  } finally {
    image.close?.();
  }
}
