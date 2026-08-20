import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Loader2, Music, Video, Wand2 } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  type SeedanceVideoInputMode,
  type VideoGenNodeData,
  type VideoResolution,
} from '@/features/canvas/domain/canvasNodes';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { resolveNodeSurfaceStateClass } from '@/features/canvas/ui/nodeSurfaceStyles';
import {
  canvasAiGateway,
} from '@/features/canvas/application/canvasServices';
import {
  resolveAudioDisplayUrl,
  resolveImageDisplayUrl,
  resolveVideoDisplayUrl,
} from '@/features/canvas/application/imageData';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { polishText } from '@/features/canvas/infrastructure/textPolishService';
import { resolveTextModelSelection } from '@/features/canvas/application/textModelSelection';
import { resolveVideoApiConfig } from '@/features/canvas/application/videoApiSelection';
import { selectWorkflowNodes } from '@/features/canvas/application/canvasNodeSelectors';
import {
  buildSeedanceVideoRequestPlan,
  getSeedanceFirstLastModeAvailability,
  getSeedance20ModelCapabilities,
  isSeedance20Model,
  type SeedanceMediaType,
  type SeedanceVideoContent,
  type SeedanceVideoValidationCode,
} from '@/features/canvas/application/seedanceVideoRequestPlan';
import { resolveSeedanceVideoGraphInputs } from '@/features/canvas/application/seedanceVideoGraphInputs';
import { resolveEffectivePromptForNode } from '@/features/canvas/application/textGenerationInputs';
import {
  TEXT_GENERATION_MAX_HEIGHT,
  TEXT_GENERATION_MAX_WIDTH,
  resolveTextGenerationLayout,
} from '@/features/canvas/application/textGenerationLayout';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_FOOTER_CLASS,
  NODE_CONTROL_ICON_BUTTON_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { UiButton, UiSelect, UiTooltip } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { logger } from '@/lib/logger';
import { usePreserveNodeCenterOnAutoResize } from '@/features/canvas/ui/usePreserveNodeCenterOnAutoResize';
import { getVideoApiControlLabel } from '@/features/canvas/ui/videoApiLabel';
import { createVideoOutputNode } from '@/features/canvas/application/videoOutput';

type VideoGenNodeProps = NodeProps & {
  id: string;
  data: VideoGenNodeData;
  selected?: boolean;
};

const DEFAULT_SEEDANCE_2_RESOLUTIONS: VideoResolution[] = ['480p', '720p', '1080p', '4k'];
const DEFAULT_SEEDANCE_2_DURATIONS = Array.from({ length: 12 }, (_, index) => index + 4);
const VIDEO_GENERATION_DEFAULT_WIDTH = 680;
const VIDEO_GENERATION_MIN_WIDTH = 640;
const SEEDANCE_2_ASPECT_RATIOS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'] as const;

function getVideoControlOptions(modelId: string): {
  resolutions: VideoResolution[];
  durations: number[];
} {
  const capabilities = getSeedance20ModelCapabilities(modelId);
  if (!capabilities) {
    return {
      resolutions: DEFAULT_SEEDANCE_2_RESOLUTIONS,
      durations: DEFAULT_SEEDANCE_2_DURATIONS,
    };
  }

  return {
    resolutions: [...capabilities.resolutions],
    durations: Array.from(
      { length: capabilities.maxDuration - capabilities.minDuration + 1 },
      (_, index) => capabilities.minDuration + index
    ),
  };
}

function getPlanValidationMessageKey(code: SeedanceVideoValidationCode): string {
  return `node.videoGen.validation.${code}`;
}

interface ReferencePreview {
  type: SeedanceMediaType;
  url: string;
  label: string;
  sourceNodeId: string;
  referenceIndex: number;
}

