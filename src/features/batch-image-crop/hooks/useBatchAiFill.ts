import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';
import { persistImageSource } from '@/commands/image';
import { canvasAiGateway } from '@/features/canvas/application/canvasServices';
import { resolveImageProviderRuntime } from '@/features/canvas/application/imageProviderRuntime';
import {
  listConfiguredImageModels,
  resolveConfiguredImageModel,
} from '@/features/canvas/models/availableModels';
import type { ImageModelDefinition } from '@/features/canvas/models/types';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  resolveFixedCanvasStatus,
  type BatchCropImageItem,
  type BatchCropTarget,
  type FixedCanvasDraft,
} from '../domain';
import { renderBatchFixedCanvas } from '../infrastructure/tauriBatchImageCropGateway';

export interface BatchAiFillSubmission {
  modelId: string;
  resolution: string;
  prompt: string;
}

interface UseBatchAiFillOptions {
  batchId: string;
  items: BatchCropImageItem[];
  selectedItem: BatchCropImageItem | null;
  target: BatchCropTarget | null;
  setItems: Dispatch<SetStateAction<BatchCropImageItem[]>>;
  onDialogClose: () => void;
  onToast: (message: string) => void;
}

type ImageJobStatus = Awaited<ReturnType<typeof canvasAiGateway.getGenerateImageJob>>;

interface ActiveSubmission {
  itemId: string;
  token: symbol;
}

interface ProcessingSnapshot {
  jobId: string;
  draft: FixedCanvasDraft;
  providerConfig?: Record<string, string>;
}

const BATCH_AI_FILL_REFERENCE_COUNT = 2;
const BATCH_AI_FILL_MASK_INSTRUCTION = [
  'Reference image 1 is the complete fixed canvas and must be preserved as scene context.',
  'Reference image 2 is a binary range mask aligned pixel-for-pixel with image 1.',
  'Only white pixels in the range mask may be generated. Black pixels are protected content and must remain unchanged.',
  'Return the complete canvas at the requested aspect ratio, not a cropped region.',
].join(' ');

function parseAspectRatio(value: string): number | null {
  const [width, height] = value.split(':').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return null;
  return width / height;
}

