import {
  BATCH_CROP_MAX_FILE_BYTES,
  createCenteredCrop,
  normalizeRotationDegrees,
  resolveStretchDestination,
  type BatchCropTarget,
  type FixedCanvasStretchOperation,
  type FixedCanvasTransform,
  type NormalizedCanvasRect,
  type NormalizedCropRect,
  type PreparedBatchCropImageData,
} from '../domain';

const BATCH_CROP_MAX_PIXELS = 120_000_000;
const PREVIEW_LONGEST_EDGE = 2560;
const THUMBNAIL_LONGEST_EDGE = 160;
const MAX_RENDER_PIXELS = 120_000_000;

interface DecodedBrowserImage {
  width: number;
  height: number;
  close?: () => void;
}

interface BrowserBatchImageCropGatewayOptions {
  createCanvas?: () => HTMLCanvasElement;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  decodeImage?: (file: Blob) => Promise<DecodedBrowserImage>;
  readSource?: (sourcePath: string) => Promise<Blob>;
}

export interface BrowserBatchCropRenderRequest {
  sourcePath: string;
  rotationDegrees: number;
  crop: NormalizedCropRect;
  target: Pick<BatchCropTarget, 'width' | 'height'>;
}

export interface BrowserFixedCanvasCompositionPayload {
  sourcePath: string;
  targetWidth: number;
  targetHeight: number;
  rotationDegrees: number;
  transform: FixedCanvasTransform;
  stretches: FixedCanvasStretchOperation[];
  resultSourcePath?: string;
}

export interface BrowserRenderedFixedCanvas {
  renderedPath: string;
  blankMaskPath: string;
}

export interface BrowserBatchImageCropGateway {
  prepare(
    batchId: string,
    file: File,
    rotationDegrees: number,
    target: Pick<BatchCropTarget, 'width' | 'height'>,
  ): Promise<PreparedBatchCropImageData>;
  renderCrop(request: BrowserBatchCropRenderRequest): Promise<Blob>;
  renderFixedCanvas(
    batchId: string,
    payload: BrowserFixedCanvasCompositionPayload,
  ): Promise<BrowserRenderedFixedCanvas>;
  renderFixedCanvasBlob(payload: BrowserFixedCanvasCompositionPayload): Promise<Blob>;
  cleanup(batchId: string): void;
}

function isSupportedImageFile(file: File): boolean {
  if (file.type === 'image/jpeg' || file.type === 'image/png') return true;
  return !file.type && /\.(jpe?g|png)$/i.test(file.name);
}

function validateFile(file: File): void {
  if (!isSupportedImageFile(file)) throw new Error('UNSUPPORTED_FORMAT');
  if (file.size > BATCH_CROP_MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE');
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('INVALID_IMAGE');
  }
  if (width * height > BATCH_CROP_MAX_PIXELS) throw new Error('IMAGE_DIMENSIONS_TOO_LARGE');
}

function fittedDimensions(width: number, height: number, maximumEdge: number) {
  const scale = Math.min(1, maximumEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function rotatedDimensions(width: number, height: number, rotationDegrees: number) {
  return normalizeRotationDegrees(rotationDegrees) % 180 === 0
    ? { width, height }
    : { width: height, height: width };
}

function drawRotatedImage(
  context: CanvasRenderingContext2D,
  image: DecodedBrowserImage,
  rotationDegrees: number,
  destination: { width: number; height: number },
): void {
  const rotation = normalizeRotationDegrees(rotationDegrees);
  const source = image as unknown as CanvasImageSource;
  const scale = rotation % 180 === 0
    ? destination.width / image.width
    : destination.width / image.height;
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

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('INVALID_IMAGE'));
    }, type, quality);
  });
}

function defaultImageDecoder(file: Blob): Promise<DecodedBrowserImage> {
  if (typeof globalThis.createImageBitmap !== 'function') {
    return Promise.reject(new Error('INVALID_IMAGE'));
  }
  return globalThis.createImageBitmap(file, { imageOrientation: 'from-image' });
}

async function defaultSourceReader(sourcePath: string): Promise<Blob> {
  const response = await fetch(sourcePath);
  if (!response.ok) throw new Error('SOURCE_NOT_FOUND');
  return response.blob();
}

function clampedPixelCrop(
  width: number,
  height: number,
  crop: NormalizedCropRect,
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(width - 1, Math.round(crop.x * width)));
  const y = Math.max(0, Math.min(height - 1, Math.round(crop.y * height)));
  const requestedWidth = Math.max(1, Math.round(crop.width * width));
  const requestedHeight = Math.max(1, Math.round(crop.height * height));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, requestedWidth)),
    height: Math.max(1, Math.min(height - y, requestedHeight)),
  };
}

