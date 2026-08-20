import type {
  StoryboardMergeRequest,
  StoryboardMergeResult,
} from '@/features/media/domain/mediaProcessor';

export interface BrowserStoryboardLayoutInput {
  sourceCellWidth: number;
  sourceCellHeight: number;
  rows: number;
  cols: number;
  cellGap: number;
  outerPadding: number;
  noteHeight: number;
  fontSize: number;
  maxDimension: number;
}

export interface BrowserStoryboardLayout {
  canvasWidth: number;
  canvasHeight: number;
  cellWidth: number;
  cellHeight: number;
  gap: number;
  padding: number;
  noteHeight: number;
  fontSize: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toSafeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

export function resolveBrowserStoryboardLayout(
  input: BrowserStoryboardLayoutInput,
): BrowserStoryboardLayout {
  const rows = Math.max(1, toSafeInteger(input.rows, 1));
  const cols = Math.max(1, toSafeInteger(input.cols, 1));
  const sourceCellWidth = Math.max(1, toSafeInteger(input.sourceCellWidth, 1));
  const sourceCellHeight = Math.max(1, toSafeInteger(input.sourceCellHeight, 1));
  const rawGap = clamp(toSafeInteger(input.cellGap, 0), 0, 240);
  const rawPadding = clamp(toSafeInteger(input.outerPadding, 0), 0, 360);
  const rawNoteHeight = clamp(toSafeInteger(input.noteHeight, 0), 0, 360);
  const rawFontSize = clamp(toSafeInteger(input.fontSize, 10), 10, 240);
  const maxDimension = clamp(toSafeInteger(input.maxDimension, 4096), 1024, 8192);
  const rawWidth = rawPadding * 2 + cols * sourceCellWidth + (cols - 1) * rawGap;
  const rawHeight = rawPadding * 2 + rows * (sourceCellHeight + rawNoteHeight) + (rows - 1) * rawGap;
  const scale = Math.min(1, maxDimension / Math.max(1, rawWidth, rawHeight));
  const cellWidth = Math.max(8, Math.round(sourceCellWidth * scale));
  const cellHeight = Math.max(8, Math.round(sourceCellHeight * scale));
  const gap = Math.max(0, Math.round(rawGap * scale));
  const padding = Math.max(0, Math.round(rawPadding * scale));
  const noteHeight = Math.max(0, Math.round(rawNoteHeight * scale));
  const fontSize = Math.max(9, Math.round(rawFontSize * scale));

  return {
    canvasWidth: padding * 2 + cols * cellWidth + (cols - 1) * gap,
    canvasHeight: padding * 2 + rows * (cellHeight + noteHeight) + (rows - 1) * gap,
    cellWidth,
    cellHeight,
    gap,
    padding,
    noteHeight,
    fontSize,
  };
}

async function loadFrame(source: string): Promise<HTMLImageElement | null> {
  if (!source.trim()) {
    return null;
  }
  const image = new Image();
  return await new Promise((resolve) => {
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

function drawFrame(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | null,
  x: number,
  y: number,
  layout: BrowserStoryboardLayout,
  imageFit: 'cover' | 'contain',
): void {
  context.fillStyle = 'rgba(0, 0, 0, 0.35)';
  context.fillRect(x, y, layout.cellWidth, layout.cellHeight);
  if (!image) {
    return;
  }

  const ratio = imageFit === 'contain'
    ? Math.min(layout.cellWidth / image.naturalWidth, layout.cellHeight / image.naturalHeight)
    : Math.max(layout.cellWidth / image.naturalWidth, layout.cellHeight / image.naturalHeight);
  const drawWidth = Math.max(1, Math.round(image.naturalWidth * ratio));
  const drawHeight = Math.max(1, Math.round(image.naturalHeight * ratio));

  context.save();
  context.beginPath();
  context.rect(x, y, layout.cellWidth, layout.cellHeight);
  context.clip();
  context.drawImage(
    image,
    x + (layout.cellWidth - drawWidth) / 2,
    y + (layout.cellHeight - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  context.restore();
}

export async function mergeBrowserStoryboard(
  request: StoryboardMergeRequest,
): Promise<StoryboardMergeResult> {
  const rows = Math.max(1, toSafeInteger(request.rows, 1));
  const cols = Math.max(1, toSafeInteger(request.cols, 1));
  const totalCells = rows * cols;
  const frames = await Promise.all(
    Array.from({ length: totalCells }, (_item, index) => loadFrame(request.frameSources[index] ?? '')),
  );
  const referenceFrame = frames.find((frame): frame is HTMLImageElement => frame !== null);
  if (!referenceFrame) {
    throw new Error('没有可导出的图片');
  }
  const layout = resolveBrowserStoryboardLayout({
    sourceCellWidth: referenceFrame.naturalWidth,
    sourceCellHeight: referenceFrame.naturalHeight,
    rows,
    cols,
    cellGap: request.cellGap,
    outerPadding: request.outerPadding,
    noteHeight: request.noteHeight,
    fontSize: request.fontSize,
    maxDimension: request.maxDimension,
  });
  const canvas = document.createElement('canvas');
  canvas.width = layout.canvasWidth;
  canvas.height = layout.canvasHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to initialize the storyboard canvas.');
  }
  context.fillStyle = request.backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const imageFit = request.imageFit === 'contain' ? 'contain' : 'cover';

  for (let index = 0; index < totalCells; index += 1) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const x = layout.padding + col * (layout.cellWidth + layout.gap);
    const y = layout.padding + row * (layout.cellHeight + layout.noteHeight + layout.gap);
    drawFrame(context, frames[index], x, y, layout, imageFit);
    context.fillStyle = 'rgba(255, 255, 255, 0.22)';
    if (col < cols - 1) {
      context.fillRect(x + layout.cellWidth - 1, y, 1, layout.cellHeight);
    }
    if (row < rows - 1) {
      context.fillRect(x, y + layout.cellHeight - 1, layout.cellWidth, 1);
    }
  }

  return {
    imagePath: canvas.toDataURL('image/png'),
    canvasWidth: layout.canvasWidth,
    canvasHeight: layout.canvasHeight,
    cellWidth: layout.cellWidth,
    cellHeight: layout.cellHeight,
    gap: layout.gap,
    padding: layout.padding,
    noteHeight: layout.noteHeight,
    fontSize: layout.fontSize,
    textOverlayApplied: false,
  };
}
