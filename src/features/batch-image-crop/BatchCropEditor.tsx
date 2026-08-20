import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactCrop, { type PercentCrop } from 'react-image-crop';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  RotateCcw,
} from '@/components/ui/icons';
import { UiButton, UiTooltip } from '@/components/ui';
import {
  fitImageWithinBounds,
  isBatchCompositionModeLocked,
  type BatchCompositionMode,
  type BatchCropImageItem,
  type BatchCropTarget,
  type FixedCanvasDraft,
  type NormalizedCropRect,
} from './domain';
import { BatchFixedCanvasEditor } from './BatchFixedCanvasEditor';
import { resolveBatchCropDisplayUrl } from './infrastructure/tauriBatchImageCropGateway';

interface BatchCropEditorProps {
  item: BatchCropImageItem | null;
  target: BatchCropTarget;
  index: number;
  total: number;
  busy: boolean;
  keyboardNavigationEnabled?: boolean;
  onModeChange: (mode: BatchCompositionMode) => void;
  onCropChange: (crop: NormalizedCropRect) => void;
  onRestore: () => void;
  onConfirm: () => void;
  onRotate: (degrees: -90 | 90) => void;
  onFixedCanvasChange: (draft: FixedCanvasDraft) => void;
  onOpenAi: () => void;
  onRequeryAi: () => void;
  onCancelAi: () => void;
  onToast: (message: string) => void;
  onPrevious: () => void;
  onNext: () => void;
}

function toPercentCrop(crop: NormalizedCropRect): PercentCrop {
  return {
    unit: '%',
    x: crop.x * 100,
    y: crop.y * 100,
    width: crop.width * 100,
    height: crop.height * 100,
  };
}

function toNormalizedCrop(crop: PercentCrop): NormalizedCropRect {
  return {
    x: crop.x / 100,
    y: crop.y / 100,
    width: crop.width / 100,
    height: crop.height / 100,
  };
}

