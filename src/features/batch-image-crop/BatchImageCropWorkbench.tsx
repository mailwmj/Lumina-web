import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTranslation } from 'react-i18next';
import { UiButton, UiModal } from '@/components/ui';
import {
  BATCH_CROP_MAX_IMAGES,
  createDefaultFixedCanvasDraft,
  createBatchCropItemFromPreparedImage,
  createCenteredCrop,
  getBatchCropTarget,
  isLowResolutionCrop,
  isBatchCropItemReadyForExport,
  isBatchCompositionModeLocked,
  normalizeRotationDegrees,
  resolveFixedCanvasStatus,
  type BatchCompositionMode,
  type BatchCropImageItem,
  type BatchCropTargetId,
  type FixedCanvasDraft,
  type NormalizedCropRect,
} from './domain';
import { BatchAiFillDialog } from './BatchAiFillDialog';
import { BatchCropEditor } from './BatchCropEditor';
import { BatchCropSidebar } from './BatchCropSidebar';
import { useBatchAiFill } from './hooks/useBatchAiFill';
import {
  cleanupBatchCropCache,
  exportBatchCropImage,
  exportBatchFixedCanvas,
  prepareBatchCropImage,
  suggestBatchCrop,
} from './infrastructure/tauriBatchImageCropGateway';

type BatchCropPhase = 'idle' | 'preparing' | 'planning' | 'exporting';
type DialogState = 'exit' | 'change-size' | 'complete' | null;

const BATCH_CROP_PREPARE_CONCURRENCY = 2;

interface BatchImageCropWorkbenchProps {
  onExit: () => void;
  backHandlerRef: React.MutableRefObject<() => void>;
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toErrorMessageKey(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('FILE_TOO_LARGE')) return 'batchCrop.error.fileTooLarge';
  if (code.includes('IMAGE_DIMENSIONS_TOO_LARGE')) return 'batchCrop.error.dimensionsTooLarge';
  if (code.includes('UNSUPPORTED_FORMAT')) return 'batchCrop.error.unsupportedFormat';
  if (code.includes('SOURCE_NOT_FOUND')) return 'batchCrop.error.sourceMissing';
  if (code.includes('OUTPUT_DIRECTORY')) return 'batchCrop.error.outputDirectory';
  if (code.includes('OUTPUT_WRITE_FAILED')) return 'batchCrop.error.writeFailed';
  return 'batchCrop.error.invalidImage';
}

