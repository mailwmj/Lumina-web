export const BATCH_CROP_MAX_IMAGES = 100;
export const BATCH_CROP_MAX_FILE_BYTES = 60 * 1024 * 1024;

export const BATCH_CROP_TARGETS = [
  { id: '1440x1440', width: 1440, height: 1440 },
  { id: '1440x1920', width: 1440, height: 1920 },
  { id: '1440x2200', width: 1440, height: 2200 },
] as const;

export type BatchCropTargetId = (typeof BATCH_CROP_TARGETS)[number]['id'];
export type BatchCropTarget = (typeof BATCH_CROP_TARGETS)[number];

export interface NormalizedCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BatchCompositionMode = 'crop' | 'fixed';
export type FixedCanvasStage = 'compose' | 'fill';
export type FixedCanvasTool = 'stretch' | null;
export type FixedCanvasStretchDirection = 'left' | 'right' | 'top' | 'bottom';
export type FixedCanvasSelectionAxis = 'horizontal' | 'vertical';
export type FixedCanvasAiStatus = 'idle' | 'processing' | 'failed' | 'accepted';

export interface NormalizedCanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormalizedCanvasPoint {
  x: number;
  y: number;
}

export interface FixedCanvasTransform {
  zoom: number;
  pan: { x: number; y: number };
}

export interface FixedCanvasStretchOperation {
  id: string;
  source: NormalizedCanvasRect;
  direction: FixedCanvasStretchDirection;
  amount: number;
}

export interface FixedCanvasAiDraft {
  status: FixedCanvasAiStatus;
  prompt: string;
  modelId: string;
  resolution: string;
  jobId?: string;
  resultPath?: string;
  errorMessage?: string;
  requiresManualRequery?: boolean;
}

export interface FixedCanvasCompositionSnapshot {
  transform: FixedCanvasTransform;
  stretches: FixedCanvasStretchOperation[];
  redoStretches: FixedCanvasStretchOperation[];
  activeStretchId: string | null;
  ready: boolean;
  ai: FixedCanvasAiDraft;
}

export interface FixedCanvasDraft {
  transform: FixedCanvasTransform;
  stage: FixedCanvasStage;
  tool: FixedCanvasTool;
  selection: NormalizedCanvasRect | null;
  stretches: FixedCanvasStretchOperation[];
  redoStretches: FixedCanvasStretchOperation[];
  activeStretchId: string | null;
  ready: boolean;
  ai: FixedCanvasAiDraft;
  composeUndo: FixedCanvasCompositionSnapshot | null;
}

export type BatchCropItemStatus =
  | 'pending'
  | 'processing'
  | 'auto'
  | 'review'
  | 'adjusted'
  | 'confirmed'
  | 'fixedCompose'
  | 'fixedFill'
  | 'fixedReady'
  | 'aiProcessing'
  | 'aiGenerated'
  | 'aiFailed'
  | 'exporting'
  | 'exported'
  | 'error';

export interface BatchCropImageItem {
  id: string;
  sourcePath: string;
  fileName: string;
  fileSize: number;
  previewPath: string;
  thumbnailPath: string;
  width: number;
  height: number;
  rotationDegrees: number;
  compositionMode: BatchCompositionMode;
  status: BatchCropItemStatus;
  cropStatus: BatchCropItemStatus;
  crop: NormalizedCropRect | null;
  automaticCrop: NormalizedCropRect | null;
  requiresReview: boolean;
  lowResolution: boolean;
  fixedCanvas: FixedCanvasDraft;
  errorMessage?: string;
  outputPath?: string;
}

export interface PreparedBatchCropImageData {
  sourcePath: string;
  fileName: string;
  fileSize: number;
  previewPath: string;
  thumbnailPath: string;
  width: number;
  height: number;
  suggestion?: {
    crop: NormalizedCropRect;
    requiresReview: boolean;
  };
}

export function getBatchCropTarget(id: BatchCropTargetId): BatchCropTarget {
  return BATCH_CROP_TARGETS.find((target) => target.id === id) ?? BATCH_CROP_TARGETS[0];
}

export function normalizeRotationDegrees(value: number): number {
  return ((Math.round(value / 90) * 90) % 360 + 360) % 360;
}