export function BatchCropEditor({
  item,
  target,
  index,
  total,
  busy,
  keyboardNavigationEnabled = true,
  onModeChange,
  onCropChange,
  onRestore,
  onConfirm,
  onRotate,
  onFixedCanvasChange,
  onOpenAi,
  onRequeryAi,
  onCancelAi,
  onToast,
  onPrevious,
  onNext,
}: BatchCropEditorProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const crop = useMemo(() => item?.crop ? toPercentCrop(item.crop) : undefined, [item?.crop]);
  const editable = Boolean(item?.crop) && !busy;
  const canConfirm = item?.cropStatus === 'review';
  const hasItem = item !== null;
  const modeLocked = isBatchCompositionModeLocked(item, busy);

  useEffect(() => {
    if (!hasItem || busy || !keyboardNavigationEnabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const targetElement = event.target instanceof Element ? event.target : null;
      if (
        targetElement?.closest('input, textarea, select, button, [contenteditable="true"]')
        || (targetElement instanceof HTMLElement && targetElement.isContentEditable)
        || targetElement?.closest('.ReactCrop__drag-handle, .ReactCrop__crop-selection')
      ) return;
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault();
        onPrevious();
      }
      if (event.key === 'ArrowRight' && index < total - 1) {
        event.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, hasItem, index, keyboardNavigationEnabled, onNext, onPrevious, total]);

  useEffect(() => {
    if (!hasItem || item?.compositionMode === 'fixed') return;
    const element = viewportRef.current;
    if (!element) return;
    const updateViewportSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({ width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) });
    };
    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasItem, item?.compositionMode]);

  const renderedImageSize = useMemo(() => {
    if (!item || viewportSize.width <= 0 || viewportSize.height <= 0) return null;
    return fitImageWithinBounds(item.width, item.height, viewportSize.width, viewportSize.height);
  }, [item, viewportSize.height, viewportSize.width]);
  const renderedImageStyle = renderedImageSize ? {
    width: `${renderedImageSize.width}px`,
    height: `${renderedImageSize.height}px`,
    maxWidth: 'none',
    maxHeight: 'none',
  } : undefined;

  if (!item) return <div className="h-full w-full bg-bg-dark" />;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg-dark">
      <header className="grid h-16 shrink-0 grid-cols-[minmax(160px,1fr)_auto_minmax(90px,1fr)] items-center gap-4 border-b border-[var(--ui-border-soft)] px-5">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium text-text-dark">{item.fileName}</h1>
          <p className="mt-0.5 font-mono text-[11px] text-text-muted">
            {item.width}×{item.height} · {t('batchCrop.outputSize')} {target.width}×{target.height}
          </p>
        </div>
        <div
          role="group"
          aria-label={t('batchCrop.compositionMode')}
          className="grid w-[184px] grid-cols-2 gap-0.5 rounded-md border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-0.5"
        >
          {(['crop', 'fixed'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={modeLocked}
              aria-pressed={item.compositionMode === mode}
              onClick={() => onModeChange(mode)}
              className={`h-7 min-w-0 rounded-[4px] px-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                item.compositionMode === mode
                  ? 'bg-[var(--ui-surface-elevated)] text-text-dark shadow-[0_0_0_1px_var(--ui-border-strong)]'
                  : 'text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark'
              } disabled:cursor-not-allowed disabled:opacity-45`}
            >
              {t(`batchCrop.mode.${mode}`)}
            </button>
          ))}
        </div>
        <span className={`justify-self-end rounded-md px-2 py-1 text-[11px] ${
          item.status === 'review'
            ? 'bg-amber-500/12 text-amber-500'
            : item.status === 'error' || item.status === 'aiFailed'
              ? 'bg-red-500/12 text-red-500'
              : item.status === 'aiProcessing'
                ? 'bg-cyan-500/12 text-cyan-500'
                : item.status === 'fixedReady' || item.status === 'aiGenerated' || item.status === 'exported'
                  ? 'bg-emerald-500/12 text-emerald-500'
                  : 'bg-[var(--ui-hover)] text-text-muted'
        }`}>
          {t(`batchCrop.status.${item.status}`)}
        </span>
      </header>

      {item.compositionMode === 'fixed' ? (
        <BatchFixedCanvasEditor
          item={item}
          target={target}
          index={index}
          total={total}
          busy={busy}
          onChange={onFixedCanvasChange}
          onOpenAi={onOpenAi}
          onRequeryAi={onRequeryAi}
          onCancelAi={onCancelAi}
          onToast={onToast}
          onPrevious={onPrevious}
          onNext={onNext}
        />
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6">
            <div ref={viewportRef} className="flex h-full w-full items-center justify-center">
              {crop && renderedImageSize ? (
                <ReactCrop
                  crop={crop}
                  aspect={target.width / target.height}
                  disabled={!editable}
                  keepSelection
                  ruleOfThirds
                  onChange={(_, percentCrop) => onCropChange(toNormalizedCrop(percentCrop))}
                  className="batch-crop-react-crop"
                  style={renderedImageStyle}
                >
                  <img
                    src={resolveBatchCropDisplayUrl(item.previewPath)}
                    alt={item.fileName}
                    width={item.width}
                    height={item.height}
                    loading="eager"
                    decoding="async"
                    className="block select-none object-contain"
                    style={renderedImageStyle}
                  />
                </ReactCrop>
              ) : renderedImageSize ? (
                <img
                  src={resolveBatchCropDisplayUrl(item.previewPath)}
                  alt={item.fileName}
                  width={item.width}
                  height={item.height}
                  loading="eager"
                  decoding="async"
                  className="block select-none object-contain"
                  style={renderedImageStyle}
                />
              ) : null}
            </div>

            {(item.cropStatus === 'review' || item.lowResolution || item.errorMessage) && (
              <div className="absolute bottom-4 left-1/2 flex max-w-[min(620px,calc(100%-32px))] -translate-x-1/2 items-start gap-2 rounded-md border border-amber-500/20 bg-[var(--ui-surface-panel)] px-3 py-2 text-xs text-amber-500 shadow-[var(--ui-shadow-toolbar)]">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{item.errorMessage || (item.lowResolution ? t('batchCrop.lowResolution') : t('batchCrop.reviewNotice'))}</span>
              </div>
            )}
          </div>

          <footer className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-t border-[var(--ui-border-soft)] px-4">
            <div className="flex items-center gap-1.5">
              <UiTooltip content={t('batchCrop.rotateLeft')}>
                <button
                  type="button"
                  aria-label={t('batchCrop.rotateLeft')}
                  disabled={busy}
                  onClick={() => onRotate(-90)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-40"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
              </UiTooltip>
              <UiTooltip content={t('batchCrop.rotateRight')}>
                <button
                  type="button"
                  aria-label={t('batchCrop.rotateRight')}
                  disabled={busy}
                  onClick={() => onRotate(90)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-40"
                >
                  <RotateCcw className="h-4 w-4 -scale-x-100" />
                </button>
              </UiTooltip>
              <UiButton type="button" onClick={onRestore} disabled={!editable || !item.automaticCrop} className="h-8 gap-1.5 px-2.5 text-xs">
                <RefreshCw className="h-3.5 w-3.5" />
                {t('batchCrop.restoreAuto')}
              </UiButton>
            </div>

            <div className="flex items-center gap-2">
              <UiTooltip content={t('viewer.prev')}>
                <button type="button" aria-label={t('viewer.prev')} disabled={index <= 0} onClick={onPrevious} className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-35">
                  <ChevronLeft className="h-4 w-4" />
                </button>
              </UiTooltip>
              <span className="w-14 text-center font-mono text-[11px] text-text-muted">{index + 1}/{total}</span>
              <UiTooltip content={t('viewer.next')}>
                <button type="button" aria-label={t('viewer.next')} disabled={index >= total - 1} onClick={onNext} className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:opacity-35">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </UiTooltip>
            </div>

            <div className="flex justify-end">
              {canConfirm && (
                <UiButton type="button" variant="primary" onClick={onConfirm} disabled={busy} className="h-8 gap-1.5 px-3 text-xs">
                  <Check className="h-3.5 w-3.5" />
                  {t('batchCrop.confirmCurrent')}
                </UiButton>
              )}
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
