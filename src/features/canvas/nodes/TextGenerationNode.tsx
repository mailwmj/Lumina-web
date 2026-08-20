import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Handle,
  Position,
  useReactFlow,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiModal, UiTooltip } from '@/components/ui';
import { AlertTriangle, Loader2, Sparkles, Square, Wand2, X } from '@/components/ui/icons';
import {
  resolveTextGenerationInputs,
  type ResolvedTextGenerationInputs,
} from '@/features/canvas/application/textGenerationInputs';
import { materializeImageReferencePrompt } from '@/features/canvas/application/imageReferencePrompt';
import { textGenerationGateway } from '@/features/canvas/application/canvasServices';
import type { TextProviderRuntimeConfig } from '@/features/canvas/application/ports';
import {
  TextGenerationRunController,
  canStartTextGeneration,
} from '@/features/canvas/application/textGenerationRun';
import {
  beginCompositionInput,
  commitCompositionInputOnBlur,
  completeCompositionInput,
  createCompositionInputState,
  shouldSuppressKeyboardCommand,
  updateCompositionInputDraft,
} from '@/features/canvas/application/compositionInputState';
import {
  TEXT_GENERATION_MAX_HEIGHT,
  TEXT_GENERATION_MAX_WIDTH,
  resolveTextGenerationLayout,
} from '@/features/canvas/application/textGenerationLayout';
import { locateReferencedNode } from '@/features/canvas/application/referencedNodeLocation';
import { resolveTextModelSelection } from '@/features/canvas/application/textModelSelection';
import { selectWorkflowNodes } from '@/features/canvas/application/canvasNodeSelectors';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { polishText } from '@/features/canvas/infrastructure/textPolishService';
import type { TextGenerationNodeData } from '@/features/canvas/domain/canvasNodes';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import {
  NODE_CONTROL_ICON_BUTTON_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_FOOTER_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { resolveNodeSurfaceStateClass } from '@/features/canvas/ui/nodeSurfaceStyles';
import { TextModelSelector } from '@/features/canvas/ui/TextModelSelector';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { TextGenerationUpstreamContext } from './TextGenerationUpstreamContext';
import { usePreserveNodeCenterOnAutoResize } from '@/features/canvas/ui/usePreserveNodeCenterOnAutoResize';
import {
  ImageReferencePromptInput,
  type ImageReferencePromptInputHandle,
} from '@/features/canvas/ui/ImageReferencePromptInput';

type TextGenerationNodeProps = NodeProps & {
  id: string;
  data: TextGenerationNodeData;
  selected?: boolean;
};

interface RunSnapshot {
  prompt: string;
  referenceImages: string[];
  reasoningEffort: TextGenerationNodeData['textReasoningEffort'];
  apiConfig: TextProviderRuntimeConfig;
}

interface NodeError {
  message: string;
  details?: string;
}

function normalizeError(error: unknown, fallback: string): NodeError {
  if (error instanceof Error) {
    const details = typeof (error as Error & { details?: unknown }).details === 'string'
      ? (error as Error & { details?: string }).details
      : undefined;
    return { message: error.message || fallback, details };
  }
  if (typeof error === 'string') {
    return { message: error || fallback, details: error || undefined };
  }
  try {
    const details = JSON.stringify(error, null, 2);
    return { message: fallback, details };
  } catch {
    return { message: fallback };
  }
}

export const TextGenerationNode = memo(({
  id,
  data,
  selected,
  width,
  height,
}: TextGenerationNodeProps) => {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const workflowNodes = useCanvasStore(selectWorkflowNodes);
  const edges = useCanvasStore((state) => state.edges);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const reorderNodeInput = useCanvasStore((state) => state.reorderNodeInput);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeDataCoalesced = useCanvasStore((state) => state.updateNodeDataCoalesced);
  const textApis = useSettingsStore((state) => state.textApis);
  const textPolishConfig = useSettingsStore((state) => state.textPolishConfig);
  const setLastTextGenerationModelSelection = useSettingsStore(
    (state) => state.setLastTextGenerationModelSelection
  );
  const controllerRef = useRef(new TextGenerationRunController<RunSnapshot>());
  const resultTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inputReferencePromptRef = useRef<ImageReferencePromptInputHandle | null>(null);
  const inputCompositionStateRef = useRef(createCompositionInputState(data.inputText ?? ''));
  const resultCompositionStateRef = useRef(createCompositionInputState(data.generatedText ?? ''));
  const [inputDraft, setInputDraft] = useState(inputCompositionStateRef.current.draft);
  const [resultDraft, setResultDraft] = useState(resultCompositionStateRef.current.draft);
  const [isRunning, setIsRunning] = useState(false);
  const [isPolishing, setIsPolishing] = useState(false);
  const [nodeError, setNodeError] = useState<NodeError | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [resultScrollResetVersion, setResultScrollResetVersion] = useState(0);

  const generatedText = typeof data.generatedText === 'string' && data.generatedText.trim()
    ? data.generatedText
    : null;
  const inputs = useMemo<ResolvedTextGenerationInputs>(
    () => resolveTextGenerationInputs(id, workflowNodes, edges),
    [edges, id, workflowNodes]
  );
  const selectedModel = useMemo(
    () => resolveTextModelSelection(textApis, data.textApiId, data.textModelId),
    [data.textApiId, data.textModelId, textApis]
  );
  const selectedPolishModel = useMemo(
    () => resolveTextModelSelection(
      textApis,
      textPolishConfig.textApiId ?? undefined,
      textPolishConfig.textModelId ?? undefined
    ),
    [textApis, textPolishConfig.textApiId, textPolishConfig.textModelId]
  );
  const hasTextContext = inputs.textInputs.length > 0;
  const hasImageContext = inputs.imageInputs.length > 0;
  const layout = resolveTextGenerationLayout({
    width,
    height,
    hasTextContext,
    hasImageContext,
    hasResult: Boolean(generatedText),
    isSizeManuallyAdjusted: data.isSizeManuallyAdjusted,
  });

  usePreserveNodeCenterOnAutoResize({
    nodeId: id,
    height: layout.height,
    enabled: !data.isSizeManuallyAdjusted,
  });
  const unavailableImageNames = inputs.imageInputs
    .flatMap((input, index) => !input.imageUrl
      ? [t('node.imageReference.label', { index: index + 1 })]
      : [])
    .join(', ');
  const canGenerate = canStartTextGeneration({
    effectivePrompt: inputs.effectivePrompt,
    referenceImageCount: inputs.referenceImages.length,
    blockingImageCount: inputs.blockingImageNodeIds.length,
    hasResolvedModel: Boolean(selectedModel),
  });

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, layout.height, layout.width, updateNodeInternals]);

  useLayoutEffect(() => {
    if (resultScrollResetVersion > 0 && resultTextareaRef.current) {
      resultTextareaRef.current.scrollTop = 0;
    }
  }, [resultScrollResetVersion]);

  useEffect(() => () => {
    controllerRef.current.stop();
  }, []);

  useEffect(() => {
    const externalInput = data.inputText ?? '';
    if (
      inputCompositionStateRef.current.isComposing ||
      externalInput === inputCompositionStateRef.current.committedValue
    ) {
      return;
    }
    const nextState = createCompositionInputState(externalInput);
    inputCompositionStateRef.current = nextState;
    setInputDraft(nextState.draft);
  }, [data.inputText]);

  useEffect(() => {
    const externalResult = data.generatedText ?? '';
    if (
      resultCompositionStateRef.current.isComposing ||
      externalResult === resultCompositionStateRef.current.committedValue
    ) {
      return;
    }
    const nextState = createCompositionInputState(externalResult);
    resultCompositionStateRef.current = nextState;
    setResultDraft(nextState.draft);
  }, [data.generatedText]);

  const locateNode = useCallback((nodeId: string) => {
    void locateReferencedNode(nodeId, {
      setSelectedNode,
      getInternalNode: reactFlow.getInternalNode,
      getViewport: reactFlow.getViewport,
      setCenter: reactFlow.setCenter,
    });
  }, [reactFlow, setSelectedNode]);

  const applyInputDraftTransition = useCallback((transition: ReturnType<typeof updateCompositionInputDraft>) => {
    inputCompositionStateRef.current = transition.state;
    setInputDraft(transition.state.draft);
    if (transition.committedValue !== null) {
      updateNodeDataCoalesced(
        id,
        { inputText: transition.committedValue },
        'text-generation-local-input'
      );
    }
  }, [id, updateNodeDataCoalesced]);

  const applyResultDraftTransition = useCallback((transition: ReturnType<typeof updateCompositionInputDraft>) => {
    resultCompositionStateRef.current = transition.state;
    setResultDraft(transition.state.draft);
    if (transition.committedValue !== null) {
      updateNodeDataCoalesced(
        id,
        { generatedText: transition.committedValue.trim() ? transition.committedValue : null },
        'text-generation-result'
      );
    }
  }, [id, updateNodeDataCoalesced]);

  const beginInputComposition = useCallback(() => {
    inputCompositionStateRef.current = beginCompositionInput(inputCompositionStateRef.current);
  }, []);

  const beginResultComposition = useCallback(() => {
    resultCompositionStateRef.current = beginCompositionInput(resultCompositionStateRef.current);
  }, []);

  const handleInputChange = useCallback((value: string, nativeIsComposing: boolean) => {
    applyInputDraftTransition(updateCompositionInputDraft(
      inputCompositionStateRef.current,
      value,
      nativeIsComposing
    ));
  }, [applyInputDraftTransition]);

  const handleResultChange = useCallback((value: string, nativeIsComposing: boolean) => {
    applyResultDraftTransition(updateCompositionInputDraft(
      resultCompositionStateRef.current,
      value,
      nativeIsComposing
    ));
  }, [applyResultDraftTransition]);

  const completeInputComposition = useCallback((value: string) => {
    applyInputDraftTransition(completeCompositionInput(inputCompositionStateRef.current, value));
  }, [applyInputDraftTransition]);

  const completeResultComposition = useCallback((value: string) => {
    applyResultDraftTransition(completeCompositionInput(resultCompositionStateRef.current, value));
  }, [applyResultDraftTransition]);

  const commitInputOnBlur = useCallback((value: string) => {
    applyInputDraftTransition(commitCompositionInputOnBlur(inputCompositionStateRef.current, value));
  }, [applyInputDraftTransition]);

  const commitResultOnBlur = useCallback((value: string) => {
    applyResultDraftTransition(commitCompositionInputOnBlur(resultCompositionStateRef.current, value));
  }, [applyResultDraftTransition]);

  const polishInput = useCallback(async () => {
    if (inputCompositionStateRef.current.isComposing || isRunning) {
      return;
    }
    if (!selectedPolishModel) {
      void showErrorDialog(
        t('node.textGeneration.polishModelRequired'),
        t('settings.promptPolish')
      );
      return;
    }
    const prompt = materializeImageReferencePrompt(
      inputCompositionStateRef.current.draft,
      inputs.imageInputs
    ).trim();
    if (!prompt) {
      void showErrorDialog(
        t('node.textGeneration.polishInputRequired'),
        t('node.textGeneration.polishPrompt')
      );
      return;
    }

    setIsPolishing(true);
    try {
      const result = await polishText({
        text: prompt,
        customPrompt: textPolishConfig.prompt,
        promptType: 'text',
        reasoningEffort: textPolishConfig.reasoningEffort ?? undefined,
      }, selectedPolishModel.apiConfig);
      if (inputCompositionStateRef.current.isComposing) {
        return;
      }
      const nextState = createCompositionInputState(result.polished);
      inputCompositionStateRef.current = nextState;
      setInputDraft(nextState.draft);
      updateNodeData(id, { inputText: result.polished });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('common.error');
      void showErrorDialog(message, t('node.textGeneration.polishPrompt'));
    } finally {
      setIsPolishing(false);
    }
  }, [id, inputs.imageInputs, isRunning, selectedPolishModel, t, textPolishConfig, updateNodeData]);

  const stopRun = useCallback(() => {
    if (controllerRef.current.stop()) {
      setIsRunning(false);
      setNodeError(null);
    }
  }, []);

  const startRun = useCallback(async () => {
    if (controllerRef.current.isRunning()) {
      return;
    }
    if (inputs.blockingImageNodeIds.length > 0) {
      setNodeError({
        message: unavailableImageNames
          ? t('node.textGeneration.imageUnavailableSources', { names: unavailableImageNames })
          : t('node.textGeneration.imageUnavailable'),
      });
      return;
    }
    if (!inputs.effectivePrompt && inputs.referenceImages.length === 0) {
      setNodeError({ message: t('node.textGeneration.inputRequired') });
      return;
    }
    if (!selectedModel) {
      setNodeError({ message: t('node.textModel.required') });
      return;
    }

    const snapshot: RunSnapshot = {
      prompt: inputs.effectivePrompt,
      referenceImages: [...inputs.referenceImages],
      reasoningEffort: data.textReasoningEffort,
      apiConfig: { ...selectedModel.apiConfig, modelId: selectedModel.modelId },
    };
    setNodeError(null);
    setIsRunning(true);
    const outcome = await controllerRef.current.run(snapshot, async (captured) =>
      await textGenerationGateway.generate({
        text: captured.prompt,
        referenceImages: captured.referenceImages,
        reasoningEffort: captured.reasoningEffort,
      }, captured.apiConfig)
    );

    setIsRunning(controllerRef.current.isRunning());
    if (outcome.status === 'committed') {
      updateNodeData(id, { generatedText: outcome.text });
      setResultScrollResetVersion((version) => version + 1);
    } else if (outcome.status === 'empty') {
      setNodeError({ message: t('node.textGeneration.emptyResponse') });
    } else if (outcome.status === 'failed') {
      setNodeError(normalizeError(outcome.error, t('node.textGeneration.generationFailed')));
    }
  }, [
    data.textReasoningEffort,
    id,
    inputs,
    selectedModel,
    t,
    unavailableImageNames,
    updateNodeData,
  ]);

  const handleGenerateShortcut = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (shouldSuppressKeyboardCommand(event.nativeEvent)) {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !isRunning) {
      event.preventDefault();
      void startRun();
    }
  }, [isRunning, startRun]);

  return (
    <div
      className={`group relative flex h-full w-full flex-col gap-2 overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/95 p-2 transition-colors duration-150 ${resolveNodeSurfaceStateClass(selected)}`}
      style={{ width: layout.width, height: layout.height }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeResizeHandle
        minWidth={layout.minWidth}
        minHeight={layout.minHeight}
        maxWidth={TEXT_GENERATION_MAX_WIDTH}
        maxHeight={TEXT_GENERATION_MAX_HEIGHT}
      />

      <TextGenerationUpstreamContext
        textInputs={inputs.textInputs}
        imageInputs={inputs.imageInputs}
        textContextHeight={layout.upstreamTextHeight}
        referenceImagesHeight={layout.referenceImagesHeight}
        onLocate={locateNode}
        onDisconnect={deleteEdge}
        onInsertReference={(edgeId) => inputReferencePromptRef.current?.insertReference(edgeId)}
        onReorder={(kind, draggedSourceId, targetSourceId) => {
          reorderNodeInput(id, kind, draggedSourceId, targetSourceId);
        }}
      />

      <section className="min-w-0 shrink-0">
        <div className="mb-1 text-[10px] font-medium text-text-muted">
          {t('node.textGeneration.localInput')}
        </div>
        <div
          className="nodrag nowheel relative overflow-visible rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]"
          style={{ height: layout.promptHeight }}
        >
          <ImageReferencePromptInput
            ref={inputReferencePromptRef}
            value={inputDraft}
            placeholder={t('node.textGeneration.inputPlaceholder')}
            ariaLabel={t('node.textGeneration.localInput')}
            imageInputs={inputs.imageInputs}
            onKeyDown={handleGenerateShortcut}
            onCompositionStart={beginInputComposition}
            onCompositionEnd={completeInputComposition}
            onBlur={commitInputOnBlur}
            onValueChange={handleInputChange}
            className={isRunning ? 'pr-20' : ''}
          />
          {isRunning && (
            <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-[var(--ui-border-soft)] bg-[var(--ui-surface-elevated)]/95 px-1.5 py-0.5 text-[10px] text-text-muted shadow-sm">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              {t('node.textGeneration.generating')}
            </div>
          )}
        </div>
      </section>

      {generatedText && (
        <section className="min-w-0 shrink-0">
          <div className="mb-1 text-[10px] font-medium text-text-muted">
            {t('node.textGeneration.generatedResult')}
          </div>
          <div
            className="nodrag nowheel relative overflow-hidden rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]/70"
            style={{ height: layout.resultHeight }}
          >
            <button
              type="button"
              disabled={isRunning}
              aria-label={t('node.textGeneration.clearResult')}
              title={t('node.textGeneration.clearResult')}
              onClick={() => updateNodeData(id, { generatedText: null })}
              className="nodrag nowheel absolute right-2 top-1.5 z-10 rounded p-1 text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <textarea
              ref={resultTextareaRef}
              value={resultDraft}
              readOnly={isRunning}
              onKeyDown={handleGenerateShortcut}
              onCompositionStart={beginResultComposition}
              onCompositionEnd={(event) => completeResultComposition(event.currentTarget.value)}
              onBlur={(event) => commitResultOnBlur(event.currentTarget.value)}
              onChange={(event) => handleResultChange(
                event.target.value,
                (event.nativeEvent as InputEvent).isComposing === true
              )}
              className="ui-scrollbar nodrag nowheel h-full w-full resize-none overflow-y-auto border-0 bg-transparent px-3 py-2 pr-8 text-sm leading-6 text-text-dark outline-none read-only:cursor-default"
            />
          </div>
        </section>
      )}

      <footer className={`${NODE_CONTROL_FOOTER_CLASS} justify-between gap-2`}>
        <TextModelSelector
          textApis={textApis}
          textApiId={data.textApiId}
          textModelId={data.textModelId}
          reasoningEffort={data.textReasoningEffort}
          onChange={({ textApiId, textModelId }) => {
            updateNodeData(id, { textApiId, textModelId });
            setLastTextGenerationModelSelection({ apiId: textApiId, modelId: textModelId });
          }}
          onReasoningEffortChange={(textReasoningEffort) =>
            updateNodeData(id, { textReasoningEffort })
          }
        />
        <UiTooltip content={t('node.textGeneration.polishPrompt')}>
          <UiButton
            type="button"
            aria-label={t('node.textGeneration.polishPrompt')}
            onClick={() => void polishInput()}
            variant="muted"
            size="sm"
            className={`nodrag nowheel shrink-0 ${NODE_CONTROL_ICON_BUTTON_CLASS}`}
            disabled={isPolishing || isRunning}
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
          type="button"
          variant={isRunning ? 'muted' : 'primary'}
          size="sm"
          className={`nodrag nowheel shrink-0 ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
          disabled={isPolishing || (!isRunning && !canGenerate)}
          onClick={() => isRunning ? stopRun() : void startRun()}
        >
          {isRunning ? <Square className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
          {isRunning ? t('node.textGeneration.stop') : t('node.textGeneration.generate')}
        </UiButton>
      </footer>

      {nodeError && !isRunning && (
        <button
          type="button"
          onClick={() => setShowErrorDetails(true)}
          className="nodrag nowheel absolute right-2 top-2 z-20 flex max-w-[65%] items-center gap-1 rounded-md border border-red-400/40 bg-red-950/85 px-2 py-1 text-left text-[10px] text-red-200 shadow-sm"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span className="truncate">{nodeError.message}</span>
        </button>
      )}

      <Handle type="target" id="target" position={Position.Left} />
      <Handle type="source" id="source" position={Position.Right} />

      {typeof document !== 'undefined' && createPortal(
        <UiModal
          isOpen={showErrorDetails}
          title={t('node.textGeneration.errorDetails')}
          closeLabel={t('common.close')}
          onClose={() => setShowErrorDetails(false)}
          footer={(
            <UiButton size="sm" onClick={() => setShowErrorDetails(false)}>
              {t('common.close')}
            </UiButton>
          )}
        >
          <div className="space-y-2 text-sm text-text-dark">
            <p>{nodeError?.message}</p>
            {nodeError?.details && (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--ui-surface-field)] p-3 text-xs text-text-muted">
                {nodeError.details}
              </pre>
            )}
          </div>
        </UiModal>,
        document.body
      )}
    </div>
  );
});

TextGenerationNode.displayName = 'TextGenerationNode';