function sourceCropForRotation(
  image: DecodedBrowserImage,
  rotationDegrees: number,
  crop: NormalizedCropRect,
) {
  const rotation = normalizeRotationDegrees(rotationDegrees);
  const rotated = rotatedDimensions(image.width, image.height, rotation);
  const rect = clampedPixelCrop(rotated.width, rotated.height, crop);
  if (rotation === 90) {
    return { x: rect.y, y: image.height - rect.x - rect.width, width: rect.height, height: rect.width };
  }
  if (rotation === 180) {
    return {
      x: image.width - rect.x - rect.width,
      y: image.height - rect.y - rect.height,
      width: rect.width,
      height: rect.height,
    };
  }
  if (rotation === 270) {
    return { x: image.width - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width };
  }
  return rect;
}

function drawSourceCrop(
  context: CanvasRenderingContext2D,
  image: DecodedBrowserImage,
  rotationDegrees: number,
  crop: NormalizedCropRect,
  target: Pick<BatchCropTarget, 'width' | 'height'>,
): void {
  const sourceCrop = sourceCropForRotation(image, rotationDegrees, crop);
  const source = image as unknown as CanvasImageSource;
  const rotation = normalizeRotationDegrees(rotationDegrees);
  context.save();
  if (rotation === 90) {
    context.translate(target.width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(source, sourceCrop.x, sourceCrop.y, sourceCrop.width, sourceCrop.height, 0, 0, target.height, target.width);
  } else if (rotation === 180) {
    context.translate(target.width, target.height);
    context.rotate(Math.PI);
    context.drawImage(source, sourceCrop.x, sourceCrop.y, sourceCrop.width, sourceCrop.height, 0, 0, target.width, target.height);
  } else if (rotation === 270) {
    context.translate(0, target.height);
    context.rotate(-Math.PI / 2);
    context.drawImage(source, sourceCrop.x, sourceCrop.y, sourceCrop.width, sourceCrop.height, 0, 0, target.height, target.width);
  } else {
    context.drawImage(source, sourceCrop.x, sourceCrop.y, sourceCrop.width, sourceCrop.height, 0, 0, target.width, target.height);
  }
  context.restore();
}

function placedImageRect(
  image: DecodedBrowserImage,
  payload: Pick<BrowserFixedCanvasCompositionPayload, 'targetWidth' | 'targetHeight' | 'transform'>,
  rotationDegrees: number,
): { left: number; top: number; width: number; height: number } {
  const rotated = rotatedDimensions(image.width, image.height, rotationDegrees);
  const sourceRatio = rotated.width / rotated.height;
  const targetRatio = payload.targetWidth / payload.targetHeight;
  const base = sourceRatio > targetRatio
    ? { width: payload.targetWidth, height: payload.targetWidth / sourceRatio }
    : { width: payload.targetHeight * sourceRatio, height: payload.targetHeight };
  const scale = payload.transform.zoom / 100;
  const width = Math.max(1, Math.round(base.width * scale));
  const height = Math.max(1, Math.round(base.height * scale));
  const centerX = payload.targetWidth * (0.5 + payload.transform.pan.x / 100);
  const centerY = payload.targetHeight * (0.5 + payload.transform.pan.y / 100);
  return {
    left: Math.round(centerX - width / 2),
    top: Math.round(centerY - height / 2),
    width,
    height,
  };
}

function normalizedRectPixels(
  rect: NormalizedCanvasRect,
  targetWidth: number,
  targetHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  const x = Math.max(0, Math.min(targetWidth, Math.floor(rect.x / 100 * targetWidth)));
  const y = Math.max(0, Math.min(targetHeight, Math.floor(rect.y / 100 * targetHeight)));
  const right = Math.max(0, Math.min(targetWidth, Math.ceil((rect.x + rect.width) / 100 * targetWidth)));
  const bottom = Math.max(0, Math.min(targetHeight, Math.ceil((rect.y + rect.height) / 100 * targetHeight)));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function assertFixedCanvasPayload(payload: BrowserFixedCanvasCompositionPayload): void {
  if (!Number.isInteger(payload.targetWidth) || !Number.isInteger(payload.targetHeight)
    || payload.targetWidth <= 0 || payload.targetHeight <= 0) {
    throw new Error('INVALID_TARGET_SIZE');
  }
  if (payload.targetWidth * payload.targetHeight > MAX_RENDER_PIXELS) {
    throw new Error('IMAGE_DIMENSIONS_TOO_LARGE');
  }
  if (!Number.isFinite(payload.transform.zoom) || payload.transform.zoom < 20 || payload.transform.zoom > 200
    || !Number.isFinite(payload.transform.pan.x) || !Number.isFinite(payload.transform.pan.y)
    || Math.abs(payload.transform.pan.x) > 80 || Math.abs(payload.transform.pan.y) > 80) {
    throw new Error('INVALID_FIXED_CANVAS_TRANSFORM');
  }
}

function drawStretchPatches(
  base: HTMLCanvasElement,
  stretches: FixedCanvasStretchOperation[],
  createCanvas: () => HTMLCanvasElement,
): void {
  if (stretches.length === 0) return;
  const baseContext = base.getContext('2d');
  if (!baseContext) throw new Error('INVALID_IMAGE');
  const source = createCanvas();
  source.width = base.width;
  source.height = base.height;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) throw new Error('INVALID_IMAGE');
  sourceContext.drawImage(base, 0, 0);
  stretches.forEach((operation) => {
    const from = normalizedRectPixels(operation.source, base.width, base.height);
    const to = normalizedRectPixels(resolveStretchDestination(operation), base.width, base.height);
    if (!from || !to) return;
    baseContext.drawImage(source, from.x, from.y, from.width, from.height, to.x, to.y, to.width, to.height);
  });
}

function renderBlankMask(
  payload: BrowserFixedCanvasCompositionPayload,
  placed: { left: number; top: number; width: number; height: number },
  createCanvas: () => HTMLCanvasElement,
): HTMLCanvasElement {
  const mask = createCanvas();
  mask.width = payload.targetWidth;
  mask.height = payload.targetHeight;
  const context = mask.getContext('2d');
  if (!context) throw new Error('INVALID_IMAGE');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, mask.width, mask.height);
  context.fillStyle = '#000000';
  context.fillRect(placed.left, placed.top, placed.width, placed.height);
  payload.stretches.forEach((operation) => {
    const destination = normalizedRectPixels(resolveStretchDestination(operation), mask.width, mask.height);
    if (destination) context.fillRect(destination.x, destination.y, destination.width, destination.height);
  });
  return mask;
}

