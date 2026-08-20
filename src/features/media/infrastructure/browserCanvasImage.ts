export interface BrowserImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserCropOptions {
  aspectRatio?: string;
  customAspectRatio?: unknown;
  cropX?: unknown;
  cropY?: unknown;
  cropWidth?: unknown;
  cropHeight?: unknown;
}

export interface BrowserRasterImage {
  blob: Blob;
  width: number;
  height: number;
}

function parseAspectRatio(value: string): number {
  const [width, height] = value.split(':').map(Number);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width / height
    : 1;
}

function splitIntoSegments(totalSize: number, segmentCount: number): number[] {
  const baseSize = Math.floor(totalSize / segmentCount);
  const remainder = totalSize % segmentCount;
  return Array.from(
    { length: segmentCount },
    (_item, index) => baseSize + (index < remainder ? 1 : 0),
  );
}

export function resolveBrowserCropRect(
  imageWidth: number,
  imageHeight: number,
  options: BrowserCropOptions,
): BrowserImageRect {
  const width = Math.max(1, Math.floor(imageWidth));
  const height = Math.max(1, Math.floor(imageHeight));
  const cropX = Number(options.cropX);
  const cropY = Number(options.cropY);
  const cropWidth = Number(options.cropWidth);
  const cropHeight = Number(options.cropHeight);
  const hasManualCrop = [cropX, cropY, cropWidth, cropHeight].every(Number.isFinite)
    && cropWidth > 0
    && cropHeight > 0;

  if (hasManualCrop) {
    const x = Math.min(width - 1, Math.max(0, Math.floor(cropX)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(cropY)));
    return {
      x,
      y,
      width: Math.max(1, Math.min(Math.floor(cropWidth), width - x)),
      height: Math.max(1, Math.min(Math.floor(cropHeight), height - y)),
    };
  }

  const aspectRatio = options.aspectRatio ?? '1:1';
  if (aspectRatio === 'free' || aspectRatio === 'original') {
    return { x: 0, y: 0, width, height };
  }

  const targetRatio = parseAspectRatio(
    aspectRatio === 'custom' ? String(options.customAspectRatio ?? '') : aspectRatio,
  );
  const sourceRatio = width / height;
  const cropWidthForRatio = sourceRatio > targetRatio ? height * targetRatio : width;
  const cropHeightForRatio = sourceRatio > targetRatio ? height : width / targetRatio;
  return {
    x: Math.floor((width - cropWidthForRatio) / 2),
    y: Math.floor((height - cropHeightForRatio) / 2),
    width: Math.max(1, Math.floor(cropWidthForRatio)),
    height: Math.max(1, Math.floor(cropHeightForRatio)),
  };
}

export function resolveStoryboardSplitGeometry(
  imageWidth: number,
  imageHeight: number,
  rows: number,
  cols: number,
  lineThickness: number,
): BrowserImageRect[] {
  const safeRows = Math.max(1, Math.floor(rows));
  const safeCols = Math.max(1, Math.floor(cols));
  const width = Math.max(1, Math.floor(imageWidth));
  const height = Math.max(1, Math.floor(imageHeight));
  const maxLineByWidth = safeCols > 1 ? Math.floor((width - safeCols) / (safeCols - 1)) : Number.MAX_SAFE_INTEGER;
  const maxLineByHeight = safeRows > 1 ? Math.floor((height - safeRows) / (safeRows - 1)) : Number.MAX_SAFE_INTEGER;
  const safeLineThickness = Math.max(0, Math.min(Math.floor(lineThickness), maxLineByWidth, maxLineByHeight));
  const usableWidth = width - (safeCols - 1) * safeLineThickness;
  const usableHeight = height - (safeRows - 1) * safeLineThickness;
  if (usableWidth < safeCols || usableHeight < safeRows) {
    throw new Error('Storyboard grid exceeds the available image pixels.');
  }
  const columnWidths = splitIntoSegments(usableWidth, safeCols);
  const rowHeights = splitIntoSegments(usableHeight, safeRows);
  const rectangles: BrowserImageRect[] = [];
  let y = 0;

  for (let row = 0; row < safeRows; row += 1) {
    let x = 0;
    for (let col = 0; col < safeCols; col += 1) {
      rectangles.push({ x, y, width: columnWidths[col], height: rowHeights[row] });
      x += columnWidths[col] + safeLineThickness;
    }
    y += rowHeights[row] + safeLineThickness;
  }

  return rectangles;
}

async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error('Unable to encode the processed image.'));
    }, 'image/png');
  });
}