export function BatchImageCropWorkbench({ onExit, backHandlerRef }: BatchImageCropWorkbenchProps) {
  const { t } = useTranslation();
  const batchIdRef = useRef(crypto.randomUUID());
  const allowWindowCloseRef = useRef(false);
  const closeRequestedRef = useRef(false);
  const discardAfterCurrentItemRef = useRef(false);
  const exitFinalizingRef = useRef(false);
  const pendingTargetRef = useRef<BatchCropTargetId | null>(null);
  const cancelRequestedRef = useRef(false);
  const [targetId, setTargetId] = useState<BatchCropTargetId | null>(null);
  const [items, setItems] = useState<BatchCropImageItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'review'>('all');
  const [phase, setPhase] = useState<BatchCropPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [exportDirectory, setExportDirectory] = useState('');
  const [toast, setToast] = useState('');
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const busy = phase !== 'idle';
  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selectedId));
  const selectedItem = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  const dirty = items.some((item) => item.status !== 'exported');
  const target = targetId ? getBatchCropTarget(targetId) : null;
  const pendingCount = items.filter((item) => item.compositionMode === 'crop' && item.cropStatus === 'pending').length;
  const exportableCount = items.filter(isBatchCropItemReadyForExport).length;
  const exportedCount = items.filter((item) => item.status === 'exported').length;
  const failedCount = items.filter((item) => item.status === 'error').length;
  const hasAiProcessing = items.some((item) => item.fixedCanvas.ai.status === 'processing');
  const allExported = items.length > 0 && exportedCount === items.length;

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(''), 2600);
  }, []);
  const closeAiDialog = useCallback(() => setAiDialogOpen(false), []);
  const {
    models: imageModels,
    defaultModelId,
    defaultResolution,
    submitting: aiSubmitting,
    submit: submitAiFill,
    cancelSelectedAi,
    requerySelected: requerySelectedAi,
  } = useBatchAiFill({
    batchId: batchIdRef.current,
    items,
    selectedItem,
    target,
    setItems,
    onDialogClose: closeAiDialog,
    onToast: showToast,
  });

  const clearBatch = useCallback(async () => {
    await cleanupBatchCropCache(batchIdRef.current).catch(() => undefined);
  }, []);

  const exitWorkbench = useCallback(async () => {
    if (exitFinalizingRef.current) return;
    exitFinalizingRef.current = true;
    await clearBatch();
    if (isTauri() && closeRequestedRef.current) {
      allowWindowCloseRef.current = true;
      await getCurrentWindow().close();
      return;
    }
    onExit();
  }, [clearBatch, onExit]);

  const requestExit = useCallback(() => {
    closeRequestedRef.current = false;
    if (dirty || busy) {
      setDialog('exit');
      return;
    }
    void exitWorkbench();
  }, [busy, dirty, exitWorkbench]);

  useEffect(() => {
    backHandlerRef.current = requestExit;
  }, [backHandlerRef, requestExit]);

  useEffect(() => {
    if (phase !== 'idle' || !discardAfterCurrentItemRef.current) return;
    discardAfterCurrentItemRef.current = false;
    void exitWorkbench();
  }, [exitWorkbench, phase]);

  useEffect(() => {
    if (!isTauri()) {
      const handleBeforeUnload = (event: BeforeUnloadEvent) => {
        if (dirty || busy) event.preventDefault();
      };
      window.addEventListener('beforeunload', handleBeforeUnload);
      return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      if (allowWindowCloseRef.current) return;
      event.preventDefault();
      closeRequestedRef.current = true;
      if (dirty || busy) {
        setDialog('exit');
        return;
      }
      void exitWorkbench();
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [busy, dirty, exitWorkbench]);

  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  const updateItem = useCallback((itemId: string, update: Partial<BatchCropImageItem>) => {
    setItems((current) => current.map((item) => item.id === itemId ? { ...item, ...update } : item));
  }, []);

  const addPaths = useCallback(async (paths: string[]) => {
    if (!target || busy || paths.length === 0) return;
    const existing = new Set(items.map((item) => item.sourcePath));
    const unique = paths.filter((path, index) => path && !existing.has(path) && paths.indexOf(path) === index);
    const available = Math.max(0, BATCH_CROP_MAX_IMAGES - items.length);
    const accepted = unique.slice(0, available);
    const skipped = paths.length - accepted.length;
    if (accepted.length === 0) {
      if (skipped > 0) showToast(t('batchCrop.addSkipped', { count: skipped }));
      return;
    }

    setPhase('preparing');
    setProgress(0);
    setProgressTotal(accepted.length);
    cancelRequestedRef.current = false;
    let added = 0;
    let nextIndex = 0;
    let firstReviewId: string | null = null;
    const preparedItems: Array<BatchCropImageItem | null> = Array(accepted.length).fill(null);
    const preparedItemIds = new Set<string>();
    const publishPreparedItems = () => {
      setItems((current) => [
        ...current.filter((item) => !preparedItemIds.has(item.id)),
        ...preparedItems.filter((item): item is BatchCropImageItem => item !== null),
      ]);
    };
    const prepareNext = async () => {
      while (!cancelRequestedRef.current) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= accepted.length) return;
        try {
          const prepared = await prepareBatchCropImage(
            batchIdRef.current,
            accepted[index],
            0,
            target
          );
          const item = createBatchCropItemFromPreparedImage(
            prepared,
            target,
            crypto.randomUUID(),
            0,
            t('batchCrop.fallbackNotice'),
            t('batchCrop.fixed.ai.defaultPrompt')
          );
          preparedItems[index] = item;
          preparedItemIds.add(item.id);
          publishPreparedItems();
          setSelectedId((current) => current ?? item.id);
          if (item.status === 'review' && !firstReviewId) firstReviewId = item.id;
          added += 1;
        } catch (error) {
          showToast(t(toErrorMessageKey(error)));
        } finally {
          setProgress((current) => current + 1);
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(BATCH_CROP_PREPARE_CONCURRENCY, accepted.length) },
      () => prepareNext()
    ));
    setPhase('idle');
    setProgress(0);
    setProgressTotal(0);
    if (firstReviewId) {
      setSelectedId(firstReviewId);
      setFilter('review');
    }
    showToast(skipped > 0
      ? t('batchCrop.addResultWithSkipped', { added, skipped })
      : t('batchCrop.addResult', { count: added }));
  }, [busy, items, showToast, t, target]);

  const chooseImages = useCallback(async () => {
    if (!target || busy) return;
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: t('batchCrop.imageFiles'), extensions: ['jpg', 'jpeg', 'png'] }],
    });
    if (!selected) return;
    await addPaths(Array.isArray(selected) ? selected : [selected]);
  }, [addPaths, busy, t, target]);

  const generatePlans = useCallback(async () => {
    if (!target) return;
    const candidates = items.filter(
      (item) => item.compositionMode === 'crop' && item.cropStatus === 'pending'
    );
    if (candidates.length === 0) return;
    setPhase('planning');
    setProgress(0);
    setProgressTotal(candidates.length);
    let firstReviewId: string | null = null;
    for (const item of candidates) {
      if (cancelRequestedRef.current) break;
      updateItem(item.id, { status: 'processing', cropStatus: 'processing', errorMessage: undefined });
      try {
        const suggestion = await suggestBatchCrop(item.previewPath, target.width, target.height);
        const lowResolution = isLowResolutionCrop(
          item.width,
          item.height,
          suggestion.crop,
          target.width,
          target.height
        );
        const requiresReview = suggestion.requiresReview;
        updateItem(item.id, {
          crop: suggestion.crop,
          automaticCrop: suggestion.crop,
          requiresReview,
          lowResolution,
          status: requiresReview ? 'review' : 'auto',
          cropStatus: requiresReview ? 'review' : 'auto',
        });
        if (requiresReview && !firstReviewId) firstReviewId = item.id;
      } catch (error) {
        const fallback = createCenteredCrop(item.width, item.height, target.width, target.height);
        updateItem(item.id, {
          crop: fallback,
          automaticCrop: fallback,
          requiresReview: true,
          lowResolution: isLowResolutionCrop(item.width, item.height, fallback, target.width, target.height),
          status: 'review',
          cropStatus: 'review',
          errorMessage: t('batchCrop.fallbackNotice'),
        });
        if (!firstReviewId) firstReviewId = item.id;
      } finally {
        setProgress((current) => current + 1);
      }
    }
    setPhase('idle');
    setProgress(0);
    setProgressTotal(0);
    if (firstReviewId) {
      setSelectedId(firstReviewId);
      setFilter('review');
    }
  }, [items, t, target, updateItem]);

  const requestExport = useCallback(async () => {
    if (!target || pendingCount > 0 || busy) return;
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;

    const candidates = allExported
      ? items.filter(isBatchCropItemReadyForExport)
      : items.filter((item) => item.status !== 'exported' && isBatchCropItemReadyForExport(item));
    if (candidates.length === 0) return;
    setExportDirectory(selected);
    setPhase('exporting');
    setProgress(0);
    setProgressTotal(candidates.length);
    for (const item of candidates) {
      if (cancelRequestedRef.current) break;
      updateItem(item.id, { status: 'exporting', errorMessage: undefined });
      try {
        const result = item.compositionMode === 'fixed'
          ? await exportBatchFixedCanvas(selected, {
              sourcePath: item.sourcePath,
              fileName: item.fileName,
              targetWidth: target.width,
              targetHeight: target.height,
              rotationDegrees: item.rotationDegrees,
              transform: item.fixedCanvas.transform,
              stretches: item.fixedCanvas.stretches,
              resultSourcePath: item.fixedCanvas.ai.status === 'accepted'
                ? item.fixedCanvas.ai.resultPath
                : undefined,
            })
          : await exportBatchCropImage({
              sourcePath: item.sourcePath,
              fileName: item.fileName,
              outputDirectory: selected,
              targetWidth: target.width,
              targetHeight: target.height,
              rotationDegrees: item.rotationDegrees,
              crop: item.crop!,
            });
        updateItem(item.id, { status: 'exported', outputPath: result.outputPath });
      } catch (error) {
        updateItem(item.id, { status: 'error', errorMessage: t(toErrorMessageKey(error)) });
      } finally {
        setProgress((current) => current + 1);
      }
    }
    setPhase('idle');
    setProgress(0);
    setProgressTotal(0);
    if (!cancelRequestedRef.current) setDialog('complete');
  }, [allExported, busy, items, pendingCount, t, target, updateItem]);

  const handlePrimaryAction = useCallback(() => {
    if (pendingCount > 0) void generatePlans();
    else void requestExport();
  }, [generatePlans, pendingCount, requestExport]);

  const primaryLabel = busy
    ? t(`batchCrop.phase.${phase}`)
    : pendingCount > 0
      ? t('batchCrop.generatePlans')
      : allExported
        ? t('batchCrop.exportAgain')
        : failedCount > 0
          ? t('batchCrop.retryFailed')
          : t('batchCrop.confirmAndExportCount', { count: exportableCount });
  const primaryDisabled = busy
    || items.length === 0
    || (!pendingCount && exportableCount === 0);

  const changeTarget = useCallback((nextTarget: BatchCropTargetId) => {
    if (nextTarget === targetId || hasAiProcessing) return;
    const hasPlans = items.some((item) => item.crop || item.status === 'exported');
    if (hasPlans) {
      pendingTargetRef.current = nextTarget;
      setDialog('change-size');
      return;
    }
    setTargetId(nextTarget);
  }, [hasAiProcessing, items, targetId]);

  const confirmTargetChange = useCallback(() => {
    const nextTarget = pendingTargetRef.current;
    if (!nextTarget) return;
    const nextTargetValue = getBatchCropTarget(nextTarget);
    const defaultsToFixedCanvas = nextTarget === '1440x1440';
    setTargetId(nextTarget);
    setItems((current) => current.map((item) => {
      const crop = defaultsToFixedCanvas
        ? createCenteredCrop(item.width, item.height, nextTargetValue.width, nextTargetValue.height)
        : null;
      const fixedCanvas = createDefaultFixedCanvasDraft(t('batchCrop.fixed.ai.defaultPrompt'));
      return {
        ...item,
        status: defaultsToFixedCanvas ? resolveFixedCanvasStatus(fixedCanvas) : 'pending',
        cropStatus: 'pending',
        compositionMode: defaultsToFixedCanvas ? 'fixed' : 'crop',
        crop,
        automaticCrop: crop,
        requiresReview: false,
        lowResolution: crop ? isLowResolutionCrop(
          item.width,
          item.height,
          crop,
          nextTargetValue.width,
          nextTargetValue.height
        ) : false,
        fixedCanvas,
        outputPath: undefined,
        errorMessage: undefined,
      };
    }));
    setFilter('all');
    pendingTargetRef.current = null;
    setDialog(null);
  }, [t]);

  const rotateSelected = useCallback(async (degrees: -90 | 90) => {
    if (!selectedItem || !target || busy) return;
    cancelRequestedRef.current = false;
    const rotationDegrees = normalizeRotationDegrees(selectedItem.rotationDegrees + degrees);
    updateItem(selectedItem.id, { status: 'processing', errorMessage: undefined });
    setPhase('preparing');
    setProgress(0);
    setProgressTotal(1);
    try {
      const prepared = await prepareBatchCropImage(
        batchIdRef.current,
        selectedItem.sourcePath,
        rotationDegrees,
        target
      );
      const updatedItem = createBatchCropItemFromPreparedImage(
        prepared,
        target,
        selectedItem.id,
        rotationDegrees,
        t('batchCrop.fallbackNotice'),
        t('batchCrop.fixed.ai.defaultPrompt')
      );
      const rotatedItem: BatchCropImageItem = {
        ...updatedItem,
        compositionMode: selectedItem.compositionMode,
        status: selectedItem.compositionMode === 'fixed'
          ? resolveFixedCanvasStatus(updatedItem.fixedCanvas)
          : updatedItem.cropStatus,
        outputPath: undefined,
      };
      updateItem(selectedItem.id, rotatedItem);
      if (rotatedItem.compositionMode === 'crop' && rotatedItem.status === 'review') {
        setSelectedId(updatedItem.id);
        setFilter('review');
      } else {
        setFilter('all');
      }
    } catch (error) {
      updateItem(selectedItem.id, { status: 'error', errorMessage: t(toErrorMessageKey(error)) });
    } finally {
      setProgress(1);
      setPhase('idle');
      setProgress(0);
      setProgressTotal(0);
    }
  }, [busy, selectedItem, t, target, updateItem]);

  const applyCrop = useCallback((crop: NormalizedCropRect) => {
    if (!selectedItem || !target) return;
    updateItem(selectedItem.id, {
      crop,
      status: 'adjusted',
      cropStatus: 'adjusted',
      lowResolution: isLowResolutionCrop(
        selectedItem.width,
        selectedItem.height,
        crop,
        target.width,
        target.height
      ),
      outputPath: undefined,
    });
  }, [selectedItem, target, updateItem]);

  const restoreSelected = useCallback(() => {
    if (!selectedItem?.automaticCrop || !target) return;
    updateItem(selectedItem.id, {
      crop: selectedItem.automaticCrop,
      status: selectedItem.requiresReview ? 'review' : 'auto',
      cropStatus: selectedItem.requiresReview ? 'review' : 'auto',
      lowResolution: isLowResolutionCrop(
        selectedItem.width,
        selectedItem.height,
        selectedItem.automaticCrop,
        target.width,
        target.height
      ),
      outputPath: undefined,
    });
  }, [selectedItem, target, updateItem]);

  const confirmSelected = useCallback(() => {
    if (!selectedItem || selectedItem.cropStatus !== 'review') return;
    updateItem(selectedItem.id, { status: 'confirmed', cropStatus: 'confirmed' });
    const next = items.find((item) => item.id !== selectedItem.id && item.cropStatus === 'review');
    if (next) setSelectedId(next.id);
    else setFilter('all');
  }, [items, selectedItem, updateItem]);

  const changeCompositionMode = useCallback((mode: BatchCompositionMode) => {
    if (!selectedItem || selectedItem.compositionMode === mode) return;
    if (isBatchCompositionModeLocked(selectedItem, busy)) return;
    updateItem(selectedItem.id, {
      compositionMode: mode,
      status: mode === 'crop'
        ? selectedItem.cropStatus
        : resolveFixedCanvasStatus(selectedItem.fixedCanvas),
      outputPath: undefined,
      errorMessage: undefined,
    });
  }, [busy, selectedItem, updateItem]);

  const applyFixedCanvas = useCallback((draft: FixedCanvasDraft) => {
    if (!selectedItem || selectedItem.compositionMode !== 'fixed') return;
    updateItem(selectedItem.id, {
      fixedCanvas: draft,
      status: resolveFixedCanvasStatus(draft),
      outputPath: undefined,
      errorMessage: draft.ai.status === 'failed' ? draft.ai.errorMessage : undefined,
    });
  }, [selectedItem, updateItem]);

  const removeItem = useCallback((itemId: string) => {
    const currentIndex = items.findIndex((item) => item.id === itemId);
    const remaining = items.filter((item) => item.id !== itemId);
    setItems(remaining);
    if (selectedId === itemId) {
      setSelectedId(remaining[Math.min(currentIndex, remaining.length - 1)]?.id ?? null);
    }
  }, [items, selectedId]);

  const startNewBatch = useCallback(async () => {
    if (!allExported || busy) return;
    setPhase('preparing');
    await clearBatch();
    batchIdRef.current = crypto.randomUUID();
    setItems([]);
    setSelectedId(null);
    setFilter('all');
    setExportDirectory('');
    setDialog(null);
    setPhase('idle');
  }, [allExported, busy, clearBatch]);

  const editorTarget = target ?? getBatchCropTarget('1440x1920');
  const dialogFooter = useMemo(() => {
    if (dialog === 'exit') {
      return (
        <>
          <UiButton onClick={() => setDialog(null)}>{t('batchCrop.continueEditing')}</UiButton>
          <UiButton
            variant="danger"
            onClick={() => {
              cancelRequestedRef.current = true;
              setDialog(null);
              if (busy) {
                discardAfterCurrentItemRef.current = true;
                return;
              }
              void exitWorkbench();
            }}
          >
            {t('batchCrop.exitDiscard')}
          </UiButton>
        </>
      );
    }
    if (dialog === 'change-size') {
      return (
        <>
          <UiButton onClick={() => setDialog(null)}>{t('common.cancel')}</UiButton>
          <UiButton variant="primary" onClick={confirmTargetChange}>{t('batchCrop.changeSizeConfirm')}</UiButton>
        </>
      );
    }
    return (
      <>
        <UiButton className="w-32" onClick={() => setDialog(null)}>{t('common.confirm')}</UiButton>
        {allExported && (
          <UiButton
            variant="primary"
            className="w-32"
            disabled={busy}
            onClick={() => void startNewBatch()}
          >
            {t('batchCrop.addNewBatch')}
          </UiButton>
        )}
      </>
    );
  }, [allExported, busy, confirmTargetChange, dialog, exitWorkbench, startNewBatch, t]);

  return (
    <section className="absolute inset-0 flex min-h-0 overflow-hidden bg-bg-dark">
      <BatchCropSidebar
        targetId={targetId}
        items={items}
        selectedId={selectedItem?.id ?? null}
        filter={filter}
        phase={phase}
        progress={progress}
        progressTotal={progressTotal}
        primaryLabel={primaryLabel}
        primaryDisabled={primaryDisabled}
        targetChangeDisabled={hasAiProcessing}
        onTargetChange={changeTarget}
        onSelectItem={setSelectedId}
        onFilterChange={setFilter}
        onAddPaths={(paths) => void addPaths(paths)}
        onChooseImages={() => void chooseImages()}
        onRemoveItem={removeItem}
        onPrimaryAction={handlePrimaryAction}
      />
      <BatchCropEditor
        item={selectedItem}
        target={editorTarget}
        index={selectedIndex}
        total={items.length}
        busy={busy}
        keyboardNavigationEnabled={dialog === null && !aiDialogOpen}
        onModeChange={changeCompositionMode}
        onCropChange={applyCrop}
        onRestore={restoreSelected}
        onConfirm={confirmSelected}
        onRotate={(degrees) => void rotateSelected(degrees)}
        onFixedCanvasChange={applyFixedCanvas}
        onOpenAi={() => setAiDialogOpen(true)}
        onRequeryAi={() => void requerySelectedAi()}
        onCancelAi={cancelSelectedAi}
        onToast={showToast}
        onPrevious={() => setSelectedId(items[Math.max(0, selectedIndex - 1)]?.id ?? null)}
        onNext={() => setSelectedId(items[Math.min(items.length - 1, selectedIndex + 1)]?.id ?? null)}
      />

      <BatchAiFillDialog
        isOpen={aiDialogOpen}
        item={selectedItem}
        target={editorTarget}
        models={imageModels}
        defaultModelId={defaultModelId}
        defaultResolution={defaultResolution}
        submitting={aiSubmitting}
        onClose={aiSubmitting ? cancelSelectedAi : closeAiDialog}
        onSubmit={(submission) => void submitAiFill(submission)}
      />

      <UiModal
        isOpen={dialog !== null}
        title={dialog === 'exit'
          ? t('batchCrop.exitTitle')
          : dialog === 'change-size'
            ? t('batchCrop.changeSizeTitle')
            : t('batchCrop.exportComplete')}
        closeLabel={t('common.close')}
        onClose={() => setDialog(null)}
        footer={dialogFooter}
        widthClassName="w-[440px] max-w-[calc(100vw-24px)]"
      >
        {dialog === 'exit' && <p className="text-sm leading-6 text-text-muted">{t('batchCrop.exitMessage')}</p>}
        {dialog === 'change-size' && <p className="text-sm leading-6 text-text-muted">{t('batchCrop.changeSizeMessage')}</p>}
        {dialog === 'complete' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md bg-[var(--ui-surface-field)] p-3">
                <div className="font-mono text-lg font-semibold text-text-dark">{exportedCount}</div>
                <div className="mt-1 text-xs text-text-muted">{t('batchCrop.exportSucceeded')}</div>
              </div>
              <div className="rounded-md bg-[var(--ui-surface-field)] p-3">
                <div className="font-mono text-lg font-semibold text-text-dark">{failedCount}</div>
                <div className="mt-1 text-xs text-text-muted">{t('batchCrop.exportFailed')}</div>
              </div>
            </div>
            <p className="break-all rounded-md border border-[var(--ui-border-soft)] px-3 py-2 font-mono text-[11px] text-text-muted">
              {exportDirectory}
            </p>
          </div>
        )}
      </UiModal>

      {toast && (
        <div className="pointer-events-none absolute bottom-5 left-1/2 z-[70] -translate-x-1/2 rounded-md border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)] px-3 py-2 text-xs text-text-dark shadow-[var(--ui-shadow-tooltip)]">
          {toast}
        </div>
      )}
    </section>
  );
}
