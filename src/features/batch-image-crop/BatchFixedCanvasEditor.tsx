import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  Redo2,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Undo2,
} from '@/components/ui/icons';
import { UiButton, UiTooltip } from '@/components/ui';
import {
  clampFixedCanvasTransform,
  fitImageWithinBounds,
  fixedCanvasHasBlank,
  resolveAvailableStretchDirections,
  resolveAxisSnappedSelection,
  resolveFixedCanvasImageBox,
  type BatchCropImageItem,
  type BatchCropTarget,
  type FixedCanvasDraft,
  type FixedCanvasSelectionAxis,
  type FixedCanvasStretchDirection,
  type FixedCanvasStretchOperation,
  type FixedCanvasTransform,
  type NormalizedCanvasRect,
} from './domain';
import {
  BatchFixedCanvasSelection,
  type FixedCanvasCorner,
} from './BatchFixedCanvasSelection';
import {
  BatchFixedCanvasNavigation,
  BatchFixedCanvasStretchPatch,
  BatchFixedCanvasTransformFrame,
} from './BatchFixedCanvasPreview';
import { resolveBatchCropDisplayUrl } from './infrastructure/tauriBatchImageCropGateway';

type Gesture =
  | { type: 'move'; start: Point; transform: FixedCanvasTransform }
  | {
      type: 'scale';
      corner: Corner;
      anchor: Point;
      imageBox: NormalizedCanvasRect;
      transform: FixedCanvasTransform;
      distance: number;
    }
  | { type: 'select'; start: Point; axis: FixedCanvasSelectionAxis | null }
  | { type: 'selection-move'; start: Point; selection: NormalizedCanvasRect }
  | { type: 'selection-resize'; anchor: Point; selection: NormalizedCanvasRect }
  | { type: 'stretch'; source: NormalizedCanvasRect; direction: FixedCanvasStretchDirection };

type Corner = FixedCanvasCorner;
interface Point { x: number; y: number }

const SELECTION_AXIS_LOCK_THRESHOLD = 3;