export const VideoGenNode = memo(({ id, data, selected, width, height }: VideoGenNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const workflowNodes = useCanvasStore(selectWorkflowNodes);
  const edges = useCanvasStore((state) => state.edges);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const reorderNodeInput = useCanvasStore((state) => state.reorderNodeInput);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const addNodeBatch = useCanvasStore((state) => state.addNodeBatch);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const videoApis = useSettingsStore((state) => state.videoApis);
  const textApis = useSettingsStore((state) => state.textApis);
  const imagePolishConfig = useSettingsStore((state) => state.imagePolishConfig);
  const selectedPolishModel = useMemo(
    () => resolveTextModelSelection(
      textApis,
      imagePolishConfig.textApiId ?? undefined,
      imagePolishConfig.textModelId ?? undefined
    ),
    [imagePolishConfig.textApiId, imagePolishConfig.textModelId, textApis]
  );
  const nodeType = workflowNodes.find((node) => node.id === id)?.type;
  const isLegacyVideoFrame = nodeType === CANVAS_NODE_TYPES.videoFrame;
  const inputMode = isLegacyVideoFrame ? 'first-last' : data.inputMode ?? 'automatic';
  const isFirstLastMode = inputMode === 'first-last';
  const videoApiOptions = useMemo(() => {
    return videoApis.filter((api) => (
      api.modelId.trim().length > 0 && isSeedance20Model(api.modelId)
    ));
  }, [videoApis]);
  const selectedVideoApi = useMemo(
    () => resolveVideoApiConfig(videoApis, data.videoApiId, data.model),
    [data.model, data.videoApiId, videoApis]
  );
  const isSelectedVideoApiSelectable = Boolean(
    selectedVideoApi && videoApiOptions.some((api) => api.id === selectedVideoApi.id)
  );
  const selectedModel = selectedVideoApi?.modelId ?? data.model;

  const [promptDraft, setPromptDraft] = useState(data.prompt || '');
  const [isPolishing, setIsPolishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptDraftRef = useRef(promptDraft);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptHighlightRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const draggedReferenceSourceIdRef = useRef<string | null>(null);

  const seedanceGraphInputs = useMemo(
    () => resolveSeedanceVideoGraphInputs(id, workflowNodes, edges),
    [id, workflowNodes, edges]
  );
  const effectivePrompt = useMemo(
    () => resolveEffectivePromptForNode(id, promptDraft, workflowNodes, edges),
    [edges, id, promptDraft, workflowNodes]
  );
  const videoControlOptions = useMemo(
    () => getVideoControlOptions(selectedModel),
    [selectedModel]
  );
  const selectedResolution = videoControlOptions.resolutions.includes(data.resolution ?? '720p')
    ? data.resolution ?? '720p'
    : videoControlOptions.resolutions[0];
  const selectedDuration = videoControlOptions.durations.includes(data.duration ?? 5)
    ? data.duration ?? 5
    : videoControlOptions.durations[0];
  const firstLastModeAvailability = useMemo(
    () => getSeedanceFirstLastModeAvailability(seedanceGraphInputs),
    [seedanceGraphInputs]
  );
  const firstLastModeDisabledReason = useMemo(() => {
    if (firstLastModeAvailability.isAvailable) {
      return undefined;
    }
    const reasons: string[] = [];
    if (firstLastModeAvailability.imageCount < 1 || firstLastModeAvailability.imageCount > 2) {
      reasons.push(t('node.videoGen.firstLastImageCount', {
        count: firstLastModeAvailability.imageCount,
      }));
    }
    if (firstLastModeAvailability.videoCount > 0) {
      reasons.push(t('node.videoGen.firstLastVideoUnsupported', {
        count: firstLastModeAvailability.videoCount,
      }));
    }
    if (firstLastModeAvailability.audioCount > 0) {
      reasons.push(t('node.videoGen.firstLastAudioUnsupported', {
        count: firstLastModeAvailability.audioCount,
      }));
    }
    return reasons.join('；');
  }, [firstLastModeAvailability, t]);
  const seedanceRequestPlan = useMemo(() => {
    return buildSeedanceVideoRequestPlan({
      kind: isFirstLastMode ? 'strict-frame' : 'automatic',
      model: selectedModel,
      prompt: effectivePrompt,
      resolution: selectedResolution,
      duration: selectedDuration,
      media: seedanceGraphInputs,
    });
  }, [
    effectivePrompt,
    isFirstLastMode,
    seedanceGraphInputs,
    selectedDuration,
    selectedModel,
    selectedResolution,
  ]);

  const canGenerate = seedanceRequestPlan.ok;

  // Validate model and API key for generating
  const hasSelectedApiKey = Boolean(selectedVideoApi?.apiKey.trim());
  const hasSelectedApiBaseUrl = Boolean(selectedVideoApi?.baseUrl.trim());

  // Compute why generation is disabled (for button tooltip)
  const getGenerationDisabledReason = (): string | undefined => {
    if (!selectedVideoApi) {
      return t('node.videoGen.apiRequired');
    }
    if (!isSelectedVideoApiSelectable) {
      return t(getPlanValidationMessageKey('seedance_2_model_required'));
    }
    if (!selectedVideoApi.enabled) {
      return t('node.videoGen.apiDisabled');
    }
    if (!hasSelectedApiKey) {
      return t('node.videoGen.apiKeyRequired');
    }
    if (!hasSelectedApiBaseUrl) {
      return t('node.videoGen.apiBaseUrlRequired');
    }
    if (!seedanceRequestPlan.ok) {
      return t(getPlanValidationMessageKey(seedanceRequestPlan.error.code));
    }
    return undefined;
  };
  const generationDisabledReason = getGenerationDisabledReason();
  const isGenerationDisabled = !canGenerate
    || !selectedVideoApi
    || !isSelectedVideoApiSelectable
    || !selectedVideoApi.enabled
    || !hasSelectedApiKey
    || !hasSelectedApiBaseUrl;

  const referencePreviews = useMemo<ReferencePreview[]>(() => {
    const nextIndexes: Record<SeedanceMediaType, number> = {
      image: 0,
      video: 0,
      audio: 0,
    };
    return seedanceGraphInputs.flatMap((input) => {
      const url = input.url?.trim();
      if (!url) {
        return [];
      }
      nextIndexes[input.type] += 1;
      const referenceIndex = nextIndexes[input.type];
      const label = isFirstLastMode && input.type === 'image'
        ? referenceIndex === 1
          ? t('node.videoGen.firstFrame')
          : referenceIndex === 2
            ? t('node.videoGen.lastFrame')
            : t('node.videoGen.referenceImage', { index: referenceIndex })
        : t(`node.videoGen.reference${input.type[0].toUpperCase()}${input.type.slice(1)}`, {
          index: referenceIndex,
        });
      return [{
        type: input.type,
        url,
        label,
        sourceNodeId: input.sourceNodeId,
        referenceIndex,
      }];
    });
  }, [isFirstLastMode, seedanceGraphInputs, t]);

  const layout = resolveTextGenerationLayout({
    width,
    height,
    hasImageContext: referencePreviews.length > 0,
    hasResult: false,
    isSizeManuallyAdjusted: data.isSizeManuallyAdjusted,
  });
  const resolvedWidth = data.isSizeManuallyAdjusted
    ? Math.max(layout.width, VIDEO_GENERATION_MIN_WIDTH)
    : VIDEO_GENERATION_DEFAULT_WIDTH;
  const resolvedHeight = layout.height;

  usePreserveNodeCenterOnAutoResize({
    nodeId: id,
    height: resolvedHeight,
    enabled: !data.isSizeManuallyAdjusted,
  });

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  // Update promptDraft when data.prompt changes externally
  useEffect(() => {
    setPromptDraft(data.prompt || '');
  }, [data.prompt]);

  useEffect(() => {
    promptDraftRef.current = promptDraft;
  }, [promptDraft]);

  const commitPromptDraft = useCallback((nextPrompt: string) => {
    promptDraftRef.current = nextPrompt;
    updateNodeData(id, { prompt: nextPrompt });
  }, [id, updateNodeData]);

  const syncPromptHighlightScroll = useCallback(() => {
    if (!promptRef.current || !promptHighlightRef.current) {
      return;
    }
    promptHighlightRef.current.scrollTop = promptRef.current.scrollTop;
    promptHighlightRef.current.scrollLeft = promptRef.current.scrollLeft;
  }, []);

  const handlePolish = useCallback(async () => {
    if (!selectedPolishModel) {
      void showErrorDialog(t('node.textModel.required'), t('settings.polishPrompt'));
      return;
    }

    const connectedImages = seedanceGraphInputs.flatMap(
      (input) => input.type === 'image' && input.url ? [input.url] : []
    );
    if (isFirstLastMode && connectedImages.length === 0) {
      void showErrorDialog(t('node.videoGen.polishImageRequired'), t('node.videoGen.polishTitle'));
      return;
    }

    const prompt = promptDraft.trim();
    const referenceKinds = [
      connectedImages.length > 0 ? '参考图片' : null,
      seedanceGraphInputs.some((input) => input.type === 'video' && input.url) ? '参考视频' : null,
      seedanceGraphInputs.some((input) => input.type === 'audio' && input.url) ? '参考音频' : null,
    ].filter((value): value is string => Boolean(value));
    const referenceText = isFirstLastMode
      ? connectedImages.length > 1
        ? '图1（首帧）、图2（尾帧）'
        : '图1（首帧）'
      : referenceKinds.join('、');

    let textToPolish: string;
    if (prompt) {
      textToPolish = referenceText
        ? `${referenceText}\n\n请根据以上参考内容优化这个视频提示词：${prompt}`
        : `请优化这个视频提示词：${prompt}`;
    } else if (isFirstLastMode) {
      textToPolish = `请根据以下首尾帧图片生成一个适合AI视频的提示词：\n${referenceText}`;
    } else if (referenceText) {
      textToPolish = `请根据以下参考内容生成一个适合AI视频的提示词：\n${referenceText}`;
    } else {
      textToPolish = '请生成一个适合AI视频的提示词。';
    }

    setIsPolishing(true);
    try {
      const effectivePolishPrompt = selectedVideoApi?.polishPrompt
        || selectedVideoApi?.defaultPolishPrompt;

      const result = await polishText({
        text: textToPolish,
        referenceImages: connectedImages,
        videoDuration: selectedDuration.toString(),
        videoResolution: selectedResolution,
        videoAspectRatio: data.aspectRatio,
        isVideoFrame: isFirstLastMode,
        customPrompt: effectivePolishPrompt,
        promptType: 'video',
        reasoningEffort: imagePolishConfig.reasoningEffort ?? undefined,
      }, selectedPolishModel.apiConfig);
      setPromptDraft(result.polished);
      updateNodeData(id, { prompt: result.polished });
    } catch (err) {
      let message = t('node.videoGen.polishFailed');
      if (err instanceof Error) {
        message = err.message;
      } else if (typeof err === 'string') {
        message = err;
      } else if (err && typeof err === 'object') {
        const errObj = err as Record<string, unknown>;
        if (errObj.message) {
          message = String(errObj.message);
        } else {
          message = JSON.stringify(err);
        }
      }
      void showErrorDialog(message, t('node.videoGen.polishFailed'));
    } finally {
      setIsPolishing(false);
    }
  }, [
    data,
    id,
    imagePolishConfig.reasoningEffort,
    isFirstLastMode,
    promptDraft,
    seedanceGraphInputs,
    selectedDuration,
    selectedPolishModel,
    selectedResolution,
    selectedVideoApi,
    t,
    updateNodeData,
  ]);

  const handleGenerate = useCallback(async () => {
    if (!selectedVideoApi) {
      const msg = t('node.videoGen.apiRequired');
      setError(msg);
      void showErrorDialog(msg, t('common.error'));
      return;
    }

    if (!isSelectedVideoApiSelectable) {
      const msg = t(getPlanValidationMessageKey('seedance_2_model_required'));
      setError(msg);
      return;
    }

    if (!seedanceRequestPlan.ok) {
      const msg = t(getPlanValidationMessageKey(seedanceRequestPlan.error.code));
      setError(msg);
      return;
    }
    const textContent = seedanceRequestPlan.plan.content.find(
      (content): content is Extract<SeedanceVideoContent, { type: 'text' }> => content.type === 'text'
    );
    const prompt = textContent?.text ?? '';
    const videoContent = seedanceRequestPlan.plan.content;

    if (!prompt) {
      void showErrorDialog(t('node.imageEdit.promptRequired'), t('common.error'));
      return;
    }

    if (!selectedVideoApi.enabled) {
      const errorMsg = t('node.videoGen.apiDisabled');
      setError(errorMsg);
      return;
    }

    const providerApiKey = selectedVideoApi.apiKey.trim();

    if (!providerApiKey) {
      const errorMsg = t('node.videoGen.apiKeyRequired');
      setError(errorMsg);
      return;
    }
    if (!selectedVideoApi.baseUrl.trim()) {
      const errorMsg = t('node.videoGen.apiBaseUrlRequired');
      setError(errorMsg);
      return;
    }

    if (data.videoApiId !== selectedVideoApi.id || data.model !== selectedModel) {
      updateNodeData(id, {
        videoApiId: selectedVideoApi.id,
        model: selectedModel,
      });
    }

    const generationStartedAt = Date.now();
    const generationDurationMs = 120000;
    setError(null);

    const currentCanvas = useCanvasStore.getState();
    const newNodeId = createVideoOutputNode({
      sourceNodeId: id,
      existingNodes: currentCanvas.nodes,
      existingEdges: currentCanvas.edges,
      addNodeBatch,
      addEdge,
      data: {
        isGenerating: true,
        generationStartedAt,
        generationDurationMs,
        displayName: t('node.videoGen.title'),
        aspectRatio: data.aspectRatio || '16:9',
        model: selectedModel,
        videoApiId: selectedVideoApi.id,
        resolution: selectedResolution,
        duration: selectedDuration,
        hasAudio: true,
        watermark: false,
        prompt,
      },
    });
    if (!newNodeId) {
      return;
    }

    try {
      const extraParams = {
        duration: selectedDuration,
        hasaudio: true,
        watermark: false,
      };

      const providerId = 'volcvideo';

      const projectId = useProjectStore.getState().getCurrentProject()?.id;
      const jobId = await canvasAiGateway.submitGenerateImageJob({
        prompt,
        model: selectedModel,
        providerId,
        size: selectedResolution,
        aspectRatio: data.aspectRatio || '16:9',
        videoContent,
        extraParams,
        providerConfig: {
          api_key: providerApiKey,
          base_url: selectedVideoApi.baseUrl.trim(),
          config_id: selectedVideoApi.id,
          protocol: selectedVideoApi.protocol ?? 'volcengine-seedance',
        },
        projectId,
      });

      updateNodeData(newNodeId, {
        generationJobId: jobId,
        generationProviderId: providerId,
      });
    } catch (err) {
      logger.error('[VideoGen] Generation error caught:', err);
      const errorDetail = err instanceof Error ? err.message : String(err);
      let guidance = errorDetail;
      if (errorDetail.includes('VolcVOD')) {
        guidance = errorDetail;
      } else if (errorDetail.includes('missing task_id')) {
        guidance = errorDetail;
      }
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationJobId: null,
        generationError: guidance,
      });
      setError(guidance);
    }
  }, [
    addEdge,
    addNodeBatch,
    data,
    id,
    isSelectedVideoApiSelectable,
    seedanceRequestPlan,
    selectedDuration,
    selectedModel,
    selectedResolution,
    selectedVideoApi,
    t,
    updateNodeData,
  ]);

  const handlePromptKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleGenerate();
    }
  }, [handleGenerate]);

  const handleResolutionChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    updateNodeData(id, { resolution: e.target.value as VideoResolution });
  }, [id, updateNodeData]);

  const handleVideoApiChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const api = videoApiOptions.find((candidate) => candidate.id === e.target.value);
    const newModel = api?.modelId ?? '';
    const controlOptions = getVideoControlOptions(newModel);
    const updates: Partial<VideoGenNodeData> = {
      model: newModel,
      videoApiId: api?.id ?? null,
    };
    if (!controlOptions.resolutions.includes(data.resolution ?? '720p')) {
      updates.resolution = controlOptions.resolutions[0];
    }
    if (!controlOptions.durations.includes(data.duration ?? 5)) {
      updates.duration = controlOptions.durations[0];
    }
    updateNodeData(id, updates);
  }, [data.duration, data.resolution, id, updateNodeData, videoApiOptions]);

  const handleDurationChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    updateNodeData(id, { duration: parseInt(e.target.value, 10) });
  }, [id, updateNodeData]);

  const handleInputModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextMode = e.target.value as SeedanceVideoInputMode;
    if (nextMode === 'first-last' && !firstLastModeAvailability.isAvailable) {
      return;
    }
    updateNodeData(id, { inputMode: nextMode });
  }, [firstLastModeAvailability.isAvailable, id, updateNodeData]);

  const handleAspectRatioChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    updateNodeData(id, { aspectRatio: e.target.value });
  }, [id, updateNodeData]);

  const handleReferenceDragStart = useCallback((event: DragEvent<HTMLDivElement>, reference: ReferencePreview) => {
    if (!isFirstLastMode || reference.type !== 'image') {
      return;
    }
    draggedReferenceSourceIdRef.current = reference.sourceNodeId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', reference.sourceNodeId);
  }, [isFirstLastMode]);

  const handleReferenceDrop = useCallback((event: DragEvent<HTMLDivElement>, reference: ReferencePreview) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedSourceId = draggedReferenceSourceIdRef.current;
    draggedReferenceSourceIdRef.current = null;
    if (!isFirstLastMode || reference.type !== 'image' || !draggedSourceId) {
      return;
    }
    reorderNodeInput(id, 'image', draggedSourceId, reference.sourceNodeId);
  }, [id, isFirstLastMode, reorderNodeInput]);

  return (
    <div
      ref={rootRef}
      className={`group relative flex h-full flex-col gap-2 overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-2 transition-colors duration-150 ${resolveNodeSurfaceStateClass(selected)}`}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      {isLegacyVideoFrame ? (
        <>
          <span className="pointer-events-none absolute left-3 top-[35%] z-10 -translate-y-1/2 text-[10px] font-medium text-text-muted">
            {t('node.videoGen.firstFrame')}
          </span>
          <Handle type="target" id="target-first" position={Position.Left} style={{ top: '35%' }} />
          <span className="pointer-events-none absolute left-3 top-[65%] z-10 -translate-y-1/2 text-[10px] font-medium text-text-muted">
            {t('node.videoGen.lastFrame')}
          </span>
          <Handle type="target" id="target-last" position={Position.Left} style={{ top: '65%' }} />
        </>
      ) : (
        <Handle type="target" id="target" position={Position.Left} />
      )}

      {referencePreviews.length > 0 && (
        <section className="min-w-0 shrink-0" aria-label={t('node.videoGen.referenceInputs')}>
          <div className="mb-1 text-[10px] font-medium text-text-muted">
            {t('node.videoGen.referenceInputs')}
          </div>
          <div
            className="no-scrollbar nowheel flex min-w-0 gap-1.5 overflow-x-auto overflow-y-hidden rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]/70 p-2"
            style={{ height: layout.referenceImagesHeight }}
          >
            {referencePreviews.map((reference) => {
              const isAudio = reference.type === 'audio';
              return (
                <div
                  key={`${reference.sourceNodeId}-${reference.type}-${reference.referenceIndex}`}
                  draggable={isFirstLastMode && reference.type === 'image'}
                  title={isFirstLastMode && reference.type === 'image'
                    ? `${reference.label} · ${t('node.videoGen.firstLastDragHint')}`
                    : reference.label}
                  onDragStart={(event) => handleReferenceDragStart(event, reference)}
                  onDragOver={(event) => {
                    if (isFirstLastMode && reference.type === 'image') {
                      event.preventDefault();
                    }
                  }}
                  onDrop={(event) => handleReferenceDrop(event, reference)}
                  className={`nodrag nowheel relative h-16 shrink-0 overflow-hidden rounded-md border border-[var(--ui-border-soft)] bg-bg-dark ${
                    isAudio ? 'w-40' : 'w-16'
                  } ${isFirstLastMode && reference.type === 'image' ? 'cursor-grab active:cursor-grabbing' : ''
                  }`}
                >
                  {reference.type === 'image' ? (
                    <img
                      src={resolveImageDisplayUrl(reference.url)}
                      alt={reference.label}
                      className="h-full w-full rounded-[inherit] object-cover"
                      draggable={false}
                    />
                  ) : reference.type === 'video' ? (
                    <video
                      src={resolveVideoDisplayUrl(reference.url)}
                      aria-label={reference.label}
                      className="h-full w-full rounded-[inherit] object-cover"
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <div className="flex h-full items-center gap-1.5 px-2">
                      <Music className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                      <audio
                        controls
                        src={resolveAudioDisplayUrl(reference.url)}
                        aria-label={reference.label}
                        className="h-7 min-w-0 flex-1"
                        preload="metadata"
                      />
                    </div>
                  )}
                  <span className="pointer-events-none absolute bottom-0.5 right-0.5 z-10 max-w-[calc(100%-4px)] truncate rounded border border-white/25 bg-black/70 px-1 text-[10px] font-semibold leading-4 text-white shadow-md backdrop-blur-sm">
                    {reference.label}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Prompt Input (labeled section, flex-1, only region that scrolls) */}
      <section className="min-w-0 flex-1">
        <div className="mb-1 text-[10px] font-medium text-text-muted">
          {t('node.videoGen.promptLabel')}
        </div>
        <div
          className="nodrag nowheel relative overflow-visible rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]"
          style={{ height: layout.promptHeight }}
        >
          <div className="relative h-full min-h-0">
            <div
              ref={promptHighlightRef}
              aria-hidden="true"
              className="ui-scrollbar absolute inset-0 overflow-y-auto overflow-x-hidden text-sm leading-6 text-text-dark pointer-events-none"
              style={{ scrollbarGutter: 'stable' }}
            >
              <div className="min-h-full whitespace-pre-wrap break-words px-1 py-0.5">
                {promptDraft || ' '}
              </div>
            </div>
            <textarea
              ref={promptRef}
              value={promptDraft}
              onChange={(e) => {
                const nextValue = e.target.value;
                setPromptDraft(nextValue);
                commitPromptDraft(nextValue);
              }}
              onKeyDown={handlePromptKeyDown}
              onScroll={syncPromptHighlightScroll}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder={t('node.videoGen.promptPlaceholder')}
              className="ui-scrollbar nodrag nowheel relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden border-none bg-transparent px-1 py-0.5 text-sm leading-6 text-text-dark outline-none placeholder:text-text-muted/80 focus:border-transparent whitespace-pre-wrap break-words"
              style={{ scrollbarGutter: 'stable' }}
            />
          </div>
        </div>
      </section>

      {/* Error */}
      {error && (
        <div className="shrink-0 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Footer (32px) */}
      <div className={`${NODE_CONTROL_FOOTER_CLASS} gap-1`}>
        <div className="w-[8.75rem] shrink-0">
          <UiSelect
            className={`nodrag nowheel ${NODE_CONTROL_CHIP_CLASS} !h-6 !w-full !min-w-0 !justify-between font-mono text-text-dark`}
            value={isSelectedVideoApiSelectable ? selectedVideoApi?.id ?? '' : ''}
            onChange={handleVideoApiChange}
            aria-label={t('node.videoGen.model')}
            menuMinWidth={272}
            disabled={videoApiOptions.length === 0}
            compact
          >
            {videoApiOptions.map((api) => (
              <option key={api.id} value={api.id}>
                {getVideoApiControlLabel(api)}
              </option>
            ))}
          </UiSelect>
        </div>

        <div className="w-[5.75rem] shrink-0">
          <UiSelect
            className={`nodrag nowheel ${NODE_CONTROL_CHIP_CLASS} !h-6 !w-full !min-w-0 !justify-between text-text-dark`}
            value={inputMode}
            onChange={handleInputModeChange}
            aria-label={t('node.videoGen.inputMode')}
            compact
          >
            <option value="automatic">{t('node.videoGen.automaticMode')}</option>
            <option
              value="first-last"
              disabled={!firstLastModeAvailability.isAvailable && !isFirstLastMode}
              data-disabled-reason={firstLastModeDisabledReason}
            >
              {t('node.videoGen.firstLastMode')}
            </option>
          </UiSelect>
        </div>

        <div className="w-[4.5rem] shrink-0">
          <UiSelect
            className={`nodrag nowheel ${NODE_CONTROL_CHIP_CLASS} !h-6 !w-full !min-w-0 !justify-between font-mono text-text-dark`}
            value={data.aspectRatio || '16:9'}
            onChange={handleAspectRatioChange}
            aria-label={t('node.videoGen.size')}
            compact
          >
            {SEEDANCE_2_ASPECT_RATIOS.map((ratio) => (
              <option key={ratio} value={ratio}>{ratio}</option>
            ))}
          </UiSelect>
        </div>

        <div className="w-[4.75rem] shrink-0">
          <UiSelect
            className={`nodrag nowheel ${NODE_CONTROL_CHIP_CLASS} !h-6 !w-full !min-w-0 !justify-between font-mono text-text-dark`}
            value={selectedResolution}
            onChange={handleResolutionChange}
            aria-label={t('node.videoGen.resolution')}
            compact
          >
            {videoControlOptions.resolutions.map((resolution) => (
              <option key={resolution} value={resolution}>
                {resolution}
              </option>
            ))}
          </UiSelect>
        </div>

        <div className="w-[4.25rem] shrink-0">
          <UiSelect
            className={`nodrag nowheel ${NODE_CONTROL_CHIP_CLASS} !h-6 !w-full !min-w-0 !justify-between font-mono text-text-dark`}
            value={selectedDuration}
            onChange={handleDurationChange}
            aria-label={t('node.videoGen.duration')}
            compact
          >
            {videoControlOptions.durations.map((d) => (
              <option key={d} value={d}>
                {d}{t('node.videoGen.durationUnit')}
              </option>
            ))}
          </UiSelect>
        </div>

        <UiTooltip content={t('node.imageEdit.polishPrompt')}>
          <UiButton
            aria-label={t('node.imageEdit.polishPrompt')}
            onClick={(event) => {
              event.stopPropagation();
              void handlePolish();
            }}
            variant="muted"
            size="sm"
            className={`nodrag nowheel shrink-0 ${NODE_CONTROL_ICON_BUTTON_CLASS}`}
            disabled={isPolishing}
          >
            {isPolishing ? (
              <Loader2 className={`${NODE_CONTROL_ICON_CLASS} animate-spin`} strokeWidth={2.8} />
            ) : (
              <Wand2 className={NODE_CONTROL_ICON_CLASS} strokeWidth={2.8} />
            )}
          </UiButton>
        </UiTooltip>

        <div className="ml-auto" />

        <UiButton
          onClick={(event) => {
            event.stopPropagation();
            void handleGenerate();
          }}
          variant="primary"
          className={`nodrag nowheel shrink-0 ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
          disabled={isGenerationDisabled}
          title={generationDisabledReason}
        >
          <Video className={NODE_CONTROL_ICON_CLASS} strokeWidth={2.8} />
          {t('node.videoGen.generateVideo')}
        </UiButton>
      </div>

      <Handle type="source" id="source" position={Position.Right} />

      <NodeResizeHandle
        minWidth={VIDEO_GENERATION_MIN_WIDTH}
        minHeight={layout.minHeight}
        maxWidth={TEXT_GENERATION_MAX_WIDTH}
        maxHeight={TEXT_GENERATION_MAX_HEIGHT}
      />
    </div>
  );
});

VideoGenNode.displayName = 'VideoGenNode';
