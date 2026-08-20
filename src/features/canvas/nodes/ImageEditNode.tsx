import {
  type KeyboardEvent,
  memo,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import {
  Handle,
  Position,
  useReactFlow,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { Loader2, Sparkles, Wand2 } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import {
  AUTO_REQUEST_ASPECT_RATIO,
  DEFAULT_IMAGE_OUTPUT_COUNT,
  type ImageEditNodeData,
  type ImageSize,
} from '@/features/canvas/domain/canvasNodes';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { resolveNodeSurfaceStateClass } from '@/features/canvas/ui/nodeSurfaceStyles';
import {
  ImageGenerationRunError,
  runImageGenerationNode,
} from '@/features/canvas/application/imageGenerationRun';
import {
  resolveTextGenerationInputs,
} from '@/features/canvas/application/textGenerationInputs';
import {
  materializeImageReferencePrompt,
} from '@/features/canvas/application/imageReferencePrompt';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  beginCompositionInput,
  commitCompositionInputOnBlur,
  completeCompositionInput,
  createCompositionInputState,
  updateCompositionInputDraft,
} from '@/features/canvas/application/compositionInputState';
import {
  TEXT_GENERATION_MAX_HEIGHT,
  TEXT_GENERATION_MAX_WIDTH,
  resolveTextGenerationLayout,
} from '@/features/canvas/application/textGenerationLayout';
import {
  IMAGE_GENERATION_ASPECT_RATIO_OPTIONS,
  IMAGE_GENERATION_RESOLUTION_OPTIONS,
  listConfiguredImageModels,
  resolveImageGenerationResolution,
  resolveConfiguredImageModel,
  UNCONFIGURED_IMAGE_MODEL,
} from '@/features/canvas/models';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_FOOTER_CLASS,
  NODE_CONTROL_ICON_BUTTON_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_MODEL_CHIP_CLASS,
  NODE_CONTROL_PARAMS_CHIP_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { ModelParamsControls } from '@/features/canvas/ui/ModelParamsControls';
import { UiButton, UiTooltip } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { polishText } from '@/features/canvas/infrastructure/textPolishService';
import { resolveTextModelSelection } from '@/features/canvas/application/textModelSelection';
import { selectWorkflowNodes } from '@/features/canvas/application/canvasNodeSelectors';
import { locateReferencedNode } from '@/features/canvas/application/referencedNodeLocation';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { TextGenerationUpstreamContext } from './TextGenerationUpstreamContext';
import { usePreserveNodeCenterOnAutoResize } from '@/features/canvas/ui/usePreserveNodeCenterOnAutoResize';
import {
  ImageReferencePromptInput,
  type ImageReferencePromptInputHandle,
} from '@/features/canvas/ui/ImageReferencePromptInput';

type ImageEditNodeProps = NodeProps & {
  id: string;
  data: ImageEditNodeData;
  selected?: boolean;
};

interface AspectRatioChoice {
  value: string;
  label: string;
}

export const ImageEditNode = memo(({ id, data, selected, width, height }: ImageEditNodeProps) => {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const [error, setError] = useState<string | null>(null);
  const [isPolishing, setIsPolishing] = useState(false);
  const [isGenerationSubmitting, setIsGenerationSubmitting] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const generationSubmissionInFlightRef = useRef(false);
  const promptReferenceInputRef = useRef<ImageReferencePromptInputHandle | null>(null);
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? '');
  const promptCompositionStateRef = useRef(createCompositionInputState(data.prompt ?? ''));

  const workflowNodes = useCanvasStore(selectWorkflowNodes);
  const edges = useCanvasStore((state) => state.edges);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const reorderNodeInput = useCanvasStore((state) => state.reorderNodeInput);
  const openAiImageApi = useSettingsStore((state) => state.openAiImageApi);
  const chaomoImageApi = useSettingsStore((state) => state.chaomoImageApi);
  const customImageApis = useSettingsStore((state) => state.customImageApis);
  const lastImageModelSelection = useSettingsStore((state) => state.lastImageModelSelection);
  const setLastImageModelSelection = useSettingsStore((state) => state.setLastImageModelSelection);
  const updateLastImageGenerationOptions = useSettingsStore(
    (state) => state.updateLastImageGenerationOptions
  );
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

  const workflowInputs = useMemo(
    () => resolveTextGenerationInputs(id, workflowNodes, edges),
    [id, workflowNodes, edges]
  );

  const imageModels = useMemo(
    () =>
      listConfiguredImageModels({
        openAiImageApi,
        chaomoImageApi,
        customImageApis,
        lastImageModelSelection,
      }),
    [chaomoImageApi, customImageApis, lastImageModelSelection, openAiImageApi]
  );

  const configuredModel = useMemo(
    () =>
      resolveConfiguredImageModel(
        { openAiImageApi, chaomoImageApi, customImageApis, lastImageModelSelection },
        data.model
      ),
    [chaomoImageApi, customImageApis, data.model, lastImageModelSelection, openAiImageApi]
  );
  const hasConfiguredModel = configuredModel !== null;
  const selectedModel = configuredModel ?? UNCONFIGURED_IMAGE_MODEL;
  const resolutionOptions = IMAGE_GENERATION_RESOLUTION_OPTIONS;

  const selectedResolution = useMemo(
    () => resolveImageGenerationResolution(data.size),
    [data.size]
  );
  const outputCount = data.outputCount ?? DEFAULT_IMAGE_OUTPUT_COUNT;

  const aspectRatioOptions = useMemo<AspectRatioChoice[]>(
    () => [{
      value: AUTO_REQUEST_ASPECT_RATIO,
      label: t('modelParams.autoAspectRatio'),
    }, ...IMAGE_GENERATION_ASPECT_RATIO_OPTIONS],
    [t]
  );

  const selectedAspectRatio = useMemo(
    () =>
      aspectRatioOptions.find((item) => item.value === data.requestAspectRatio) ??
      aspectRatioOptions[0],
    [aspectRatioOptions, data.requestAspectRatio]
  );

  const layout = resolveTextGenerationLayout({
    width,
    height,
    hasTextContext: workflowInputs.textInputs.length > 0,
    hasImageContext: workflowInputs.imageInputs.length > 0,
    hasResult: false,
    isSizeManuallyAdjusted: data.isSizeManuallyAdjusted,
  });
  const resolvedWidth = layout.width;
  const resolvedHeight = layout.height;

  usePreserveNodeCenterOnAutoResize({
    nodeId: id,
    height: resolvedHeight,
    enabled: !data.isSizeManuallyAdjusted,
  });

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    const externalPrompt = data.prompt ?? '';
    if (
      promptCompositionStateRef.current.isComposing ||
      externalPrompt === promptCompositionStateRef.current.committedValue
    ) {
      return;
    }
    const nextState = createCompositionInputState(externalPrompt);
    promptCompositionStateRef.current = nextState;
    setPromptDraft(nextState.draft);
  }, [data.prompt]);

  const commitPromptDraft = useCallback((nextPrompt: string) => {
    if (promptCompositionStateRef.current.isComposing) {
      return;
    }
    updateNodeData(id, { prompt: nextPrompt });
  }, [id, updateNodeData]);

  const applyPromptDraftTransition = useCallback((transition: ReturnType<typeof updateCompositionInputDraft>) => {
    promptCompositionStateRef.current = transition.state;
    setPromptDraft(transition.state.draft);
    if (transition.committedValue !== null) {
      commitPromptDraft(transition.committedValue);
    }
  }, [commitPromptDraft]);

  const beginPromptComposition = useCallback(() => {
    promptCompositionStateRef.current = beginCompositionInput(promptCompositionStateRef.current);
  }, []);

  const handlePromptChange = useCallback((value: string, nativeIsComposing: boolean) => {
    applyPromptDraftTransition(updateCompositionInputDraft(
      promptCompositionStateRef.current,
      value,
      nativeIsComposing
    ));
  }, [applyPromptDraftTransition]);

  const completePromptComposition = useCallback((value: string) => {
    applyPromptDraftTransition(completeCompositionInput(promptCompositionStateRef.current, value));
  }, [applyPromptDraftTransition]);

  const commitPromptOnBlur = useCallback((value: string) => {
    applyPromptDraftTransition(commitCompositionInputOnBlur(promptCompositionStateRef.current, value));
  }, [applyPromptDraftTransition]);

  useEffect(() => {
    if (!hasConfiguredModel) {
      return;
    }
    if (data.model !== selectedModel.id) {
      updateNodeData(id, { model: selectedModel.id });
    }

    if (data.size !== selectedResolution.value) {
      updateNodeData(id, { size: selectedResolution.value as ImageSize });
    }

    if (data.requestAspectRatio !== selectedAspectRatio.value) {
      updateNodeData(id, { requestAspectRatio: selectedAspectRatio.value });
    }
  }, [
    data.model,
    data.requestAspectRatio,
    data.size,
    hasConfiguredModel,
    id,
    selectedAspectRatio.value,
    selectedModel.id,
    selectedResolution.value,
    updateNodeData,
  ]);

  const handlePolish = useCallback(async () => {
    if (!selectedPolishModel) {
      void showErrorDialog(t('node.textModel.required'), t('settings.polishPrompt'));
      return;
    }
    const prompt = materializeImageReferencePrompt(
      promptDraft,
      workflowInputs.imageInputs
    ).trim();
    if (!prompt) {
      void showErrorDialog('请填写提示词后再润色', '润色提示');
      return;
    }
    setIsPolishing(true);
    try {
      const result = await polishText({
        text: prompt,
        customPrompt: imagePolishConfig.prompt,
        promptType: 'image',
        reasoningEffort: imagePolishConfig.reasoningEffort ?? undefined,
      }, selectedPolishModel.apiConfig);
      if (promptCompositionStateRef.current.isComposing) {
        return;
      }
      const nextState = createCompositionInputState(result.polished);
      promptCompositionStateRef.current = nextState;
      setPromptDraft(nextState.draft);
      updateNodeData(id, { prompt: result.polished });
    } catch (err) {
      const message = err instanceof Error ? err.message : '润色失败';
      void showErrorDialog(message, '润色失败');
    } finally {
      setIsPolishing(false);
    }
  }, [id, imagePolishConfig, promptDraft, selectedPolishModel, t, updateNodeData, workflowInputs.imageInputs]);

  const handleGenerate = useCallback(async () => {
    if (!hasConfiguredModel) {
      const errorMessage = t('node.imageEdit.modelRequired');
      setError(errorMessage);
      void showErrorDialog(errorMessage, t('common.error'));
      return;
    }

    if (generationSubmissionInFlightRef.current) {
      return;
    }
    generationSubmissionInFlightRef.current = true;
    setIsGenerationSubmitting(true);

    try {
      setError(null);
      const result = await runImageGenerationNode(id, {
        fallbackResultTitle: t('node.imageEdit.resultTitle'),
        fallbackErrorMessage: t('ai.error'),
      });
      const firstFailure = result.submissions.find((submission) => submission.status === 'failed');
      if (firstFailure?.errorMessage) {
        setError(firstFailure.errorMessage);
        void showErrorDialog(
          firstFailure.errorMessage,
          t('common.error'),
          firstFailure.errorDetails,
          firstFailure.errorReport
        );
      }
    } catch (generationError) {
      let message = generationError instanceof Error
        ? generationError.message
        : t('ai.error');
      if (generationError instanceof ImageGenerationRunError) {
        if (generationError.code === 'MODEL_REQUIRED') {
          message = t('node.imageEdit.modelRequired');
        } else if (generationError.code === 'PROMPT_REQUIRED') {
          message = t('node.imageEdit.promptRequired');
        } else if (generationError.code === 'API_KEY_REQUIRED') {
          message = t('node.imageEdit.apiKeyRequired');
        } else if (generationError.code === 'REFERENCE_IMAGES_UNAVAILABLE') {
          const unavailableNames = workflowInputs.imageInputs
            .flatMap((input, index) => !input.imageUrl
              ? [t('node.imageReference.label', { index: index + 1 })]
              : [])
            .join(', ');
          message = unavailableNames
            ? t('node.textGeneration.imageUnavailableSources', { names: unavailableNames })
            : t('node.textGeneration.imageUnavailable');
        }
      }
      setError(message);
      void showErrorDialog(message, t('common.error'));
    } finally {
      generationSubmissionInFlightRef.current = false;
      setIsGenerationSubmitting(false);
    }
  }, [
    hasConfiguredModel,
    id,
    t,
    workflowInputs.imageInputs,
  ]);

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleGenerate();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`
        group relative flex h-full flex-col gap-2 overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-2 transition-colors duration-150
        ${resolveNodeSurfaceStateClass(selected)}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <TextGenerationUpstreamContext
        textInputs={workflowInputs.textInputs}
        imageInputs={workflowInputs.imageInputs}
        textContextHeight={layout.upstreamTextHeight}
        referenceImagesHeight={layout.referenceImagesHeight}
        onLocate={(nodeId) => {
          void locateReferencedNode(nodeId, {
            setSelectedNode,
            getInternalNode: reactFlow.getInternalNode,
            getViewport: reactFlow.getViewport,
            setCenter: reactFlow.setCenter,
          });
        }}
        onDisconnect={deleteEdge}
        onInsertReference={(edgeId) => promptReferenceInputRef.current?.insertReference(edgeId)}
        onReorder={(kind, draggedSourceId, targetSourceId) => {
          reorderNodeInput(id, kind, draggedSourceId, targetSourceId);
        }}
      />
      <section className="min-w-0 shrink-0">
        <div className="mb-1 text-[10px] font-medium text-text-muted">
          {t('node.imageEdit.promptLabel')}
        </div>
        <div
          className="nodrag nowheel relative overflow-visible rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]"
          style={{ height: layout.promptHeight }}
        >
          <ImageReferencePromptInput
            ref={promptReferenceInputRef}
            value={promptDraft}
            imageInputs={workflowInputs.imageInputs}
            placeholder={t('node.imageEdit.promptPlaceholder')}
            ariaLabel={t('node.imageEdit.promptLabel')}
            onKeyDown={handlePromptKeyDown}
            onCompositionStart={beginPromptComposition}
            onCompositionEnd={completePromptComposition}
            onBlur={commitPromptOnBlur}
            onValueChange={handlePromptChange}
          />
        </div>
      </section>

      <div className={`${NODE_CONTROL_FOOTER_CLASS} gap-1`}>
        {hasConfiguredModel ? (
          <ModelParamsControls
            imageModels={imageModels}
            selectedModel={selectedModel}
            resolutionOptions={resolutionOptions}
            selectedResolution={selectedResolution}
            selectedAspectRatio={selectedAspectRatio}
            aspectRatioOptions={aspectRatioOptions}
            onModelChange={(modelId) => {
              const model = imageModels.find((item) => item.id === modelId);
              if (!model) {
                return;
              }
              updateNodeData(id, { model: modelId });
              setLastImageModelSelection({ providerId: model.providerId, modelId });
            }}
            onResolutionChange={(resolution) => {
              const size = resolution as ImageSize;
              updateNodeData(id, { size });
              updateLastImageGenerationOptions({ size });
            }
            }
            onAspectRatioChange={(aspectRatio) => {
              updateNodeData(id, { requestAspectRatio: aspectRatio });
              updateLastImageGenerationOptions({ requestAspectRatio: aspectRatio });
            }
            }
            outputCount={outputCount}
            onOutputCountChange={(nextOutputCount) => {
              updateNodeData(id, { outputCount: nextOutputCount });
              updateLastImageGenerationOptions({ outputCount: nextOutputCount });
            }}
            extraParams={data.extraParams}
            onExtraParamChange={(key, value) => {
              const extraParams = {
                ...(data.extraParams ?? {}),
                [key]: value,
              };
              updateNodeData(id, {
                extraParams: {
                  ...extraParams,
                },
              });
              updateLastImageGenerationOptions({ extraParams });
            }}
            triggerSize="sm"
            chipClassName={NODE_CONTROL_CHIP_CLASS}
            modelChipClassName={NODE_CONTROL_MODEL_CHIP_CLASS}
            paramsChipClassName={NODE_CONTROL_PARAMS_CHIP_CLASS}
          />
        ) : (
          <UiButton
            variant="muted"
            size="sm"
            className={`nodrag nowheel shrink-0 ${NODE_CONTROL_CHIP_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              openSettingsDialog({ category: 'imageApis' });
            }}
          >
            {t('modelParams.configureImageModel')}
          </UiButton>
        )}

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
          className={`nodrag nowheel min-w-[88px] shrink-0 ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
          disabled={!hasConfiguredModel || isGenerationSubmitting}
          aria-busy={isGenerationSubmitting}
        >
          {isGenerationSubmitting ? (
            <Loader2 className={`${NODE_CONTROL_ICON_CLASS} animate-spin`} strokeWidth={2.8} />
          ) : (
            <Sparkles className={NODE_CONTROL_ICON_CLASS} strokeWidth={2.8} />
          )}
          {isGenerationSubmitting ? t('node.imageEdit.submitting') : t('canvas.generate')}
        </UiButton>
      </div>

      {error && <div className="mt-1 shrink-0 text-xs text-red-400">{error}</div>}

      <Handle
        type="target"
        id="target"
        position={Position.Left}
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
      />
      <NodeResizeHandle
        minWidth={layout.minWidth}
        minHeight={layout.minHeight}
        maxWidth={TEXT_GENERATION_MAX_WIDTH}
        maxHeight={TEXT_GENERATION_MAX_HEIGHT}
      />
    </div>
  );
});

ImageEditNode.displayName = 'ImageEditNode';