export function createDefaultFixedCanvasDraft(defaultPrompt = ''): FixedCanvasDraft {
  return {
    transform: { zoom: 100, pan: { x: 0, y: 0 } },
    stage: 'compose',
    tool: null,
    selection: null,
    stretches: [],
    redoStretches: [],
    activeStretchId: null,
    ready: false,
    ai: {
      status: 'idle',
      prompt: defaultPrompt,
      modelId: '',
      resolution: '',
    },
    composeUndo: null,
  };
}

export function resolveFixedCanvasImageBox(
  imageWidth: number,
  imageHeight: number,
  targetWidth: number,
  targetHeight: number,
  transform: FixedCanvasTransform
): NormalizedCanvasRect {
  const sourceRatio = Math.max(1, imageWidth) / Math.max(1, imageHeight);
  const targetRatio = Math.max(1, targetWidth) / Math.max(1, targetHeight);
  const base = sourceRatio > targetRatio
    ? { width: 100, height: (100 * targetRatio) / sourceRatio }
    : { width: (100 * sourceRatio) / targetRatio, height: 100 };
  const zoom = Math.min(200, Math.max(20, transform.zoom)) / 100;
  const width = base.width * zoom;
  const height = base.height * zoom;
  return {
    x: 50 + transform.pan.x - width / 2,
    y: 50 + transform.pan.y - height / 2,
    width,
    height,
  };
}

const FIXED_CANVAS_MIN_VISIBLE_AREA = 0.1;

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function visibleAxisFraction(start: number, length: number): number {
  const visible = Math.max(0, Math.min(100, start + length) - Math.max(0, start));
  return visible / Math.max(Number.EPSILON, length);
}

function clampPanAxisForVisibleFraction(
  pan: number,
  imageLength: number,
  requestedFraction: number
): number {
  const maximumFraction = Math.min(1, 100 / Math.max(Number.EPSILON, imageLength));
  const visibleFraction = clampNumber(requestedFraction, 0, maximumFraction);
  const minimumPan = -50 + (visibleFraction - 0.5) * imageLength;
  const maximumPan = 50 + (0.5 - visibleFraction) * imageLength;
  return clampNumber(pan, Math.max(-80, minimumPan), Math.min(80, maximumPan));
}

export function clampFixedCanvasTransform(
  imageWidth: number,
  imageHeight: number,
  targetWidth: number,
  targetHeight: number,
  transform: FixedCanvasTransform
): FixedCanvasTransform {
  const next = {
    zoom: clampNumber(transform.zoom, 20, 200),
    pan: {
      x: clampNumber(transform.pan.x, -80, 80),
      y: clampNumber(transform.pan.y, -80, 80),
    },
  };

  for (let iteration = 0; iteration < 2; iteration += 1) {
    let imageBox = resolveFixedCanvasImageBox(
      imageWidth,
      imageHeight,
      targetWidth,
      targetHeight,
      next
    );
    const visibleY = visibleAxisFraction(imageBox.y, imageBox.height);
    next.pan.x = clampPanAxisForVisibleFraction(
      next.pan.x,
      imageBox.width,
      FIXED_CANVAS_MIN_VISIBLE_AREA / Math.max(Number.EPSILON, visibleY)
    );

    imageBox = resolveFixedCanvasImageBox(
      imageWidth,
      imageHeight,
      targetWidth,
      targetHeight,
      next
    );
    const visibleX = visibleAxisFraction(imageBox.x, imageBox.width);
    next.pan.y = clampPanAxisForVisibleFraction(
      next.pan.y,
      imageBox.height,
      FIXED_CANVAS_MIN_VISIBLE_AREA / Math.max(Number.EPSILON, visibleX)
    );
  }

  return next;
}

export function resolveStretchDestination(
  operation: Pick<FixedCanvasStretchOperation, 'source' | 'direction' | 'amount'>
): NormalizedCanvasRect {
  const { source, direction, amount } = operation;
  if (direction === 'left') {
    return { x: source.x - amount, y: source.y, width: source.width + amount, height: source.height };
  }
  if (direction === 'right') {
    return { x: source.x, y: source.y, width: source.width + amount, height: source.height };
  }
  if (direction === 'top') {
    return { x: source.x, y: source.y - amount, width: source.width, height: source.height + amount };
  }
  return { x: source.x, y: source.y, width: source.width, height: source.height + amount };
}