function applyGeneratedPixels(
  base: HTMLCanvasElement,
  mask: HTMLCanvasElement,
  generated: DecodedBrowserImage,
): void {
  const baseContext = base.getContext('2d');
  const maskContext = mask.getContext('2d');
  if (!baseContext || !maskContext) throw new Error('INVALID_IMAGE');
  const generatedCanvas = document.createElement('canvas');
  generatedCanvas.width = base.width;
  generatedCanvas.height = base.height;
  const generatedContext = generatedCanvas.getContext('2d');
  if (!generatedContext) throw new Error('INVALID_IMAGE');
  generatedContext.fillStyle = '#ffffff';
  generatedContext.fillRect(0, 0, generatedCanvas.width, generatedCanvas.height);
  generatedContext.drawImage(generated as unknown as CanvasImageSource, 0, 0, generatedCanvas.width, generatedCanvas.height);
  const basePixels = baseContext.getImageData(0, 0, base.width, base.height);
  const generatedPixels = generatedContext.getImageData(0, 0, base.width, base.height);
  const maskPixels = maskContext.getImageData(0, 0, base.width, base.height);
  for (let index = 0; index < basePixels.data.length; index += 4) {
    if (maskPixels.data[index] > 127) {
      basePixels.data[index] = generatedPixels.data[index];
      basePixels.data[index + 1] = generatedPixels.data[index + 1];
      basePixels.data[index + 2] = generatedPixels.data[index + 2];
      basePixels.data[index + 3] = generatedPixels.data[index + 3];
    }
  }
  baseContext.putImageData(basePixels, 0, 0);
}