async function loadBrowserImage(source: string): Promise<HTMLImageElement> {
  const image = new Image();
  return await new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load the source image.'));
    image.src = source;
  });
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  return canvas;
}

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to initialize the image canvas.');
  }
  return context;
}

export async function cropBrowserImage(
  source: string,
  options: BrowserCropOptions,
): Promise<BrowserRasterImage> {
  const image = await loadBrowserImage(source);
  const crop = resolveBrowserCropRect(image.naturalWidth, image.naturalHeight, options);
  const canvas = createCanvas(crop.width, crop.height);
  getContext(canvas).drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  return { blob: await canvasToPngBlob(canvas), width: crop.width, height: crop.height };
}

function resolveAnnotationY(position: string, imageHeight: number, boxHeight: number): number {
  if (position === 'top') return boxHeight / 2 + 24;
  if (position === 'center') return imageHeight / 2;
  return imageHeight - boxHeight / 2 - 24;
}

export async function annotateBrowserImage(
  source: string,
  options: Record<string, unknown>,
): Promise<BrowserRasterImage> {
  const [{ drawAnnotations, parseAnnotationItems }, image] = await Promise.all([
    import('@/features/canvas/tools/annotation'),
    loadBrowserImage(source),
  ]);
  const canvas = createCanvas(image.naturalWidth, image.naturalHeight);
  const context = getContext(canvas);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const annotations = parseAnnotationItems(options.annotations);

  if (annotations.length > 0) {
    drawAnnotations(context, annotations);
  } else {
    const text = String(options.text ?? '').trim();
    if (text) {
      const fontSize = Math.max(24, Math.round(canvas.width * 0.04));
      const paddingX = Math.round(fontSize * 0.8);
      const paddingY = Math.round(fontSize * 0.6);
      context.font = `600 ${fontSize}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const boxWidth = context.measureText(text).width + paddingX * 2;
      const boxHeight = fontSize + paddingY * 2;
      const x = canvas.width / 2;
      const y = resolveAnnotationY(String(options.position ?? 'bottom'), canvas.height, boxHeight);
      context.fillStyle = 'rgba(0, 0, 0, 0.45)';
      context.fillRect(x - boxWidth / 2, y - boxHeight / 2, boxWidth, boxHeight);
      context.fillStyle = String(options.color ?? '#FFFFFF');
      context.fillText(text, x, y);
    }
  }

  return { blob: await canvasToPngBlob(canvas), width: canvas.width, height: canvas.height };
}

function resolveLineThickness(
  width: number,
  height: number,
  rows: number,
  cols: number,
  lineThicknessPercent: unknown,
  lineThicknessFallback: unknown,
): number {
  const percentage = Number(lineThicknessPercent);
  if (!Number.isFinite(percentage)) {
    return Math.max(0, Math.floor(Number(lineThicknessFallback) || 0));
  }
  if (percentage <= 0) {
    return 0;
  }
  const raw = Math.max(1, Math.round((Math.min(width, height) * percentage) / 100));
  const maxByWidth = cols > 1 ? Math.floor((width - cols) / (cols - 1)) : Number.MAX_SAFE_INTEGER;
  const maxByHeight = rows > 1 ? Math.floor((height - rows) / (rows - 1)) : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(raw, maxByWidth, maxByHeight));
}

export async function splitBrowserImage(
  source: string,
  rows: number,
  cols: number,
  lineThicknessPercent: unknown,
  lineThicknessFallback: unknown,
): Promise<BrowserRasterImage[]> {
  const image = await loadBrowserImage(source);
  const safeRows = Math.max(1, Math.floor(rows));
  const safeCols = Math.max(1, Math.floor(cols));
  const rectangles = resolveStoryboardSplitGeometry(
    image.naturalWidth,
    image.naturalHeight,
    safeRows,
    safeCols,
    resolveLineThickness(
      image.naturalWidth,
      image.naturalHeight,
      safeRows,
      safeCols,
      lineThicknessPercent,
      lineThicknessFallback,
    ),
  );

  return await Promise.all(rectangles.map(async (rectangle) => {
    const canvas = createCanvas(rectangle.width, rectangle.height);
    getContext(canvas).drawImage(
      image,
      rectangle.x,
      rectangle.y,
      rectangle.width,
      rectangle.height,
      0,
      0,
      rectangle.width,
      rectangle.height,
    );
    return {
      blob: await canvasToPngBlob(canvas),
      width: rectangle.width,
      height: rectangle.height,
    };
  }));
}