export function resolveAxisSnappedSelection(
  start: NormalizedCanvasPoint,
  end: NormalizedCanvasPoint,
  lockedAxis: FixedCanvasSelectionAxis | null
): { axis: FixedCanvasSelectionAxis; selection: NormalizedCanvasRect } {
  const horizontalDistance = Math.abs(end.x - start.x);
  const verticalDistance = Math.abs(end.y - start.y);
  const axis = lockedAxis ?? (verticalDistance > horizontalDistance ? 'vertical' : 'horizontal');

  if (axis === 'vertical') {
    return {
      axis,
      selection: {
        x: Math.min(start.x, end.x),
        y: 0,
        width: horizontalDistance,
        height: 100,
      },
    };
  }

  return {
    axis,
    selection: {
      x: 0,
      y: Math.min(start.y, end.y),
      width: 100,
      height: verticalDistance,
    },
  };
}

function pointInsideRect(x: number, y: number, rect: NormalizedCanvasRect): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function rectHasBlankArea(
  area: NormalizedCanvasRect,
  filledRects: NormalizedCanvasRect[]
): boolean {
  if (area.width <= 0 || area.height <= 0) return false;
  const areaRight = area.x + area.width;
  const areaBottom = area.y + area.height;
  const xBoundaries = new Set([area.x, areaRight]);
  const yBoundaries = new Set([area.y, areaBottom]);

  filledRects.forEach((rect) => {
    const left = clampNumber(rect.x, area.x, areaRight);
    const right = clampNumber(rect.x + rect.width, area.x, areaRight);
    const top = clampNumber(rect.y, area.y, areaBottom);
    const bottom = clampNumber(rect.y + rect.height, area.y, areaBottom);
    if (right > left) {
      xBoundaries.add(left);
      xBoundaries.add(right);
    }
    if (bottom > top) {
      yBoundaries.add(top);
      yBoundaries.add(bottom);
    }
  });

  const xs = [...xBoundaries].sort((left, right) => left - right);
  const ys = [...yBoundaries].sort((top, bottom) => top - bottom);
  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
      const x = (xs[xIndex] + xs[xIndex + 1]) / 2;
      const y = (ys[yIndex] + ys[yIndex + 1]) / 2;
      if (!filledRects.some((rect) => pointInsideRect(x, y, rect))) return true;
    }
  }
  return false;
}

export function resolveAvailableStretchDirections(
  selection: NormalizedCanvasRect,
  imageBox: NormalizedCanvasRect,
  stretches: FixedCanvasStretchOperation[]
): Record<FixedCanvasStretchDirection, boolean> {
  const filledRects = [imageBox, ...stretches.map(resolveStretchDestination)];
  return {
    left: rectHasBlankArea(
      { x: 0, y: selection.y, width: selection.x, height: selection.height },
      filledRects
    ),
    right: rectHasBlankArea(
      {
        x: selection.x + selection.width,
        y: selection.y,
        width: 100 - selection.x - selection.width,
        height: selection.height,
      },
      filledRects
    ),
    top: rectHasBlankArea(
      { x: selection.x, y: 0, width: selection.width, height: selection.y },
      filledRects
    ),
    bottom: rectHasBlankArea(
      {
        x: selection.x,
        y: selection.y + selection.height,
        width: selection.width,
        height: 100 - selection.y - selection.height,
      },
      filledRects
    ),
  };
}

export function fixedCanvasHasBlank(
  item: Pick<BatchCropImageItem, 'width' | 'height' | 'fixedCanvas'>,
  target: { width: number; height: number }
): boolean {
  if (item.fixedCanvas.ai.status === 'accepted' && item.fixedCanvas.ai.resultPath) return false;
  const imageBox = resolveFixedCanvasImageBox(
    item.width,
    item.height,
    target.width,
    target.height,
    item.fixedCanvas.transform
  );
  const filledRects = [
    imageBox,
    ...item.fixedCanvas.stretches.map(resolveStretchDestination),
  ];
  return rectHasBlankArea({ x: 0, y: 0, width: 100, height: 100 }, filledRects);
}