interface BatchFixedCanvasEditorProps {
  item: BatchCropImageItem;
  target: BatchCropTarget;
  index: number;
  total: number;
  busy: boolean;
  onChange: (draft: FixedCanvasDraft) => void;
  onOpenAi: () => void;
  onRequeryAi: () => void;
  onCancelAi: () => void;
  onToast: (message: string) => void;
  onPrevious: () => void;
  onNext: () => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function pointInCanvas(event: ReactPointerEvent, element: HTMLElement): Point {
  const rect = element.getBoundingClientRect();
  return {
    x: clamp(((event.clientX - rect.left) / Math.max(1, rect.width)) * 100, 0, 100),
    y: clamp(((event.clientY - rect.top) / Math.max(1, rect.height)) * 100, 0, 100),
  };
}

function intersects(left: NormalizedCanvasRect, right: NormalizedCanvasRect): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function resetAiDraft(draft: FixedCanvasDraft): FixedCanvasDraft['ai'] {
  return {
    status: 'idle',
    prompt: draft.ai.prompt,
    modelId: draft.ai.modelId,
    resolution: draft.ai.resolution,
  };
}

function hasCompositionResult(draft: FixedCanvasDraft): boolean {
  return draft.ready || draft.stretches.length > 0 || draft.ai.status !== 'idle';
}

function transformsMatch(left: FixedCanvasTransform, right: FixedCanvasTransform): boolean {
  return left.zoom === right.zoom
    && left.pan.x === right.pan.x
    && left.pan.y === right.pan.y;
}

export function BatchFixedCanvasEditor({
  item,
  target,
  index,
  total,
  busy,
  onChange,
  onOpenAi,
  onRequeryAi,
  onCancelAi,
  onToast,
  onPrevious,
  onNext,
}: BatchFixedCanvasEditorProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [liveTransform, setLiveTransform] = useState<FixedCanvasTransform | null>(null);
  const [liveSelection, setLiveSelection] = useState<NormalizedCanvasRect | null>(null);
  const [liveStretch, setLiveStretch] = useState<FixedCanvasStretchOperation | null>(null);
  const draft = item.fixedCanvas;
  const locked = busy || draft.ai.status === 'processing';
  const transform = liveTransform ?? draft.transform;
  const selection = liveSelection ?? draft.selection;
  const imageBox = useMemo(
    () => resolveFixedCanvasImageBox(item.width, item.height, target.width, target.height, transform),
    [item.height, item.width, target.height, target.width, transform]
  );
  const hasBlank = fixedCanvasHasBlank(item, target);
  const showingAiResult = draft.stage === 'fill'
    && Boolean(draft.ai.resultPath)
    && draft.ai.status === 'accepted';
  const imageSource = resolveBatchCropDisplayUrl(
    showingAiResult && draft.ai.resultPath ? draft.ai.resultPath : item.previewPath
  );

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({ width: Math.max(0, rect.width), height: Math.max(0, rect.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setGesture(null);
    setLiveTransform(null);
    setLiveSelection(null);
    setLiveStretch(null);
  }, [item.id]);

  const canvasSize = useMemo(() => fitImageWithinBounds(
    target.width,
    target.height,
    Math.max(1, viewportSize.width - 48),
    Math.max(1, viewportSize.height - 48)
  ), [target.height, target.width, viewportSize.height, viewportSize.width]);

  const commitTransform = (nextTransform: FixedCanvasTransform) => {
    const clampedTransform = clampFixedCanvasTransform(
      item.width,
      item.height,
      target.width,
      target.height,
      nextTransform
    );
    if (transformsMatch(draft.transform, clampedTransform)) return;
    const composeUndo = draft.composeUndo ?? (hasCompositionResult(draft) ? {
      transform: draft.transform,
      stretches: draft.stretches,
      redoStretches: draft.redoStretches,
      activeStretchId: draft.activeStretchId,
      ready: draft.ready,
      ai: draft.ai,
    } : null);
    onChange({
      ...draft,
      transform: clampedTransform,
      selection: null,
      stretches: [],
      redoStretches: [],
      activeStretchId: null,
      ready: false,
      ai: resetAiDraft(draft),
      composeUndo,
    });
  };

  const startMove = (event: ReactPointerEvent) => {
    if (locked || draft.stage !== 'compose' || !canvasRef.current) return;
    event.stopPropagation();
    canvasRef.current.setPointerCapture?.(event.pointerId);
    setGesture({ type: 'move', start: pointInCanvas(event, canvasRef.current), transform: draft.transform });
  };

  const startScale = (event: ReactPointerEvent, corner: Corner) => {
    if (locked || !canvasRef.current) return;
    event.stopPropagation();
    const point = pointInCanvas(event, canvasRef.current);
    const anchor = {
      x: corner.endsWith('e') ? imageBox.x : imageBox.x + imageBox.width,
      y: corner.startsWith('s') ? imageBox.y : imageBox.y + imageBox.height,
    };
    canvasRef.current.setPointerCapture?.(event.pointerId);
    setGesture({
      type: 'scale',
      corner,
      anchor,
      imageBox,
      transform: draft.transform,
      distance: Math.max(1, Math.hypot(point.x - anchor.x, point.y - anchor.y)),
    });
  };

  const startStretch = (event: ReactPointerEvent, direction: FixedCanvasStretchDirection) => {
    if (!selection || !canvasRef.current || locked) return;
    event.stopPropagation();
    canvasRef.current.setPointerCapture?.(event.pointerId);
    setGesture({ type: 'stretch', source: selection, direction });
  };

  const startSelectionMove = (event: ReactPointerEvent) => {
    if (!selection || !canvasRef.current || locked) return;
    event.stopPropagation();
    canvasRef.current.setPointerCapture?.(event.pointerId);
    setGesture({
      type: 'selection-move',
      start: pointInCanvas(event, canvasRef.current),
      selection,
    });
  };

  const startSelectionResize = (event: ReactPointerEvent, corner: Corner) => {
    if (!selection || !canvasRef.current || locked) return;
    event.stopPropagation();
    const anchor = {
      x: corner.endsWith('e') ? selection.x : selection.x + selection.width,
      y: corner.startsWith('s') ? selection.y : selection.y + selection.height,
    };
    canvasRef.current.setPointerCapture?.(event.pointerId);
    setGesture({ type: 'selection-resize', anchor, selection });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (locked || draft.stage !== 'fill' || draft.tool !== 'stretch' || !canvasRef.current) return;
    const point = pointInCanvas(event, canvasRef.current);
    canvasRef.current.setPointerCapture?.(event.pointerId);
    setGesture({ type: 'select', start: point, axis: null });
    setLiveSelection(null);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture || !canvasRef.current) return;
    const point = pointInCanvas(event, canvasRef.current);
    if (gesture.type === 'move') {
      setLiveTransform(clampFixedCanvasTransform(
        item.width,
        item.height,
        target.width,
        target.height,
        {
          zoom: gesture.transform.zoom,
          pan: {
            x: gesture.transform.pan.x + point.x - gesture.start.x,
            y: gesture.transform.pan.y + point.y - gesture.start.y,
          },
        }
      ));
      return;
    }
    if (gesture.type === 'scale') {
      const distance = Math.hypot(point.x - gesture.anchor.x, point.y - gesture.anchor.y);
      const zoom = clamp(gesture.transform.zoom * distance / gesture.distance, 20, 200);
      const factor = zoom / gesture.transform.zoom;
      const width = gesture.imageBox.width * factor;
      const height = gesture.imageBox.height * factor;
      const signX = gesture.corner.endsWith('e') ? 1 : -1;
      const signY = gesture.corner.startsWith('s') ? 1 : -1;
      setLiveTransform(clampFixedCanvasTransform(
        item.width,
        item.height,
        target.width,
        target.height,
        {
          zoom: Math.round(zoom),
          pan: {
            x: gesture.anchor.x + signX * width / 2 - 50,
            y: gesture.anchor.y + signY * height / 2 - 50,
          },
        }
      ));
      return;
    }
    if (gesture.type === 'select') {
      const distance = Math.max(
        Math.abs(point.x - gesture.start.x),
        Math.abs(point.y - gesture.start.y)
      );
      if (!gesture.axis && distance < SELECTION_AXIS_LOCK_THRESHOLD) return;
      const resolved = resolveAxisSnappedSelection(gesture.start, point, gesture.axis);
      if (!gesture.axis) setGesture({ ...gesture, axis: resolved.axis });
      setLiveSelection(resolved.selection);
      return;
    }
    if (gesture.type === 'selection-move') {
      const vertical = gesture.selection.height >= 99.9;
      setLiveSelection(vertical ? {
        ...gesture.selection,
        x: clamp(
          gesture.selection.x + point.x - gesture.start.x,
          0,
          100 - gesture.selection.width
        ),
        y: 0,
      } : {
        ...gesture.selection,
        x: 0,
        y: clamp(
          gesture.selection.y + point.y - gesture.start.y,
          0,
          100 - gesture.selection.height
        ),
      });
      return;
    }
    if (gesture.type === 'selection-resize') {
      const axis: FixedCanvasSelectionAxis = gesture.selection.height >= 99.9
        ? 'vertical'
        : 'horizontal';
      setLiveSelection(resolveAxisSnappedSelection(gesture.anchor, point, axis).selection);
      return;
    }
    const source = gesture.source;
    let amount = 0;
    if (gesture.direction === 'left') amount = clamp(source.x - point.x, 0, source.x);
    if (gesture.direction === 'right') amount = clamp(point.x - source.x - source.width, 0, 100 - source.x - source.width);
    if (gesture.direction === 'top') amount = clamp(source.y - point.y, 0, source.y);
    if (gesture.direction === 'bottom') amount = clamp(point.y - source.y - source.height, 0, 100 - source.y - source.height);
    setLiveStretch({ id: 'live', source, direction: gesture.direction, amount });
  };

  const handlePointerUp = () => {
    if (!gesture) return;
    if ((gesture.type === 'move' || gesture.type === 'scale') && liveTransform) {
      commitTransform(liveTransform);
    }
    if (
      gesture.type === 'select'
      || gesture.type === 'selection-move'
      || gesture.type === 'selection-resize'
    ) {
      if (!liveSelection || liveSelection.width < 2 || liveSelection.height < 2) {
        onToast(t('batchCrop.fixed.selectionTooSmall'));
      } else if (!intersects(liveSelection, imageBox)) {
        onToast(t('batchCrop.fixed.selectionOutsideImage'));
      } else {
        onChange({ ...draft, selection: liveSelection, activeStretchId: null });
      }
    }
    if (gesture.type === 'stretch' && liveStretch && liveStretch.amount > 0.5) {
      const operation = { ...liveStretch, id: crypto.randomUUID() };
      onChange({
        ...draft,
        stretches: [...draft.stretches, operation],
        redoStretches: [],
        activeStretchId: null,
        selection: null,
        tool: 'stretch',
        ready: true,
        ai: resetAiDraft(draft),
      });
      onToast(t('batchCrop.fixed.stretchAdded', { count: draft.stretches.length + 1 }));
    }
    setGesture(null);
    setLiveTransform(null);
    setLiveSelection(null);
    setLiveStretch(null);
  };

  const cancelGesture = () => {
    setGesture(null);
    setLiveTransform(null);
    setLiveSelection(null);
    setLiveStretch(null);
  };

  useEffect(() => {
    if (draft.stage !== 'fill' || draft.tool !== 'stretch' || locked) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (gesture) {
        event.preventDefault();
        cancelGesture();
      } else if (draft.selection) {
        event.preventDefault();
        onChange({ ...draft, selection: null });
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [draft, gesture, locked, onChange]);

  const availableDirections = selection
    ? resolveAvailableStretchDirections(selection, imageBox, draft.stretches)
    : { left: false, right: false, top: false, bottom: false };
  const operations = liveTransform && hasCompositionResult(draft)
    ? []
    : liveStretch
      ? [...draft.stretches, liveStretch]
      : draft.stretches;
  const undoCompositionChange = () => {
    const snapshot = draft.composeUndo;
    if (!snapshot) return;
    onChange({
      ...draft,
      ...snapshot,
      stage: 'fill',
      tool: null,
      selection: null,
      composeUndo: null,
    });
  };

  return (
    <>
      <div ref={viewportRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/55 p-6">
        <div
          ref={canvasRef}
          data-testid="fixed-canvas"
          className={`relative bg-white shadow-[0_16px_42px_rgba(0,0,0,0.38)] ring-1 ring-white/15 ${
            draft.stage === 'compose' ? 'cursor-move' : draft.tool === 'stretch' ? 'cursor-crosshair' : 'cursor-default'
          }`}
          style={{ width: canvasSize.width, height: canvasSize.height, touchAction: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div className="absolute inset-0 overflow-hidden">
            {showingAiResult ? (
              <img src={imageSource} alt={item.fileName} draggable={false} className="absolute inset-0 h-full w-full select-none object-fill" />
            ) : (
              <>
                <img
                  src={imageSource}
                  alt={item.fileName}
                  draggable={false}
                  className="pointer-events-none absolute z-[1] max-h-none max-w-none select-none object-fill outline outline-1 outline-black/15"
                  style={{
                    left: `${imageBox.x}%`,
                    top: `${imageBox.y}%`,
                    width: `${imageBox.width}%`,
                    height: `${imageBox.height}%`,
                  }}
                />
                {operations.map((operation) => (
                  <BatchFixedCanvasStretchPatch
                    key={operation.id}
                    operation={operation}
                    imageSource={imageSource}
                    imageBox={imageBox}
                    active={draft.tool !== 'stretch' && operation.id !== 'live' && operation.id === draft.activeStretchId}
                    live={operation.id === 'live'}
                    label={t('batchCrop.fixed.selectStretch')}
                    onSelect={operation.id === 'live' || draft.tool === 'stretch'
                      ? undefined
                      : () => onChange({ ...draft, activeStretchId: operation.id })}
                  />
                ))}
              </>
            )}
          </div>

          {draft.stage === 'compose' && !showingAiResult && (
            <BatchFixedCanvasTransformFrame
              imageBox={imageBox}
              active={gesture?.type === 'move' || gesture?.type === 'scale'}
              label={t('batchCrop.fixed.scaleImage')}
              onMoveStart={startMove}
              onScaleStart={startScale}
            />
          )}

          {selection && draft.stage === 'fill' && !showingAiResult && (
            <BatchFixedCanvasSelection
              selection={selection}
              availableDirections={availableDirections}
              onMoveStart={startSelectionMove}
              onResizeStart={startSelectionResize}
              onStretchStart={startStretch}
            />
          )}

          {draft.ai.status === 'processing' && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2.5 overflow-hidden bg-zinc-950/75 text-white backdrop-blur-[2px]">
              <Loader2 className="h-6 w-6 animate-spin" />
              <strong className="text-sm font-medium">{t('batchCrop.fixed.ai.processing')}</strong>
              <span className="text-[11px] text-zinc-300">{t('batchCrop.fixed.ai.processingHint')}</span>
              <div className="mt-1 flex items-center gap-2">
                <UiButton type="button" size="sm" variant="ghost" onClick={onCancelAi} className="border border-white/20 text-white hover:bg-white/10">
                  {t('batchCrop.fixed.ai.cancel')}
                </UiButton>
                <UiButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={index >= total - 1}
                  onClick={onNext}
                  className="border border-white/20 text-white hover:bg-white/10 disabled:text-zinc-400"
                >
                  {t('batchCrop.fixed.ai.processNext')}
                </UiButton>
              </div>
            </div>
          )}
        </div>

        {draft.ai.status === 'failed' && draft.ai.errorMessage && (
          <div className="absolute bottom-3 left-1/2 flex max-w-[min(620px,calc(100%-32px))] -translate-x-1/2 items-center gap-2 rounded-md border border-red-500/20 bg-[var(--ui-surface-panel)] px-3 py-2 text-xs text-red-500 shadow-[var(--ui-shadow-toolbar)]">
            <span className="min-w-0 flex-1">{draft.ai.errorMessage}</span>
            {draft.ai.requiresManualRequery && (
              <UiButton type="button" size="sm" onClick={onRequeryAi}>{t('batchCrop.fixed.ai.requery')}</UiButton>
            )}
          </div>
        )}
      </div>

      <footer className="grid min-h-14 shrink-0 grid-cols-[minmax(260px,1fr)_auto_minmax(260px,1fr)] items-center gap-3 border-t border-[var(--ui-border-soft)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {draft.stage === 'compose' ? (
            <>
              <UiTooltip content={t('batchCrop.fixed.undoComposition')}>
                <button
                  type="button"
                  aria-label={t('batchCrop.fixed.undoComposition')}
                  disabled={locked || !draft.composeUndo}
                  onClick={undoCompositionChange}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-35"
                >
                  <Undo2 className="h-4 w-4" />
                </button>
              </UiTooltip>
              <span className="hidden text-[11px] text-text-muted xl:inline">{t('batchCrop.fixed.zoom')}</span>
              <UiTooltip content={t('batchCrop.fixed.zoomOut')}>
                <button
                  type="button"
                  aria-label={t('batchCrop.fixed.zoomOut')}
                  disabled={locked}
                  onClick={() => commitTransform({ ...draft.transform, zoom: clamp(draft.transform.zoom - 5, 20, 200) })}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-35"
                >
                  <Minus className="h-4 w-4" />
                </button>
              </UiTooltip>
              <input
                type="range"
                aria-label={t('batchCrop.fixed.zoom')}
                min={20}
                max={200}
                value={draft.transform.zoom}
                disabled={locked}
                onChange={(event) => commitTransform({ ...draft.transform, zoom: Number(event.target.value) })}
                className="w-24 accent-[var(--accent)] lg:w-32"
              />
              <span className="w-10 text-center font-mono text-[11px] text-text-muted">{Math.round(draft.transform.zoom)}%</span>
              <UiTooltip content={t('batchCrop.fixed.zoomIn')}>
                <button
                  type="button"
                  aria-label={t('batchCrop.fixed.zoomIn')}
                  disabled={locked}
                  onClick={() => commitTransform({ ...draft.transform, zoom: clamp(draft.transform.zoom + 5, 20, 200) })}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-35"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </UiTooltip>
              <UiTooltip content={t('batchCrop.fixed.fitImage')}>
                <button
                  type="button"
                  aria-label={t('batchCrop.fixed.fitImage')}
                  disabled={locked}
                  onClick={() => commitTransform({ zoom: 100, pan: { x: 0, y: 0 } })}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-35"
                >
                  <Maximize2 className="h-4 w-4" />
                </button>
              </UiTooltip>
            </>
          ) : (
            <>
              <UiTooltip content={t('batchCrop.fixed.undoStretch')}>
                <button
                  type="button"
                  aria-label={t('batchCrop.fixed.undoStretch')}
                  disabled={locked || draft.stretches.length === 0}
                  onClick={() => {
                    const operation = draft.stretches[draft.stretches.length - 1];
                    if (!operation) return;
                    onChange({
                      ...draft,
                      stretches: draft.stretches.slice(0, -1),
                      redoStretches: [operation, ...draft.redoStretches],
                      activeStretchId: null,
                      ready: true,
                      ai: resetAiDraft(draft),
                    });
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-35"
                >
                  <Undo2 className="h-4 w-4" />
                </button>
              </UiTooltip>
              <UiTooltip content={t('batchCrop.fixed.redoStretch')}>
                <button
                  type="button"
                  aria-label={t('batchCrop.fixed.redoStretch')}
                  disabled={locked || draft.redoStretches.length === 0}
                  onClick={() => {
                    const [operation, ...remaining] = draft.redoStretches;
                    if (!operation) return;
                    onChange({
                      ...draft,
                      stretches: [...draft.stretches, operation],
                      redoStretches: remaining,
                      activeStretchId: null,
                      ready: true,
                      ai: resetAiDraft(draft),
                    });
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-35"
                >
                  <Redo2 className="h-4 w-4" />
                </button>
              </UiTooltip>
              <UiTooltip content={t('batchCrop.fixed.deleteStretch')}>
                <button
                  type="button"
                  aria-label={t('batchCrop.fixed.deleteStretch')}
                  disabled={locked || !draft.activeStretchId}
                  onClick={() => onChange({
                    ...draft,
                    stretches: draft.stretches.filter((operation) => operation.id !== draft.activeStretchId),
                    redoStretches: [],
                    activeStretchId: null,
                    ready: true,
                    ai: resetAiDraft(draft),
                  })}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-red-500/10 hover:text-red-500 disabled:opacity-35"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </UiTooltip>
            </>
          )}
        </div>

        <div className="flex items-center justify-center gap-2">
          <BatchFixedCanvasNavigation
            index={index}
            total={total}
            onPrevious={onPrevious}
            onNext={onNext}
          />
          {draft.stage === 'fill' && (
            <div className="flex items-center gap-1 rounded-md border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-0.5">
              <UiTooltip content={t('batchCrop.fixed.regionStretch')}>
                <button
                  type="button"
                  aria-label={t('batchCrop.fixed.regionStretch')}
                  aria-pressed={draft.tool === 'stretch'}
                  disabled={locked}
                  onClick={() => onChange({
                    ...draft,
                    tool: draft.tool === 'stretch' ? null : 'stretch',
                    selection: null,
                    activeStretchId: null,
                  })}
                  className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                    draft.tool === 'stretch' ? 'bg-[var(--ui-hover)] text-accent' : 'text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark'
                  } disabled:opacity-40`}
                >
                  <Square className="h-4 w-4" />
                </button>
              </UiTooltip>
              <UiTooltip content={hasBlank ? t('batchCrop.fixed.ai.action') : t('batchCrop.fixed.ai.noBlank')}>
                <button
                  type="button"
                  aria-label={t('batchCrop.fixed.ai.action')}
                  disabled={locked || !hasBlank}
                  onClick={onOpenAi}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-cyan-500 transition-colors hover:bg-[var(--ui-hover)] disabled:opacity-40"
                >
                  <Sparkles className="h-4 w-4" />
                </button>
              </UiTooltip>
            </div>
          )}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-2">
          {draft.stage === 'compose' ? (
            <>
              <UiButton
                type="button"
                size="sm"
                disabled={locked}
                onClick={() => commitTransform({ zoom: 100, pan: { x: 0, y: 0 } })}
                className="gap-1.5"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('batchCrop.fixed.restoreInitial')}
              </UiButton>
              <UiButton
                type="button"
                size="sm"
                variant="primary"
                disabled={locked}
                onClick={() => onChange({
                  ...draft,
                  stage: 'fill',
                  tool: null,
                  selection: null,
                  ready: true,
                  composeUndo: null,
                })}
                className="gap-1.5"
              >
                <Check className="h-3.5 w-3.5" />
                {t('batchCrop.fixed.confirmComposition')}
              </UiButton>
            </>
          ) : (
            <UiButton
              type="button"
              size="sm"
              variant="ghost"
              disabled={locked}
              onClick={() => onChange({ ...draft, stage: 'compose', tool: null, selection: null })}
            >
              {t('batchCrop.fixed.returnToCompose')}
            </UiButton>
          )}
        </div>
      </footer>
    </>
  );
}