export function createBrowserBatchImageCropGateway(
  options: BrowserBatchImageCropGatewayOptions = {},
): BrowserBatchImageCropGateway {
  const createCanvas = options.createCanvas ?? (() => document.createElement('canvas'));
  const createObjectURL = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectURL = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  const decodeImage = options.decodeImage ?? defaultImageDecoder;
  const readSource = options.readSource ?? defaultSourceReader;
  const urlsByBatch = new Map<string, Set<string>>();

  const registerUrl = (batchId: string, blob: Blob): string => {
    const url = createObjectURL(blob);
    const urls = urlsByBatch.get(batchId) ?? new Set<string>();
    urls.add(url);
    urlsByBatch.set(batchId, urls);
    return url;
  };

  const createPreview = async (
    image: DecodedBrowserImage,
    rotationDegrees: number,
    maximumEdge: number,
  ): Promise<Blob> => {
    const rotated = rotatedDimensions(image.width, image.height, rotationDegrees);
    const destination = fittedDimensions(rotated.width, rotated.height, maximumEdge);
    const canvas = createCanvas();
    canvas.width = destination.width;
    canvas.height = destination.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('INVALID_IMAGE');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, destination.width, destination.height);
    drawRotatedImage(context, image, rotationDegrees, destination);
    return canvasBlob(canvas, 'image/jpeg', maximumEdge === THUMBNAIL_LONGEST_EDGE ? 0.82 : 0.9);
  };

  const renderFixedCanvas = async (payload: BrowserFixedCanvasCompositionPayload) => {
    assertFixedCanvasPayload(payload);
    const image = await decodeImage(await readSource(payload.sourcePath));
    let generated: DecodedBrowserImage | null = null;
    try {
      validateDimensions(image.width, image.height);
      const base = createCanvas();
      base.width = payload.targetWidth;
      base.height = payload.targetHeight;
      const context = base.getContext('2d');
      if (!context) throw new Error('INVALID_IMAGE');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, base.width, base.height);
      const placed = placedImageRect(image, payload, payload.rotationDegrees);
      context.save();
      context.translate(placed.left, placed.top);
      drawRotatedImage(context, image, payload.rotationDegrees, placed);
      context.restore();
      drawStretchPatches(base, payload.stretches, createCanvas);
      const mask = renderBlankMask(payload, placed, createCanvas);
      if (payload.resultSourcePath?.trim()) {
        generated = await decodeImage(await readSource(payload.resultSourcePath));
        applyGeneratedPixels(base, mask, generated);
      }
      return { base, mask };
    } finally {
      image.close?.();
      generated?.close?.();
    }
  };

  return {
    async prepare(batchId, file, rotationDegrees, target) {
      validateFile(file);
      const image = await decodeImage(file);
      try {
        validateDimensions(image.width, image.height);
        const dimensions = rotatedDimensions(image.width, image.height, rotationDegrees);
        const [preview, thumbnail] = await Promise.all([
          createPreview(image, rotationDegrees, PREVIEW_LONGEST_EDGE),
          createPreview(image, rotationDegrees, THUMBNAIL_LONGEST_EDGE),
        ]);
        const crop = createCenteredCrop(dimensions.width, dimensions.height, target.width, target.height);
        return {
          sourceKey: `${file.name}:${file.size}:${file.lastModified}`,
          sourcePath: registerUrl(batchId, file),
          fileName: file.name,
          fileSize: file.size,
          previewPath: registerUrl(batchId, preview),
          thumbnailPath: registerUrl(batchId, thumbnail),
          width: dimensions.width,
          height: dimensions.height,
          suggestion: {
            crop,
            requiresReview: crop.width * crop.height < 0.8,
          },
        };
      } finally {
        image.close?.();
      }
    },
    async renderCrop(request) {
      const image = await decodeImage(await readSource(request.sourcePath));
      try {
        validateDimensions(image.width, image.height);
        const canvas = createCanvas();
        canvas.width = request.target.width;
        canvas.height = request.target.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('INVALID_IMAGE');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        drawSourceCrop(context, image, request.rotationDegrees, request.crop, request.target);
        return canvasBlob(canvas, 'image/jpeg', 1);
      } finally {
        image.close?.();
      }
    },
    async renderFixedCanvas(batchId, payload) {
      const { base, mask } = await renderFixedCanvas(payload);
      const [rendered, blankMask] = await Promise.all([
        canvasBlob(base, 'image/jpeg', 1),
        canvasBlob(mask, 'image/png', 1),
      ]);
      return {
        renderedPath: registerUrl(batchId, rendered),
        blankMaskPath: registerUrl(batchId, blankMask),
      };
    },
    async renderFixedCanvasBlob(payload) {
      const { base } = await renderFixedCanvas(payload);
      return canvasBlob(base, 'image/jpeg', 1);
    },
    cleanup(batchId) {
      const urls = urlsByBatch.get(batchId);
      if (!urls) return;
      urls.forEach(revokeObjectURL);
      urlsByBatch.delete(batchId);
    },
  };
}

export const browserBatchImageCropGateway = createBrowserBatchImageCropGateway();