export function resolveFixedCanvasStatus(draft: FixedCanvasDraft): BatchCropItemStatus {
  if (draft.ai.status === 'processing') return 'aiProcessing';
  if (draft.ai.status === 'accepted') return 'aiGenerated';
  if (draft.ai.status === 'failed') return 'aiFailed';
  if (draft.ready) return 'fixedReady';
  return draft.stage === 'compose' ? 'fixedCompose' : 'fixedFill';
}

export function isBatchCompositionModeLocked(
  item: BatchCropImageItem | null,
  busy: boolean
): boolean {
  return busy
    || item?.status === 'aiProcessing'
    || item?.fixedCanvas.ai.status === 'processing';
}

export function isBatchCropItemReadyForExport(item: BatchCropImageItem): boolean {
  if (item.compositionMode === 'fixed') {
    return item.fixedCanvas.ready && item.fixedCanvas.ai.status !== 'processing';
  }
  return Boolean(item.crop) && !['pending', 'processing', 'review', 'error'].includes(item.cropStatus);
}

export function fitImageWithinBounds(
  imageWidth: number,
  imageHeight: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  const safeImageWidth = Math.max(1, imageWidth);
  const safeImageHeight = Math.max(1, imageHeight);
  const scale = Math.min(
    Math.max(1, maxWidth) / safeImageWidth,
    Math.max(1, maxHeight) / safeImageHeight,
    1
  );

  return {
    width: Math.max(1, Math.round(safeImageWidth * scale)),
    height: Math.max(1, Math.round(safeImageHeight * scale)),
  };
}

export function createCenteredCrop(
  imageWidth: number,
  imageHeight: number,
  targetWidth: number,
  targetHeight: number
): NormalizedCropRect {
  const safeImageWidth = Math.max(1, imageWidth);
  const safeImageHeight = Math.max(1, imageHeight);
  const targetRatio = Math.max(1, targetWidth) / Math.max(1, targetHeight);
  const imageRatio = safeImageWidth / safeImageHeight;

  if (imageRatio > targetRatio) {
    const width = targetRatio / imageRatio;
    return { x: (1 - width) / 2, y: 0, width, height: 1 };
  }

  const height = imageRatio / targetRatio;
  return { x: 0, y: (1 - height) / 2, width: 1, height };
}

export function isLowResolutionCrop(
  imageWidth: number,
  imageHeight: number,
  crop: NormalizedCropRect,
  targetWidth: number,
  targetHeight: number
): boolean {
  return imageWidth * crop.width < targetWidth || imageHeight * crop.height < targetHeight;
}

export function createBatchCropItemFromPreparedImage(
  prepared: PreparedBatchCropImageData,
  target: BatchCropTarget,
  id: string,
  rotationDegrees: number,
  fallbackErrorMessage: string,
  defaultAiPrompt = ''
): BatchCropImageItem {
  const crop = prepared.suggestion?.crop
    ?? createCenteredCrop(prepared.width, prepared.height, target.width, target.height);
  const requiresReview = prepared.suggestion?.requiresReview ?? true;
  const compositionMode: BatchCompositionMode = target.id === '1440x1440' ? 'fixed' : 'crop';
  const cropStatus: BatchCropItemStatus = requiresReview ? 'review' : 'auto';
  const fixedCanvas = createDefaultFixedCanvasDraft(defaultAiPrompt);

  return {
    id,
    sourcePath: prepared.sourcePath,
    fileName: prepared.fileName,
    fileSize: prepared.fileSize,
    previewPath: prepared.previewPath,
    thumbnailPath: prepared.thumbnailPath,
    width: prepared.width,
    height: prepared.height,
    rotationDegrees,
    compositionMode,
    status: compositionMode === 'fixed' ? resolveFixedCanvasStatus(fixedCanvas) : cropStatus,
    cropStatus,
    crop,
    automaticCrop: crop,
    requiresReview,
    lowResolution: isLowResolutionCrop(
      prepared.width,
      prepared.height,
      crop,
      target.width,
      target.height
    ),
    fixedCanvas,
    errorMessage: prepared.suggestion ? undefined : fallbackErrorMessage,
  };
}

export function formatBatchCropFileSize(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  return megabytes < 1 ? `${megabytes.toFixed(1)} MB` : `${Math.round(megabytes)} MB`;
}