function resolveTargetAspectRatio(
  target: Pick<BatchCropTarget, 'width' | 'height'>,
  modelRatios: readonly { value: string }[]
): string {
  const targetRatio = target.width / target.height;
  const resolved = modelRatios
    .map((option) => ({ value: option.value, ratio: parseAspectRatio(option.value) }))
    .filter((option): option is { value: string; ratio: number } => option.ratio !== null)
    .sort((left, right) => Math.abs(left.ratio - targetRatio) - Math.abs(right.ratio - targetRatio))[0];
  return resolved?.value ?? (Math.abs(targetRatio - 1) < 0.01 ? '1:1' : '2:3');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveBatchAiFillRequest(model: ImageModelDefinition) {
  const generationRequest = model.resolveRequest({ referenceImageCount: 0 });
  const editRequest = model.resolveRequest({
    referenceImageCount: BATCH_AI_FILL_REFERENCE_COUNT,
  });
  const declaresReferenceEditing = editRequest.requestModel !== generationRequest.requestModel
    || editRequest.modeLabel !== generationRequest.modeLabel;
  return declaresReferenceEditing && editRequest.requestModel.trim() ? editRequest : null;
}

function fixedCanvasRenderPayload(
  item: BatchCropImageItem,
  draft: FixedCanvasDraft,
  target: BatchCropTarget,
  resultSourcePath?: string
) {
  return {
    sourcePath: item.sourcePath,
    fileName: item.fileName,
    targetWidth: target.width,
    targetHeight: target.height,
    rotationDegrees: item.rotationDegrees,
    transform: draft.transform,
    stretches: draft.stretches,
    ...(resultSourcePath ? { resultSourcePath } : {}),
  };
}

export function useBatchAiFill({
  batchId,
  items,
  selectedItem,
  target,
  setItems,
  onDialogClose,
  onToast,
}: UseBatchAiFillOptions) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const activeSubmissionRef = useRef<ActiveSubmission | null>(null);
  const processingSnapshotsRef = useRef(new Map<string, ProcessingSnapshot>());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const openAiImageApi = useSettingsStore((state) => state.openAiImageApi);
  const chaomoImageApi = useSettingsStore((state) => state.chaomoImageApi);
  const customImageApis = useSettingsStore((state) => state.customImageApis);
  const lastImageModelSelection = useSettingsStore((state) => state.lastImageModelSelection);
  const lastBatchAiFillSelection = useSettingsStore((state) => state.lastBatchAiFillSelection);
  const setLastBatchAiFillSelection = useSettingsStore((state) => state.setLastBatchAiFillSelection);

  const imageModelSettings = useMemo(() => ({
    openAiImageApi,
    chaomoImageApi,
    customImageApis,
    lastImageModelSelection,
  }), [chaomoImageApi, customImageApis, lastImageModelSelection, openAiImageApi]);
  const models = useMemo(
    () => listConfiguredImageModels(imageModelSettings),
    [imageModelSettings]
  );
  const defaultModel = useMemo(
    () => resolveConfiguredImageModel(imageModelSettings, lastBatchAiFillSelection?.modelId),
    [imageModelSettings, lastBatchAiFillSelection?.modelId]
  );

  const resolveJobProviderConfig = useCallback((modelId: string) => {
    const model = models.find((candidate) => candidate.id === modelId);
    return model
      ? resolveImageProviderRuntime(model.providerId, imageModelSettings).providerConfig
      : undefined;
  }, [imageModelSettings, models]);

  const applyJobStatus = useCallback(async (
    itemId: string,
    jobId: string,
    job: ImageJobStatus
  ) => {
    if (job.status === 'queued' || job.status === 'running') {
      if (!job.recovery?.requires_manual_requery) return;
      setItems((current) => current.map((item) => {
        if (item.id !== itemId || item.fixedCanvas.ai.jobId !== jobId) return item;
        const fixedCanvas: FixedCanvasDraft = {
          ...item.fixedCanvas,
          ai: {
            ...item.fixedCanvas.ai,
            status: 'failed',
            errorMessage: job.recovery?.last_error || t('batchCrop.fixed.ai.queryInterrupted'),
            requiresManualRequery: true,
          },
        };
        return { ...item, fixedCanvas, status: resolveFixedCanvasStatus(fixedCanvas) };
      }));
      return;
    }

    if (job.status === 'succeeded' && job.result) {
      try {
        const candidatePath = await persistImageSource(job.result);
        const currentItem = itemsRef.current.find((item) => (
          item.id === itemId && item.fixedCanvas.ai.jobId === jobId
        ));
        if (!currentItem || !target) return;
        const snapshot = processingSnapshotsRef.current.get(itemId);
        const submittedDraft = snapshot?.jobId === jobId ? snapshot.draft : currentItem.fixedCanvas;
        const protectedResult = await renderBatchFixedCanvas(
          batchId,
          fixedCanvasRenderPayload(currentItem, submittedDraft, target, candidatePath)
        );
        if (!itemsRef.current.some((item) => (
          item.id === itemId && item.fixedCanvas.ai.jobId === jobId
        ))) return;
        const resultPath = protectedResult.renderedPath;
        setItems((current) => current.map((item) => {
          if (item.id !== itemId || item.fixedCanvas.ai.jobId !== jobId) return item;
          const fixedCanvas: FixedCanvasDraft = {
            ...item.fixedCanvas,
            ready: true,
            ai: {
              ...item.fixedCanvas.ai,
              status: 'accepted',
              resultPath,
              errorMessage: undefined,
              requiresManualRequery: false,
            },
          };
          return {
            ...item,
            fixedCanvas,
            status: resolveFixedCanvasStatus(fixedCanvas),
            errorMessage: undefined,
          };
        }));
        if (processingSnapshotsRef.current.get(itemId)?.jobId === jobId) {
          processingSnapshotsRef.current.delete(itemId);
        }
      } catch (error) {
        setItems((current) => current.map((item) => {
          if (item.id !== itemId || item.fixedCanvas.ai.jobId !== jobId) return item;
          const fixedCanvas: FixedCanvasDraft = {
            ...item.fixedCanvas,
            ai: {
              ...item.fixedCanvas.ai,
              status: 'failed',
              errorMessage: errorMessage(error),
            },
          };
          return { ...item, fixedCanvas, status: resolveFixedCanvasStatus(fixedCanvas) };
        }));
      }
      return;
    }

    const failure = job.error || (job.status === 'succeeded'
      ? t('batchCrop.fixed.ai.emptyResult')
      : t('batchCrop.fixed.ai.failed'));
    setItems((current) => current.map((item) => {
      if (item.id !== itemId || item.fixedCanvas.ai.jobId !== jobId) return item;
      const fixedCanvas: FixedCanvasDraft = {
        ...item.fixedCanvas,
        ai: {
          ...item.fixedCanvas.ai,
          status: 'failed',
          errorMessage: failure,
          requiresManualRequery: false,
        },
      };
      return { ...item, fixedCanvas, status: resolveFixedCanvasStatus(fixedCanvas) };
    }));
  }, [batchId, setItems, t, target]);

  useEffect(() => {
    const jobs = items.flatMap((item) => item.fixedCanvas.ai.status === 'processing' && item.fixedCanvas.ai.jobId
      ? [{ itemId: item.id, jobId: item.fixedCanvas.ai.jobId }]
      : []);
    if (jobs.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all(jobs.map(async ({ itemId, jobId }) => {
        try {
          const snapshot = processingSnapshotsRef.current.get(itemId);
          const modelId = itemsRef.current.find((item) => item.id === itemId)?.fixedCanvas.ai.modelId ?? '';
          const providerConfig = snapshot?.jobId === jobId
            ? snapshot.providerConfig
            : resolveJobProviderConfig(modelId);
          const job = await canvasAiGateway.getGenerateImageJob(jobId, providerConfig);
          if (!cancelled) await applyJobStatus(itemId, jobId, job);
        } catch (error) {
          if (cancelled) return;
          setItems((current) => current.map((item) => {
            if (item.id !== itemId || item.fixedCanvas.ai.jobId !== jobId) return item;
            const fixedCanvas: FixedCanvasDraft = {
              ...item.fixedCanvas,
              ai: {
                ...item.fixedCanvas.ai,
                status: 'failed',
                errorMessage: errorMessage(error),
                requiresManualRequery: true,
              },
            };
            return { ...item, fixedCanvas, status: resolveFixedCanvasStatus(fixedCanvas) };
          }));
        }
      })).finally(() => {
        if (!cancelled) setPollTick((current) => current + 1);
      });
    }, 1800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [applyJobStatus, items, pollTick, resolveJobProviderConfig, setItems]);

  const submit = useCallback(async (submission: BatchAiFillSubmission) => {
    if (!selectedItem || !target || submitting) return;
    const model = models.find((candidate) => candidate.id === submission.modelId);
    if (!model) {
      onToast(t('batchCrop.fixed.ai.noModel'));
      return;
    }
    const providerRuntime = resolveImageProviderRuntime(model.providerId, imageModelSettings);
    if (!providerRuntime.apiKey.trim()) {
      onToast(t('batchCrop.fixed.ai.noModel'));
      return;
    }
    const request = resolveBatchAiFillRequest(model);
    if (!request) {
      onToast(t('batchCrop.fixed.ai.rangeInputUnsupported'));
      return;
    }

    const itemId = selectedItem.id;
    const originalDraft = selectedItem.fixedCanvas;
    const token = Symbol(itemId);
    activeSubmissionRef.current = { itemId, token };
    setSubmitting(true);
    try {
      const rendered = await renderBatchFixedCanvas(
        batchId,
        fixedCanvasRenderPayload(selectedItem, selectedItem.fixedCanvas, target)
      );
      if (activeSubmissionRef.current?.token !== token) return;
      await canvasAiGateway.setApiKey(providerRuntime.backendProviderId, providerRuntime.apiKey);
      if (activeSubmissionRef.current?.token !== token) return;
      const jobId = await canvasAiGateway.submitGenerateImageJob({
        prompt: `${BATCH_AI_FILL_MASK_INSTRUCTION}\n\nUser instruction:\n${submission.prompt}`,
        model: request.requestModel,
        size: submission.resolution,
        aspectRatio: resolveTargetAspectRatio(target, model.aspectRatios),
        referenceImages: [rendered.renderedPath, rendered.blankMaskPath],
        extraParams: model.defaultExtraParams,
        providerConfig: providerRuntime.providerConfig,
      });
      if (activeSubmissionRef.current?.token !== token) return;
      setLastBatchAiFillSelection({
        modelId: submission.modelId,
        resolution: submission.resolution,
      });
      processingSnapshotsRef.current.set(itemId, {
        jobId,
        draft: originalDraft,
        providerConfig: providerRuntime.providerConfig,
      });
      setItems((current) => current.map((item) => {
        if (item.id !== itemId) return item;
        const fixedCanvas: FixedCanvasDraft = {
          ...item.fixedCanvas,
          ready: true,
          tool: null,
          selection: null,
          ai: {
            status: 'processing',
            prompt: submission.prompt,
            modelId: submission.modelId,
            resolution: submission.resolution,
            jobId,
          },
        };
        return {
          ...item,
          fixedCanvas,
          status: resolveFixedCanvasStatus(fixedCanvas),
          outputPath: undefined,
          errorMessage: undefined,
        };
      }));
      onDialogClose();
      setPollTick((current) => current + 1);
    } catch (error) {
      if (activeSubmissionRef.current?.token !== token) return;
      const message = errorMessage(error);
      setItems((current) => current.map((item) => {
        if (item.id !== itemId) return item;
        const fixedCanvas: FixedCanvasDraft = {
          ...item.fixedCanvas,
          ai: {
            ...item.fixedCanvas.ai,
            status: 'failed',
            prompt: submission.prompt,
            modelId: submission.modelId,
            resolution: submission.resolution,
            errorMessage: message,
          },
        };
        return { ...item, fixedCanvas, status: resolveFixedCanvasStatus(fixedCanvas) };
      }));
      onDialogClose();
      onToast(t('batchCrop.fixed.ai.submitFailed'));
    } finally {
      if (activeSubmissionRef.current?.token === token) {
        activeSubmissionRef.current = null;
        setSubmitting(false);
      }
    }
  }, [batchId, imageModelSettings, models, onDialogClose, onToast, selectedItem, setItems, setLastBatchAiFillSelection, submitting, t, target]);

  const cancelSelectedAi = useCallback(() => {
    const activeSubmission = activeSubmissionRef.current;
    if (activeSubmission) {
      activeSubmissionRef.current = null;
      setSubmitting(false);
      onDialogClose();
      onToast(t('batchCrop.fixed.ai.cancelledNotice'));
      return;
    }

    const item = selectedItem;
    const jobId = item?.fixedCanvas.ai.jobId;
    if (!item || item.fixedCanvas.ai.status !== 'processing' || !jobId) return;
    const snapshot = processingSnapshotsRef.current.get(item.id);
    processingSnapshotsRef.current.delete(item.id);
    setItems((current) => current.map((candidate) => {
      if (candidate.id !== item.id || candidate.fixedCanvas.ai.jobId !== jobId) return candidate;
      const fixedCanvas: FixedCanvasDraft = snapshot?.jobId === jobId
        ? snapshot.draft
        : {
            ...candidate.fixedCanvas,
            ready: true,
            ai: {
              status: 'idle',
              prompt: '',
              modelId: '',
              resolution: '',
            },
          };
      return {
        ...candidate,
        fixedCanvas,
        status: resolveFixedCanvasStatus(fixedCanvas),
        errorMessage: undefined,
      };
    }));
    onToast(t('batchCrop.fixed.ai.cancelledNotice'));
  }, [onDialogClose, onToast, selectedItem, setItems, t]);

  const requerySelected = useCallback(async () => {
    const item = selectedItem;
    const jobId = item?.fixedCanvas.ai.jobId;
    if (!item || !jobId) return;
    const processingDraft: FixedCanvasDraft = {
      ...item.fixedCanvas,
      ai: {
        ...item.fixedCanvas.ai,
        status: 'processing',
        errorMessage: undefined,
        requiresManualRequery: false,
      },
    };
    if (!processingSnapshotsRef.current.has(item.id)) {
      processingSnapshotsRef.current.set(item.id, {
        jobId,
        draft: item.fixedCanvas,
        providerConfig: resolveJobProviderConfig(item.fixedCanvas.ai.modelId),
      });
    }
    setItems((current) => current.map((candidate) => candidate.id === item.id
      ? { ...candidate, fixedCanvas: processingDraft, status: resolveFixedCanvasStatus(processingDraft) }
      : candidate));
    try {
      const providerConfig = processingSnapshotsRef.current.get(item.id)?.providerConfig
        ?? resolveJobProviderConfig(item.fixedCanvas.ai.modelId);
      const job = await canvasAiGateway.retryGenerateImageJob(jobId, providerConfig);
      await applyJobStatus(item.id, jobId, job);
      setPollTick((current) => current + 1);
    } catch (error) {
      const failedDraft: FixedCanvasDraft = {
        ...processingDraft,
        ai: {
          ...processingDraft.ai,
          status: 'failed',
          errorMessage: errorMessage(error),
          requiresManualRequery: true,
        },
      };
      setItems((current) => current.map((candidate) => candidate.id === item.id
        && candidate.fixedCanvas.ai.jobId === jobId
        ? { ...candidate, fixedCanvas: failedDraft, status: resolveFixedCanvasStatus(failedDraft) }
        : candidate));
    }
  }, [applyJobStatus, resolveJobProviderConfig, selectedItem, setItems]);

  return {
    models,
    defaultModelId: defaultModel?.id ?? '',
    defaultResolution: lastBatchAiFillSelection
      && defaultModel?.id === lastBatchAiFillSelection.modelId
      ? lastBatchAiFillSelection.resolution
      : defaultModel?.defaultResolution ?? '',
    submitting,
    submit,
    cancelSelectedAi,
    requerySelected,
  };
}
