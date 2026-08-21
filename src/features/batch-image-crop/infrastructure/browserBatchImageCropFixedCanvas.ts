import {
  normalizeRotationDegrees,
  resolveStretchDestination,
  type FixedCanvasStretchOperation,
  type FixedCanvasTransform,
  type NormalizedCanvasRect,
} from '../domain';
import {
  drawRotatedImage,
  validateBrowserImageDimensions,
  type BrowserImageCanvasDependencies,
  type DecodedBrowserImage,
} from './browserBatchImageCropImage';

const MAX_RENDER_PIXELS = 120_000_000;

export interface BrowserFixedCanvasCompositionPayload {
  sourcePath: string;
  targetWidth: number;
  targetHeight: number;
  rotationDegrees: number;
  transform: FixedCanvasTransform;
  stretches: FixedCanvasStretchOperation[];
  resultSourcePath?: string;
}

export interface BrowserFixedCanvasRenderResult {
  base: HTMLCanvasElement;
  mask: HTMLCanvasElement;
}

function rotatedDimensions(width: number, height: number, rotationDegrees: number) {
  return normalizeRotationDegrees(rotationDegrees) % 180 === 0 ? { width, height } : { width: height, height: width };
}

function assertPayload(payload: BrowserFixedCanvasCompositionPayload): void {
  if (!Number.isInteger(payload.targetWidth) || !Number.isInteger(payload.targetHeight)
    || payload.targetWidth <= 0 || payload.targetHeight <= 0) throw new Error('INVALID_TARGET_SIZE');
  if (payload.targetWidth * payload.targetHeight > MAX_RENDER_PIXELS) throw new Error('IMAGE_DIMENSIONS_TOO_LARGE');
  if (!Number.isFinite(payload.transform.zoom) || payload.transform.zoom < 20 || payload.transform.zoom > 200
    || !Number.isFinite(payload.transform.pan.x) || !Number.isFinite(payload.transform.pan.y)
    || Math.abs(payload.transform.pan.x) > 80 || Math.abs(payload.transform.pan.y) > 80) {
    throw new Error('INVALID_FIXED_CANVAS_TRANSFORM');
  }
}

function placedImageRect(
  image: DecodedBrowserImage,
  payload: BrowserFixedCanvasCompositionPayload,
): { left: number; top: number; width: number; height: number } {
  const rotated = rotatedDimensions(image.width, image.height, payload.rotationDegrees);
  const sourceRatio = rotated.width / rotated.height;
  const targetRatio = payload.targetWidth / payload.targetHeight;
  const base = sourceRatio > targetRatio
    ? { width: payload.targetWidth, height: payload.targetWidth / sourceRatio }
    : { width: payload.targetHeight * sourceRatio, height: payload.targetHeight };
  const scale = payload.transform.zoom / 100;
  const width = Math.max(1, Math.round(base.width * scale));
  const height = Math.max(1, Math.round(base.height * scale));
  return {
    left: Math.round(payload.targetWidth * (0.5 + payload.transform.pan.x / 100) - width / 2),
    top: Math.round(payload.targetHeight * (0.5 + payload.transform.pan.y / 100) - height / 2),
    width,
    height,
  };
}

function normalizedPixels(rect: NormalizedCanvasRect, width: number, height: number) {
  const x = Math.max(0, Math.min(width, Math.floor(rect.x / 100 * width)));
  const y = Math.max(0, Math.min(height, Math.floor(rect.y / 100 * height)));
  const right = Math.max(0, Math.min(width, Math.ceil((rect.x + rect.width) / 100 * width)));
  const bottom = Math.max(0, Math.min(height, Math.ceil((rect.y + rect.height) / 100 * height)));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function drawStretches(base: HTMLCanvasElement, stretches: FixedCanvasStretchOperation[], createCanvas: () => HTMLCanvasElement): void {
  if (stretches.length === 0) return;
  const context = base.getContext('2d');
  if (!context) throw new Error('INVALID_IMAGE');
  const source = createCanvas();
  source.width = base.width;
  source.height = base.height;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) throw new Error('INVALID_IMAGE');
  sourceContext.drawImage(base, 0, 0);
  stretches.forEach((operation) => {
    const from = normalizedPixels(operation.source, base.width, base.height);
    const to = normalizedPixels(resolveStretchDestination(operation), base.width, base.height);
    if (from && to) context.drawImage(source, from.x, from.y, from.width, from.height, to.x, to.y, to.width, to.height);
  });
}

function drawMask(
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
    const destination = normalizedPixels(resolveStretchDestination(operation), mask.width, mask.height);
    if (destination) context.fillRect(destination.x, destination.y, destination.width, destination.height);
  });
  return mask;
}

function protectGeneratedPixels(base: HTMLCanvasElement, mask: HTMLCanvasElement, generated: DecodedBrowserImage): void {
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

export async function renderBrowserFixedCanvas(
  payload: BrowserFixedCanvasCompositionPayload,
  readSource: (sourcePath: string) => Promise<Blob>,
  dependencies: BrowserImageCanvasDependencies,
): Promise<BrowserFixedCanvasRenderResult> {
  assertPayload(payload);
  const image = await dependencies.decodeImage(await readSource(payload.sourcePath));
  let generated: DecodedBrowserImage | null = null;
  try {
    validateBrowserImageDimensions(image.width, image.height);
    const base = dependencies.createCanvas();
    base.width = payload.targetWidth;
    base.height = payload.targetHeight;
    const context = base.getContext('2d');
    if (!context) throw new Error('INVALID_IMAGE');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, base.width, base.height);
    const placed = placedImageRect(image, payload);
    context.save();
    context.translate(placed.left, placed.top);
    drawRotatedImage(context, image, payload.rotationDegrees, placed);
    context.restore();
    drawStretches(base, payload.stretches, dependencies.createCanvas);
    const mask = drawMask(payload, placed, dependencies.createCanvas);
    if (payload.resultSourcePath?.trim()) {
      generated = await dependencies.decodeImage(await readSource(payload.resultSourcePath));
      protectGeneratedPixels(base, mask, generated);
    }
    return { base, mask };
  } finally {
    image.close?.();
    generated?.close?.();
  }
}
