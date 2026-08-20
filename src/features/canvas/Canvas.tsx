import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import {
  ReactFlow,
  SelectionMode,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type HandleType,
  type NodeChange,
  type OnConnectStartParams,
  type Viewport,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import '@xyflow/react/dist/style.css';

import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { canvasAiGateway, canvasEventBus } from '@/features/canvas/application/canvasServices';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeType,
  DEFAULT_NODE_WIDTH,
} from '@/features/canvas/domain/canvasNodes';
import {
  createNodeImagePreview,
  prepareNodeImageFromFile,
} from '@/features/canvas/application/imageData';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
} from '@/features/canvas/application/generationErrorReport';
import {
  resolveGenerationPollDelay,
  resolveImageGenerationRecoveryState,
} from '@/features/canvas/application/generationJobRecovery';
import { resolveVideoApiConfig } from '@/features/canvas/application/videoApiSelection';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { shouldSuppressKeyboardCommand } from '@/features/canvas/application/compositionInputState';
import { snapNodePositionChanges } from '@/features/canvas/application/nodePositionAlignment';
import {
  selectSelectedNodeIds,
  selectWorkflowNodes,
} from '@/features/canvas/application/canvasNodeSelectors';
import { resolveImageProviderRuntime } from '@/features/canvas/application/imageProviderRuntime';
import {
  CANVAS_IMAGE_QUALITY_SETTLE_DELAY_MS,
  findCanvasImageFocusCandidate,
  getVisibleCanvasImageNodeIds,
  getRequestedCanvasOriginalNodeIds,
} from '@/features/canvas/application/canvasImageRenderPolicy';
import { useCanvasImageQualityStore } from '@/features/canvas/application/canvasImageQualityStore';
import {
  buildBatchConnectionPlan,
  canNodeBeManualConnectionSource,
  canNodeTypeBeManualConnectionSource,
  getDefaultCanvasTargetHandle,
  getBatchConnectMenuNodeTypes,
  isCanvasConnectionValid,
} from '@/features/canvas/application/canvasConnection';
import { sortCanvasEdgesForDuplication } from '@/features/canvas/application/canvasDuplication';
import {
  getNodeSourceDataTypes,
  getNodeTargetDataTypes,
  getConnectMenuNodeTypes,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { convertAudioToMp3, convertVideoToMp4 } from '@/commands/media';
import {
  createCanvasMediaImportDialogFilters,
  getCanvasMediaFileName,
  layoutCanvasMediaImportNodes,
  prepareCanvasMediaImportBatch,
} from '@/features/canvas/application/canvasMediaImport';
import { embedStoryboardImageMetadata, autoSaveVideoToProject, autoSaveImageToProject } from '@/commands/image';
import { shouldSuppressPaneClickAfterProjectOpen } from '@/features/app/projectOpenPaneClickGuard';
import { nodeTypes } from './nodes';
import { edgeTypes } from './edges';
import { NodeSelectionMenu } from './NodeSelectionMenu';
import { SelectedNodeOverlay } from './ui/SelectedNodeOverlay';
import { CanvasToolbar, type CanvasInteractionMode } from './CanvasToolbar';
import { CanvasMinimapControl } from './CanvasMinimapControl';
import { MultiSelectionConnector } from './ui/MultiSelectionConnector';
import { CanvasGridBackground } from './ui/CanvasGridBackground';
import { NodeToolDialog } from './ui/NodeToolDialog';
import { ImageViewerModal } from './ui/ImageViewerModal';
import { NodeContextMenu } from './ui/NodeContextMenu';
import { resolveCanvasConnectionRadius } from './application/connectionSnap';
import { useCanvasImagePreviewBackfill } from './hooks/useCanvasImagePreviewBackfill';
import { logger } from '@/lib/logger';
import { useExternalAgentBridge } from '@/features/canvas-agent/hooks/useExternalAgentBridge';

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const DEFAULT_EDGE_OPTIONS = { type: 'disconnectableEdge' };
const CONNECTION_LINE_STYLE: CSSProperties = {
  stroke: 'var(--accent)',
  strokeWidth: 2.5,
  strokeDasharray: '10 7',
  strokeLinecap: 'round',
};
const MULTI_SELECTION_KEY_CODES = ['Shift', 'Control', 'Meta'];
const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true };
const ZOOM_FOCUS_INTENT_MAX_AGE_MS = 500;

interface PendingConnectStart {
  nodeId: string;
  handleType: HandleType;
  handleId?: string;
  start?: {
    x: number;
    y: number;
  };
}

interface PreviewConnectionVisual {
  d: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'butt' | 'round' | 'square';
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CanvasImageFocusIntent {
  preferredNodeId?: string | null;
  focusPoint?: { x: number; y: number } | null;
}

interface ClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface NodeContextMenuState {
  id: number;
  position: { x: number; y: number };
  nodeIds: string[];
}

interface DuplicateOptions {
  explicitOffset?: { x: number; y: number };
  disableOffsetIteration?: boolean;
  suppressSelect?: boolean;
  suppressPersist?: boolean;
}

interface DuplicateResult {
  firstNodeId: string | null;
  idMap: Map<string, string>;
}

const ALT_DRAG_COPY_Z_INDEX = 2000;
const GENERATION_JOB_POLL_INTERVAL_MS = 1400;
const NODE_CONTEXT_MENU_WIDTH = 256;
const NODE_CONTEXT_MENU_HEIGHT = 216;
const NODE_CONTEXT_MENU_INSET = 8;

interface GenerationStoryboardMetadata {
  gridRows: number;
  gridCols: number;
  frameNotes: string[];
}

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  return {
    width: node.measured?.width ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? styleHeight ?? 200,
  };
}

function hasRectCollision(
  candidateRect: { x: number; y: number; width: number; height: number },
  nodes: CanvasNode[],
  ignoreNodeIds: Set<string>
): boolean {
  const margin = 18;
  return nodes.some((node) => {
    if (ignoreNodeIds.has(node.id)) {
      return false;
    }
    const size = getNodeSize(node);
    return (
      candidateRect.x < node.position.x + size.width + margin &&
      candidateRect.x + candidateRect.width + margin > node.position.x &&
      candidateRect.y < node.position.y + size.height + margin &&
      candidateRect.y + candidateRect.height + margin > node.position.y
    );
  });
}

function cloneNodeData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || element.isContentEditable;
}

function resolveClipboardImageFile(event: ClipboardEvent): File | null {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) {
    return null;
  }

  for (const item of Array.from(clipboardItems)) {
    if (!item.type.startsWith('image/')) {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const existingName = typeof file.name === 'string' ? file.name.trim() : '';
    if (existingName) {
      return file;
    }

    const subtype = item.type.split('/')[1]?.split('+')[0] || 'png';
    return new File([file], `pasted-image.${subtype}`, {
      type: file.type || item.type,
      lastModified: Date.now(),
    });
  }

  return null;
}

function resolveAllowedNodeTypes(handleType: HandleType, fixedNodeType?: CanvasNodeType): CanvasNodeType[] {
  const filterCompatibleTypes = (candidateTypes: CanvasNodeType[]): CanvasNodeType[] => {
    if (!fixedNodeType) {
      return candidateTypes;
    }
    const fixedTypes = handleType === 'source'
      ? getNodeSourceDataTypes(fixedNodeType)
      : getNodeTargetDataTypes(fixedNodeType);
    return candidateTypes.filter((candidateType) => {
      const candidateTypesForDirection = handleType === 'source'
        ? getNodeTargetDataTypes(candidateType)
        : getNodeSourceDataTypes(candidateType);
      return fixedTypes.some((valueType) => candidateTypesForDirection.includes(valueType));
    });
  };

  return filterCompatibleTypes(getConnectMenuNodeTypes(handleType));
}

function getClientPosition(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event && 'clientY' in event) {
    return { x: event.clientX, y: event.clientY };
  }

  const touch = 'changedTouches' in event
    ? event.changedTouches[0] ?? event.touches[0]
    : null;
  if (!touch) {
    return null;
  }

  return { x: touch.clientX, y: touch.clientY };
}

function createPreviewPath(line: PreviewConnectionLine): string {
  const { start, end, handleType } = line;
  const deltaX = end.x - start.x;
  const curveStrength = Math.max(36, Math.min(120, Math.abs(deltaX) * 0.4));
  const handleDirection = handleType === 'source' ? 1 : -1;
  const isReverseDrag = deltaX * handleDirection < 0;
  const effectiveDirection = isReverseDrag ? -handleDirection : handleDirection;
  const startControlX = start.x + effectiveDirection * curveStrength;
  const endControlX = end.x - effectiveDirection * curveStrength;

  return `M ${start.x} ${start.y} C ${startControlX} ${start.y}, ${endControlX} ${end.y}, ${end.x} ${end.y}`;
}

interface PreviewConnectionLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
  handleType: HandleType;
}

export function Canvas() {
  const { t } = useTranslation();
  const reactFlowInstance = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const suppressNextPaneClickRef = useRef(false);
  const suppressNextEdgeClickRef = useRef(false);

  const [showNodeMenu, setShowNodeMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [flowPosition, setFlowPosition] = useState({ x: 0, y: 0 });
  const [menuAllowedTypes, setMenuAllowedTypes] = useState<CanvasNodeType[] | undefined>(
    undefined
  );
  const [pendingConnectStart, setPendingConnectStart] = useState<PendingConnectStart | null>(
    null
  );
  const [pendingMultiConnectSourceNodeIds, setPendingMultiConnectSourceNodeIds] = useState<
    string[] | null
  >(null);
  const [previewConnectionVisual, setPreviewConnectionVisual] =
    useState<PreviewConnectionVisual | null>(null);
  const [interactionMode, setInteractionMode] = useState<CanvasInteractionMode>('pan');
  const [isSpacePanActive, setIsSpacePanActive] = useState(false);
  const [hasCopiedNodes, setHasCopiedNodes] = useState(false);
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null);

  const isRestoringCanvasRef = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedSnapshotRef = useRef<ClipboardSnapshot | null>(null);
  const pasteIterationRef = useRef(0);
  const pasteImageHandledRef = useRef(false);
  const nodeContextMenuSequenceRef = useRef(0);
  const imageQualitySettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestZoomFocusPointRef = useRef<{
    point: { x: number; y: number };
    timestamp: number;
  } | null>(null);
  const activeGenerationPollNodeIdsRef = useRef(new Set<string>());
  const duplicateNodesRef = useRef<((sourceNodeIds: string[]) => string | null) | null>(null);
  const altDragCopyRef = useRef<{
    sourceNodeIds: string[];
    startPositions: Map<string, { x: number; y: number }>;
    copiedNodeIds: string[];
    sourceToCopyIdMap: Map<string, string>;
  } | null>(null);
  const edgePanGestureRef = useRef<{
    active: boolean;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startViewportX: number;
    startViewportY: number;
    zoom: number;
    moved: boolean;
  } | null>(null);

  const nodes = useCanvasStore((state) => state.nodes);
  const workflowNodes = useCanvasStore(selectWorkflowNodes);
  const selectedNodeIds = useCanvasStore(selectSelectedNodeIds);
  const edges = useCanvasStore((state) => state.edges);
  const history = useCanvasStore((state) => state.history);
  const dragHistorySnapshot = useCanvasStore((state) => state.dragHistorySnapshot);
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const applyEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const connectNodes = useCanvasStore((state) => state.onConnect);
  const connectNodesBatch = useCanvasStore((state) => state.onConnectBatch);
  const setCanvasData = useCanvasStore((state) => state.setCanvasData);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeDataWithoutHistory = useCanvasStore(
    (state) => state.updateNodeDataWithoutHistory
  );
  const addNode = useCanvasStore((state) => state.addNode);
  const addNodeBatch = useCanvasStore((state) => state.addNodeBatch);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const deleteNodes = useCanvasStore((state) => state.deleteNodes);
  const groupNodes = useCanvasStore((state) => state.groupNodes);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);
  const closeToolDialog = useCanvasStore((state) => state.closeToolDialog);
  const setViewportState = useCanvasStore((state) => state.setViewportState);
  const setCanvasViewportSize = useCanvasStore((state) => state.setCanvasViewportSize);
  const currentViewport = useCanvasStore((state) => state.currentViewport);
  const imageViewer = useCanvasStore((state) => state.imageViewer);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);
  const navigateImageViewer = useCanvasStore((state) => state.navigateImageViewer);
  const openAiImageApi = useSettingsStore((state) => state.openAiImageApi);
  const chaomoImageApi = useSettingsStore((state) => state.chaomoImageApi);
  const customImageApis = useSettingsStore((state) => state.customImageApis);
  const useUploadFilenameAsNodeTitle = useSettingsStore((state) => state.useUploadFilenameAsNodeTitle);
  const videoApis = useSettingsStore((state) => state.videoApis);
  const snapToGridEnabled = useSettingsStore((state) => state.snapToGridEnabled);
  const snapGridSize = useSettingsStore((state) => state.snapGridSize);
  const snapGrid = useMemo<[number, number] | undefined>(
    () => snapToGridEnabled ? [snapGridSize, snapGridSize] : undefined,
    [snapGridSize, snapToGridEnabled]
  );

  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const currentProjectName = useProjectStore((state) => state.currentProject?.name ?? '');
  const saveCurrentProject = useProjectStore((state) => state.saveCurrentProject);
  const saveCurrentProjectViewport = useProjectStore((state) => state.saveCurrentProjectViewport);
  const cancelPendingViewportPersist = useProjectStore(
    (state) => state.cancelPendingViewportPersist
  );
  const isCanvasImageInteractionActive = useCanvasImageQualityStore(
    (state) => state.isInteractionActive
  );
  const setCanvasImageInteractionActive = useCanvasImageQualityStore(
    (state) => state.setInteractionActive
  );
  const setCanvasImageFocusedNodeId = useCanvasImageQualityStore(
    (state) => state.setFocusedNodeId
  );
  const setCanvasOriginalImageMode = useCanvasImageQualityStore(
    (state) => state.setOriginalImageMode
  );
  const retainVisibleCanvasImageOriginals = useCanvasImageQualityStore(
    (state) => state.retainVisibleOriginalNodes
  );
  const clearRetainedCanvasImageOriginals = useCanvasImageQualityStore(
    (state) => state.clearRetainedOriginalNodes
  );
  const setRequestedCanvasImageOriginals = useCanvasImageQualityStore(
    (state) => state.setRequestedOriginalNodes
  );
  useExternalAgentBridge({
    projectId: currentProjectId ?? '',
    projectName: currentProjectName,
    nodes,
    edges,
    selectedNodeIds,
    viewport: currentViewport,
  });

  useCanvasImagePreviewBackfill({
    projectId: currentProjectId,
    workflowNodes,
    isInteractionActive: isCanvasImageInteractionActive,
    updateNodeDataWithoutHistory,
  });

  const persistCanvasSnapshot = useCallback(() => {
    if (isRestoringCanvasRef.current) {
      return;
    }

    const currentProject = getCurrentProject();
    if (!currentProject) {
      return;
    }

    const currentNodes = useCanvasStore.getState().nodes;
    const currentEdges = useCanvasStore.getState().edges;
    const currentHistory = useCanvasStore.getState().history;
    saveCurrentProject(
      currentNodes,
      currentEdges,
      reactFlowInstance.getViewport(),
      currentHistory
    );
  }, [getCurrentProject, reactFlowInstance, saveCurrentProject]);

  const scheduleCanvasPersist = useCallback(
    (delayMs = 140) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        persistCanvasSnapshot();
      }, delayMs);
    },
    [persistCanvasSnapshot]
  );

  const scheduleCanvasImageFocus = useCallback((
    viewport?: Viewport,
    intent: CanvasImageFocusIntent = {}
  ) => {
    if (imageQualitySettleTimerRef.current) {
      window.clearTimeout(imageQualitySettleTimerRef.current);
    }

    imageQualitySettleTimerRef.current = window.setTimeout(() => {
      imageQualitySettleTimerRef.current = null;
      if (useCanvasImageQualityStore.getState().isInteractionActive) {
        return;
      }

      const container = wrapperRef.current;
      if (!container) {
        setCanvasImageFocusedNodeId(null);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const resolvedViewport = viewport ?? reactFlowInstance.getViewport();
      const viewportSize = {
        width: containerRect.width,
        height: containerRect.height,
      };
      const currentNodes = useCanvasStore.getState().nodes;
      const wasOriginalImageMode = useCanvasImageQualityStore.getState().isOriginalImageMode;
      const requestedOriginalNodeIds = getRequestedCanvasOriginalNodeIds({
        nodes: currentNodes,
        viewport: resolvedViewport,
        viewportSize,
        isOriginalImageMode: true,
        focusPoint: intent.focusPoint,
        devicePixelRatio: window.devicePixelRatio,
      });
      const isOriginalImageMode = requestedOriginalNodeIds.length > 0;
      setCanvasOriginalImageMode(isOriginalImageMode);
      if (wasOriginalImageMode && !isOriginalImageMode) {
        clearRetainedCanvasImageOriginals();
      }
      retainVisibleCanvasImageOriginals(getVisibleCanvasImageNodeIds({
        nodes: currentNodes,
        viewport: resolvedViewport,
        viewportSize,
      }));
      setRequestedCanvasImageOriginals(requestedOriginalNodeIds);
      const focusedNodeId = isOriginalImageMode ? findCanvasImageFocusCandidate({
        nodes: currentNodes,
        viewport: resolvedViewport,
        viewportSize,
        preferredNodeId: intent.preferredNodeId,
        focusPoint: intent.focusPoint,
        devicePixelRatio: window.devicePixelRatio,
      }) : null;
      setCanvasImageFocusedNodeId(focusedNodeId);
    }, CANVAS_IMAGE_QUALITY_SETTLE_DELAY_MS);
  }, [
    reactFlowInstance,
    clearRetainedCanvasImageOriginals,
    retainVisibleCanvasImageOriginals,
    setCanvasOriginalImageMode,
    setRequestedCanvasImageOriginals,
    setCanvasImageFocusedNodeId,
  ]);

  useEffect(() => {
    if (imageQualitySettleTimerRef.current) {
      window.clearTimeout(imageQualitySettleTimerRef.current);
      imageQualitySettleTimerRef.current = null;
    }
    setCanvasImageFocusedNodeId(null);
    setCanvasImageInteractionActive(false);
    clearRetainedCanvasImageOriginals();
  }, [
    clearRetainedCanvasImageOriginals,
    currentProjectId,
    setCanvasImageFocusedNodeId,
    setCanvasImageInteractionActive,
  ]);

  useEffect(() => {
    return () => {
      if (imageQualitySettleTimerRef.current) {
        window.clearTimeout(imageQualitySettleTimerRef.current);
      }
      setCanvasImageFocusedNodeId(null);
      setCanvasImageInteractionActive(false);
      clearRetainedCanvasImageOriginals();
    };
  }, [
    clearRetainedCanvasImageOriginals,
    setCanvasImageFocusedNodeId,
    setCanvasImageInteractionActive,
  ]);

  useEffect(() => {
    const unsubscribeOpen = canvasEventBus.subscribe('tool-dialog/open', (payload) => {
      openToolDialog(payload);
    });
    const unsubscribeClose = canvasEventBus.subscribe('tool-dialog/close', () => {
      closeToolDialog();
    });

    return () => {
      unsubscribeOpen();
      unsubscribeClose();
    };
  }, [openToolDialog, closeToolDialog]);

  useEffect(() => {
    isRestoringCanvasRef.current = true;
    const project = getCurrentProject();
    if (project) {
      setCanvasData(project.nodes, project.edges, project.history);
      setViewportState(project.viewport ?? DEFAULT_VIEWPORT);
      requestAnimationFrame(() => {
        reactFlowInstance.setViewport(project.viewport ?? DEFAULT_VIEWPORT, { duration: 0 });
      });
    } else {
      setViewportState(DEFAULT_VIEWPORT);
    }
    const restoreTimer = setTimeout(() => {
      isRestoringCanvasRef.current = false;
    }, 0);

    return () => {
      clearTimeout(restoreTimer);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      closeImageViewer();
      persistCanvasSnapshot();
    };
  }, [
    closeImageViewer,
    getCurrentProject,
    persistCanvasSnapshot,
    reactFlowInstance,
    setCanvasData,
    setViewportState,
  ]);

  useEffect(() => {
    if (isRestoringCanvasRef.current || dragHistorySnapshot) {
      return;
    }

    scheduleCanvasPersist();
  }, [nodes, edges, history, dragHistorySnapshot, scheduleCanvasPersist]);

  useEffect(() => {
    scheduleCanvasImageFocus();

    return () => {
      if (imageQualitySettleTimerRef.current) {
        window.clearTimeout(imageQualitySettleTimerRef.current);
        imageQualitySettleTimerRef.current = null;
      }
    };
  }, [scheduleCanvasImageFocus, workflowNodes]);

  useEffect(() => {
    const sleep = (delayMs: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });

    const pendingExportNodes = nodes.filter((node) => {
      if (node.type !== CANVAS_NODE_TYPES.exportImage) {
        return false;
      }
      const data = node.data as Record<string, unknown>;
      return data.isGenerating === true && typeof data.generationJobId === 'string' && data.generationJobId.length > 0;
    });

    for (const pendingNode of pendingExportNodes) {
      if (activeGenerationPollNodeIdsRef.current.has(pendingNode.id)) {
        continue;
      }
      activeGenerationPollNodeIdsRef.current.add(pendingNode.id);

      void (async () => {
        try {
          const projectId = getCurrentProject()?.id;
          while (true) {
            const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
            if (!currentNode) {
              break;
            }

            const currentData = currentNode.data as Record<string, unknown>;
            const jobId = typeof currentData.generationJobId === 'string' ? currentData.generationJobId : '';
            const isGenerating = currentData.isGenerating === true;
            if (!jobId || !isGenerating) {
              break;
            }

            const generationProviderId = typeof currentData.generationProviderId === 'string'
              ? currentData.generationProviderId
              : '';
            const generationProviderName = typeof currentData.generationProviderName === 'string'
              ? currentData.generationProviderName
              : generationProviderId;
            const generationModelName = typeof currentData.generationModelName === 'string'
              ? currentData.generationModelName
              : typeof currentData.model === 'string'
                ? currentData.model
                : '';
            const providerRuntime = resolveImageProviderRuntime(generationProviderId, {
              openAiImageApi,
              chaomoImageApi,
              customImageApis,
            });
            if (providerRuntime.apiKey) {
                await canvasAiGateway.setApiKey(providerRuntime.backendProviderId, providerRuntime.apiKey).catch((error) => {
                  logger.warn('[GenerationJob] set_api_key failed before poll', {
                    nodeId: pendingNode.id,
                    generationProviderId,
                    error,
                  });
                });
            }

            const shouldRetryAfterManualIntervention = currentData.generationRecoveryState === 'retry_requested';
            const status = await (
              shouldRetryAfterManualIntervention
                ? canvasAiGateway.retryGenerateImageJob(jobId, providerRuntime.providerConfig)
                : canvasAiGateway.getGenerateImageJob(jobId, providerRuntime.providerConfig)
            ).catch((error) => {
              logger.warn('[GenerationJob] poll failed', {
                nodeId: pendingNode.id,
                jobId,
                manualRequery: shouldRetryAfterManualIntervention,
                error,
              });
              return null;
            });
            if (!status) {
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            if (status.status === 'queued' || status.status === 'running') {
              const recoveryState = resolveImageGenerationRecoveryState(status.recovery);
              const recoveryRetryCount = status.recovery?.retry_count ?? 0;
              const recoveryNextRetryAt = status.recovery?.next_retry_at ?? null;
              const recoveryError = status.recovery?.last_error ?? null;
              if (
                currentData.generationRecoveryState !== recoveryState
                || currentData.generationRetryCount !== recoveryRetryCount
                || currentData.generationNextRetryAt !== recoveryNextRetryAt
                || currentData.generationRetryError !== recoveryError
              ) {
                updateNodeDataWithoutHistory(pendingNode.id, {
                  generationRecoveryState: recoveryState,
                  generationRetryCount: recoveryRetryCount,
                  generationNextRetryAt: recoveryNextRetryAt,
                  generationRetryError: recoveryError,
                });
              }

              if (recoveryState === 'attention_required') {
                break;
              }

              await sleep(
                resolveGenerationPollDelay(
                  status.recovery,
                  Date.now(),
                  GENERATION_JOB_POLL_INTERVAL_MS
                )
              );
              continue;
            }

            if (status.status === 'succeeded' && typeof status.result === 'string' && status.result.trim()) {
              let localImagePath = status.result;
              if (projectId) {
                try {
                  localImagePath = await autoSaveImageToProject(
                    status.result,
                    projectId,
                    generationProviderName,
                    generationModelName
                  );
                  logger.info('[GenerationJob] Generated image auto-saved to project directory:', localImagePath);
                } catch (e) {
                  logger.warn('[GenerationJob] Failed to auto-save image to project directory, using URL:', e);
                }
              }
              const storyboardMetadataRaw = currentData.generationStoryboardMetadata as GenerationStoryboardMetadata | undefined;
              const hasStoryboardMetadata = Boolean(
                storyboardMetadataRaw
                && Number.isFinite(storyboardMetadataRaw.gridRows)
                && Number.isFinite(storyboardMetadataRaw.gridCols)
                && Array.isArray(storyboardMetadataRaw.frameNotes)
              );
              let imageWithMetadata = localImagePath;
              if (hasStoryboardMetadata && storyboardMetadataRaw) {
                imageWithMetadata = await embedStoryboardImageMetadata(localImagePath, {
                  gridRows: Math.max(1, Math.round(storyboardMetadataRaw.gridRows)),
                  gridCols: Math.max(1, Math.round(storyboardMetadataRaw.gridCols)),
                  frameNotes: storyboardMetadataRaw.frameNotes,
                }, projectId).catch((error) => {
                  logger.warn('[GenerationJob] embed storyboard metadata failed', {
                    nodeId: pendingNode.id,
                    error,
                  });
                  return localImagePath;
                });
              }

              const preview = await createNodeImagePreview(imageWithMetadata, 512, projectId)
                .catch((error) => {
                  logger.warn('[GenerationJob] Failed to create image preview, using original image', {
                    nodeId: pendingNode.id,
                    error,
                  });
                  return null;
                });

              updateNodeData(pendingNode.id, {
                imageUrl: imageWithMetadata,
                previewImageUrl: preview?.previewImageUrl ?? imageWithMetadata,
                aspectRatio: typeof currentData.aspectRatio === 'string'
                  && currentData.aspectRatio.trim().length > 0
                  ? currentData.aspectRatio
                  : DEFAULT_ASPECT_RATIO,
                isGenerating: false,
                generationStartedAt: null,
                generationJobId: null,
                generationProviderId: null,
                generationProviderName: null,
                generationModelName: null,
                generationClientSessionId: null,
                generationStoryboardMetadata: undefined,
                generationError: null,
                generationErrorDetails: null,
                generationDebugContext: undefined,
                generationRecoveryState: null,
                generationRetryCount: 0,
                generationNextRetryAt: null,
                generationRetryError: null,
              });
              break;
            }

            const errorMessage = status.error ?? (status.status === 'not_found' ? 'generation job not found' : 'generation failed');
            const generationClientSessionId = typeof currentData.generationClientSessionId === 'string'
              ? currentData.generationClientSessionId
              : '';
            const shouldShowDialog = generationClientSessionId === CURRENT_RUNTIME_SESSION_ID;
            if (shouldShowDialog) {
              const reportText = buildGenerationErrorReport({
                errorMessage,
                errorDetails: status.error ?? undefined,
                context: currentData.generationDebugContext,
              });
              void showErrorDialog(errorMessage, t('common.error'), status.error ?? undefined, reportText);
            }
            updateNodeData(pendingNode.id, {
              isGenerating: false,
              generationStartedAt: null,
              generationJobId: null,
              generationProviderId: null,
              generationProviderName: null,
              generationModelName: null,
              generationClientSessionId: null,
              generationStoryboardMetadata: undefined,
              generationError: errorMessage,
              generationErrorDetails: status.error ?? null,
              generationRecoveryState: null,
              generationRetryCount: 0,
              generationNextRetryAt: null,
              generationRetryError: null,
            });
            break;
          }
        } finally {
          activeGenerationPollNodeIdsRef.current.delete(pendingNode.id);
        }
      })();
    }
  }, [
    chaomoImageApi,
    customImageApis,
    nodes,
    openAiImageApi,
    updateNodeData,
    updateNodeDataWithoutHistory,
  ]);

  // Polling for export video nodes
  useEffect(() => {
    const sleep = (delayMs: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });

    const pendingVideoNodes = nodes.filter((node) => {
      if (node.type !== CANVAS_NODE_TYPES.exportVideo) {
        return false;
      }
      const data = node.data as Record<string, unknown>;
      return data.isGenerating === true && typeof data.generationJobId === 'string' && data.generationJobId.length > 0;
    });

    for (const pendingNode of pendingVideoNodes) {
      if (activeGenerationPollNodeIdsRef.current.has(pendingNode.id)) {
        continue;
      }
      activeGenerationPollNodeIdsRef.current.add(pendingNode.id);

      void (async () => {
        try {
          let pollFailureCount = 0;
          const MAX_POLL_FAILURES = 5;
          while (true) {
            const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
            if (!currentNode) {
              break;
            }

            const currentData = currentNode.data as Record<string, unknown>;
            const jobId = typeof currentData.generationJobId === 'string' ? currentData.generationJobId : '';
            const isGenerating = currentData.isGenerating === true;
            if (!jobId || !isGenerating) {
              break;
            }

            const generationProviderId = typeof currentData.generationProviderId === 'string'
              ? currentData.generationProviderId
              : '';
            const videoApiId = typeof currentData.videoApiId === 'string'
              ? currentData.videoApiId
              : '';
            const configuredVideoApi = generationProviderId === 'volcvideo'
              ? resolveVideoApiConfig(
                videoApis,
                videoApiId,
                typeof currentData.model === 'string' ? currentData.model : undefined
              )
              : undefined;
            const videoProviderConfig = configuredVideoApi?.apiKey && configuredVideoApi.baseUrl
              ? {
                api_key: configuredVideoApi.apiKey.trim(),
                base_url: configuredVideoApi.baseUrl.trim(),
                config_id: configuredVideoApi.id,
                protocol: configuredVideoApi.protocol ?? 'volcengine-seedance',
              }
              : undefined;

            const shouldRetryAfterManualIntervention = currentData.generationRecoveryState === 'retry_requested';
            const status = await (
              shouldRetryAfterManualIntervention
                ? canvasAiGateway.retryGenerateImageJob(jobId, videoProviderConfig)
                : canvasAiGateway.getGenerateImageJob(jobId, videoProviderConfig)
            ).catch((error) => {
              logger.warn('[VideoJob] poll failed', {
                nodeId: pendingNode.id,
                jobId,
                manualRequery: shouldRetryAfterManualIntervention,
                error,
              });
              return null;
            });
            if (!status) {
              pollFailureCount++;
              if (pollFailureCount >= MAX_POLL_FAILURES) {
                logger.error('[VideoJob] poll failed repeatedly, showing error on node', {
                  nodeId: pendingNode.id,
                  jobId,
                  failures: pollFailureCount,
                });
                updateNodeData(pendingNode.id, {
                  isGenerating: false,
                  generationStartedAt: null,
                  generationJobId: null,
                  generationProviderId: null,
                  generationError: '网络请求失败，请检查网络连接后重试',
                  generationRecoveryState: null,
                  generationRetryCount: 0,
                  generationNextRetryAt: null,
                  generationRetryError: null,
                });
                break;
              }
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            pollFailureCount = 0;

            if (status.status === 'queued' || status.status === 'running') {
              // Check if there's an error message even when status is running
              if (status.error) {
                logger.warn('[VideoJob] poll returned error:', { nodeId: pendingNode.id, jobId, error: status.error, status: status.status });
                updateNodeData(pendingNode.id, {
                  isGenerating: false,
                  generationStartedAt: null,
                  generationJobId: null,
                  generationProviderId: null,
                  generationError: status.error,
                  generationRecoveryState: null,
                  generationRetryCount: 0,
                  generationNextRetryAt: null,
                  generationRetryError: null,
                });
                break;
              }
              const recoveryState = resolveImageGenerationRecoveryState(status.recovery);
              const recoveryRetryCount = status.recovery?.retry_count ?? 0;
              const recoveryNextRetryAt = status.recovery?.next_retry_at ?? null;
              const recoveryError = status.recovery?.last_error ?? null;
              if (
                currentData.generationRecoveryState !== recoveryState
                || currentData.generationRetryCount !== recoveryRetryCount
                || currentData.generationNextRetryAt !== recoveryNextRetryAt
                || currentData.generationRetryError !== recoveryError
              ) {
                updateNodeDataWithoutHistory(pendingNode.id, {
                  generationRecoveryState: recoveryState,
                  generationRetryCount: recoveryRetryCount,
                  generationNextRetryAt: recoveryNextRetryAt,
                  generationRetryError: recoveryError,
                });
              }

              if (recoveryState === 'attention_required') {
                break;
              }

              await sleep(
                resolveGenerationPollDelay(
                  status.recovery,
                  Date.now(),
                  GENERATION_JOB_POLL_INTERVAL_MS
                )
              );
              continue;
            }

            // Handle cancelled status - task was successfully cancelled
            if (status.status === 'cancelled') {
              logger.info('[VideoJob] Task was cancelled:', { nodeId: pendingNode.id, jobId });
              // Keep the error message that was set when cancel was clicked, or use default
              const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
              const existingError = (currentNode?.data as Record<string, unknown>)?.generationError as string | undefined;
              updateNodeData(pendingNode.id, {
                isGenerating: false,
                generationStartedAt: null,
                generationJobId: null,
                generationProviderId: null,
                generationError: existingError || '已取消生成',
                generationRecoveryState: null,
                generationRetryCount: 0,
                generationNextRetryAt: null,
                generationRetryError: null,
              });
              break;
            }

            if (status.status === 'succeeded' && typeof status.result === 'string' && status.result.trim()) {
              // Auto-save video to project directory if project context is available
              const currentProject = getCurrentProject();
              const projectId = currentProject?.id;
              let localVideoPath = status.result;
              if (projectId) {
                try {
                  localVideoPath = await autoSaveVideoToProject(status.result, projectId);
                  logger.info('[VideoJob] Video auto-saved to project directory:', localVideoPath);
                } catch (e) {
                  logger.warn('[VideoJob] Failed to auto-save video to project directory, using URL:', e);
                }
              }
              // If seed is returned from API, use it to update the node
              const isDraft = currentData.draft === true;
              const updateData: Record<string, unknown> = {
                videoUrl: localVideoPath,
                isGenerating: false,
                generationStartedAt: null,
                generationJobId: null,
                generationProviderId: null,
                generationError: null,
                generationRecoveryState: null,
                generationRetryCount: 0,
                generationNextRetryAt: null,
                generationRetryError: null,
              };
              // If this was a draft video, preserve the external task ID (not internal jobId) for generating final video
              if (isDraft && status.external_task_id) {
                updateData.draftTaskId = status.external_task_id;
                logger.info('[VideoJob] Draft video completed, preserving externalTaskId:', status.external_task_id);
              }
              // If API returned a seed value, use it; otherwise keep existing seed
              if (status.seed !== undefined && status.seed !== null) {
                updateData.seed = status.seed;
                logger.info('[VideoJob] Received seed from API:', status.seed);
              }
              updateNodeData(pendingNode.id, updateData);
              break;
            }

            const errorMessage = status.error ?? (status.status === 'not_found' ? 'video generation job not found' : 'video generation failed');
            updateNodeData(pendingNode.id, {
              isGenerating: false,
              generationStartedAt: null,
              generationJobId: null,
              generationProviderId: null,
              generationError: errorMessage,
              generationRecoveryState: null,
              generationRetryCount: 0,
              generationNextRetryAt: null,
              generationRetryError: null,
            });
            break;
          }
        } finally {
          activeGenerationPollNodeIdsRef.current.delete(pendingNode.id);
        }
      })();
    }
  }, [nodes, updateNodeData, updateNodeDataWithoutHistory, videoApis]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setCanvasViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [setCanvasViewportSize]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const currentNodes = useCanvasStore.getState().nodes;
      applyNodesChange(snapNodePositionChanges(changes, currentNodes));

      const hasDragMove = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          Boolean(change.dragging)
      );
      const hasDragEnd = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          change.dragging === false
      );
      const hasResizeMove = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          Boolean(change.resizing)
      );
      const hasResizeEnd = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          change.resizing === false
      );
      const resizedNodeChange = changes.find(
        (change): change is Extract<NodeChange<CanvasNode>, { type: 'dimensions' }> => (
          change.type === 'dimensions'
          && 'resizing' in change
          && change.resizing === false
        )
      );
      const resizedNodeId = resizedNodeChange?.id;
      const hasInteractionMove = hasDragMove || hasResizeMove;
      const hasInteractionEnd = hasDragEnd || hasResizeEnd;

      if (hasInteractionMove) {
        setCanvasImageInteractionActive(true);
        return;
      }

      if (hasInteractionEnd) {
        setCanvasImageInteractionActive(false);
        scheduleCanvasImageFocus(
          undefined,
          resizedNodeId ? { preferredNodeId: resizedNodeId } : undefined
        );
        scheduleCanvasPersist(0);
        return;
      }

      scheduleCanvasPersist();
    },
    [
      applyNodesChange,
      scheduleCanvasImageFocus,
      scheduleCanvasPersist,
      setCanvasImageInteractionActive,
    ]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      applyEdgesChange(changes);
      scheduleCanvasPersist();
    },
    [applyEdgesChange, scheduleCanvasPersist]
  );

  const handleEdgeDoubleClick = useCallback(
    (event: ReactMouseEvent, edge: CanvasEdge) => {
      event.preventDefault();
      event.stopPropagation();
      deleteEdge(edge.id);
      scheduleCanvasPersist(0);
    },
    [deleteEdge, scheduleCanvasPersist]
  );

  const handleEdgeClick = useCallback((event: ReactMouseEvent) => {
    if (!suppressNextEdgeClickRef.current) {
      return;
    }
    suppressNextEdgeClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const isValidConnection = useCallback((connection: Connection | CanvasEdge) => {
    const state = useCanvasStore.getState();
    return isCanvasConnectionValid(connection, state.nodes, state.edges);
  }, []);

  const handleConnect = useCallback(
    (connection: Connection) => {
      // 先验证连接
      if (!isValidConnection(connection)) {
        return;
      }

      connectNodes(connection);
      scheduleCanvasPersist(0);
    },
    [connectNodes, isValidConnection, scheduleCanvasPersist]
  );

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      setViewportState(viewport);
      setCanvasImageInteractionActive(false);
      const latestZoomFocus = latestZoomFocusPointRef.current;
      latestZoomFocusPointRef.current = null;
      const focusPoint = latestZoomFocus
        && performance.now() - latestZoomFocus.timestamp <= ZOOM_FOCUS_INTENT_MAX_AGE_MS
        ? latestZoomFocus.point
        : null;
      scheduleCanvasImageFocus(viewport, focusPoint ? { focusPoint } : undefined);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    },
    [
      getCurrentProject,
      saveCurrentProjectViewport,
      scheduleCanvasImageFocus,
      setCanvasImageInteractionActive,
      setViewportState,
    ]
  );

  const handleMove = useCallback(
    (_event: unknown, viewport: Viewport) => {
      setViewportState(viewport);
    },
    [setViewportState]
  );

  const handleMoveStart = useCallback(() => {
    if (!isRestoringCanvasRef.current) {
      setCanvasImageInteractionActive(true);
      setRequestedCanvasImageOriginals([]);
    }
    cancelPendingViewportPersist();
  }, [
    cancelPendingViewportPersist,
    setCanvasImageInteractionActive,
    setRequestedCanvasImageOriginals,
  ]);

  const handleCanvasPointerDownCapture = useCallback(() => {
    latestZoomFocusPointRef.current = null;
  }, []);

  const handleCanvasWheelCapture = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    latestZoomFocusPointRef.current = {
      point: {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      },
      timestamp: performance.now(),
    };
  }, []);

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    const edgePathSelector = '.react-flow__edge-path, .react-flow__edge-interaction';
    const dragThreshold = 4;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (target.closest('.react-flow__edgeupdater')) {
        return;
      }

      const edgePathElement = target.closest(edgePathSelector);
      if (!edgePathElement) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      edgePanGestureRef.current = {
        active: true,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewportX: viewport.x,
        startViewportY: viewport.y,
        zoom: viewport.zoom,
        moved: false,
      };
      cancelPendingViewportPersist();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || !gesture.active || event.pointerId !== gesture.pointerId) {
        return;
      }

      const deltaX = event.clientX - gesture.startClientX;
      const deltaY = event.clientY - gesture.startClientY;

      if (!gesture.moved && Math.hypot(deltaX, deltaY) >= dragThreshold) {
        gesture.moved = true;
      }
      if (!gesture.moved) {
        return;
      }

      suppressNextEdgeClickRef.current = true;
      reactFlowInstance.setViewport(
        {
          x: gesture.startViewportX + deltaX,
          y: gesture.startViewportY + deltaY,
          zoom: gesture.zoom,
        },
        { duration: 0 }
      );
    };

    const completeEdgePanGesture = () => {
      const gesture = edgePanGestureRef.current;
      if (!gesture) {
        return;
      }

      edgePanGestureRef.current = null;
      if (!gesture.moved) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    wrapperElement.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);

    return () => {
      wrapperElement.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [
    cancelPendingViewportPersist,
    getCurrentProject,
    reactFlowInstance,
    saveCurrentProjectViewport,
    setViewportState,
  ]);

  const selectedConnectSourceNodeIds = useMemo(
    () => {
      const selectedNodeIdSet = new Set(selectedNodeIds);
      return workflowNodes
        .filter(
          (node) =>
            selectedNodeIdSet.has(node.id) &&
            nodeHasSourceHandle(node.type) &&
            canNodeTypeBeManualConnectionSource(node.type)
        )
        .map((node) => node.id);
    },
    [selectedNodeIds, workflowNodes]
  );
  const hasMultiSelectionConnector =
    interactionMode === 'select' && selectedConnectSourceNodeIds.length >= 2;

  const handleMultiConnectEnd = useCallback(
    (
      sourceNodeIds: string[],
      clientPosition: { x: number; y: number },
      explicitTargetHandle?: string
    ) => {
      setPendingMultiConnectSourceNodeIds(null);

      const targetNodeElement = document
        .elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest<HTMLElement>('.react-flow__node[data-id]');
      const targetNodeId = targetNodeElement?.dataset.id;
      const state = useCanvasStore.getState();

      if (targetNodeId) {
        const plan = buildBatchConnectionPlan(
          sourceNodeIds,
          targetNodeId,
          state.nodes,
          state.edges,
          explicitTargetHandle
        );
        if (plan.invalidSourceIds.length > 0) {
          void showErrorDialog(
            t('canvas.multiConnect.invalidTarget'),
            t('common.error')
          );
          return;
        }

        if (connectNodesBatch(plan.connections) > 0) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      const allowedTypes = getBatchConnectMenuNodeTypes(sourceNodeIds, state.nodes);
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (allowedTypes.length === 0 || !containerRect) {
        return;
      }

      setFlowPosition(reactFlowInstance.screenToFlowPosition(clientPosition));
      setMenuPosition({
        x: clientPosition.x - containerRect.left,
        y: clientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      setPendingConnectStart(null);
      setPendingMultiConnectSourceNodeIds([...sourceNodeIds]);
      setPreviewConnectionVisual(null);
      setNodeContextMenu(null);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [connectNodesBatch, reactFlowInstance, scheduleCanvasPersist, t]
  );

  const selectedUploadNodeId = useMemo(() => {
    if (selectedNodeIds.length !== 1) {
      return null;
    }
    const selectedNode = workflowNodes.find((node) => node.id === selectedNodeIds[0]);
    if (!selectedNode || selectedNode.type !== CANVAS_NODE_TYPES.upload) {
      return null;
    }
    return selectedNode.id;
  }, [selectedNodeIds, workflowNodes]);

  useEffect(() => {
    if (selectedNodeIds.length === 1) {
      if (selectedNodeId !== selectedNodeIds[0]) {
        setSelectedNode(selectedNodeIds[0]);
      }
      return;
    }

    if (selectedNodeId !== null) {
      setSelectedNode(null);
    }
  }, [selectedNodeId, selectedNodeIds, setSelectedNode]);

  useEffect(() => {
    setIsSpacePanActive(false);
    if (interactionMode !== 'select') {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !isTypingTarget(event.target)) {
        setIsSpacePanActive(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        setIsSpacePanActive(false);
      }
    };
    const handleWindowBlur = () => setIsSpacePanActive(false);

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [interactionMode]);

  const copyNodesToClipboard = useCallback((nodeIds: string[]) => {
    const sourceNodeIds = new Set(nodeIds);
    if (sourceNodeIds.size === 0) {
      return false;
    }

    const state = useCanvasStore.getState();
    const copiedNodes = state.nodes.filter((node) => sourceNodeIds.has(node.id));
    if (copiedNodes.length === 0) {
      return false;
    }

    copiedSnapshotRef.current = {
      nodes: copiedNodes,
      edges: state.edges.filter(
        (edge) => sourceNodeIds.has(edge.source) && sourceNodeIds.has(edge.target)
      ),
    };
    setHasCopiedNodes(true);
    return true;
  }, []);

  const deleteNodeIds = useCallback((nodeIds: string[]) => {
    const uniqueNodeIds = Array.from(new Set(nodeIds));
    if (uniqueNodeIds.length === 0) {
      return;
    }

    if (uniqueNodeIds.length === 1) {
      deleteNode(uniqueNodeIds[0]);
    } else {
      deleteNodes(uniqueNodeIds);
    }
    scheduleCanvasPersist(0);
  }, [deleteNode, deleteNodes, scheduleCanvasPersist]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      pasteImageHandledRef.current = false;
      if (!selectedUploadNodeId || isTypingTarget(event.target)) {
        return;
      }

      const imageFile = resolveClipboardImageFile(event);
      if (!imageFile) {
        return;
      }

      event.preventDefault();
      pasteImageHandledRef.current = true;
      canvasEventBus.publish('upload-node/paste-image', {
        nodeId: selectedUploadNodeId,
        file: imageFile,
      });
    };

    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('paste', handlePaste);
    };
  }, [selectedUploadNodeId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldSuppressKeyboardCommand(event)) {
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      const commandPressed = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const isUndo = commandPressed && key === 'z' && !event.shiftKey;
      const isRedo = commandPressed && (key === 'y' || (key === 'z' && event.shiftKey));
      const isGroup = commandPressed && key === 'g';
      const isCopy = commandPressed && key === 'c' && !event.shiftKey;
      const isPaste = commandPressed && key === 'v' && !event.shiftKey;

      if (!commandPressed && !event.altKey && !event.shiftKey && (key === 'v' || key === 'h')) {
        event.preventDefault();
        setInteractionMode(key === 'v' ? 'select' : 'pan');
        return;
      }

      if (isCopy) {
        if (selectedNodeIds.length === 0) {
          return;
        }
        event.preventDefault();
        copyNodesToClipboard(selectedNodeIds);
        return;
      }

      if (isPaste) {
        if (selectedUploadNodeId) {
          pasteImageHandledRef.current = false;
          window.setTimeout(() => {
            if (pasteImageHandledRef.current) {
              pasteImageHandledRef.current = false;
              return;
            }

            if (!copiedSnapshotRef.current || copiedSnapshotRef.current.nodes.length === 0) {
              return;
            }

            void duplicateNodesRef.current?.(copiedSnapshotRef.current.nodes.map((node) => node.id));
          }, 0);
          return;
        }

        if (!copiedSnapshotRef.current || copiedSnapshotRef.current.nodes.length === 0) {
          return;
        }
        event.preventDefault();
        void duplicateNodesRef.current?.(copiedSnapshotRef.current.nodes.map((node) => node.id));
        return;
      }

      if (isUndo || isRedo) {
        event.preventDefault();
        const changed = isUndo ? undo() : redo();
        if (changed) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      if (isGroup) {
        if (selectedNodeIds.length < 2) {
          return;
        }
        event.preventDefault();
        const createdGroupId = groupNodes(selectedNodeIds);
        if (createdGroupId) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return;
      }

      const idsToDelete = selectedNodeIds.length > 0
        ? selectedNodeIds
        : selectedNodeId
          ? [selectedNodeId]
          : [];
      if (idsToDelete.length === 0) {
        return;
      }

      event.preventDefault();
      deleteNodeIds(idsToDelete);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    selectedNodeId,
    selectedNodeIds,
    copyNodesToClipboard,
    deleteNodeIds,
    groupNodes,
    undo,
    redo,
    scheduleCanvasPersist,
    selectedUploadNodeId,
  ]);

  const openNodeMenuAtClientPosition = useCallback((clientX: number, clientY: number) => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) {
      return;
    }

    const flowPos = reactFlowInstance.screenToFlowPosition({
      x: clientX,
      y: clientY,
    });

    setFlowPosition(flowPos);
    setMenuPosition({
      x: clientX - containerRect.left,
      y: clientY - containerRect.top,
    });
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPendingMultiConnectSourceNodeIds(null);
    setPreviewConnectionVisual(null);
    setNodeContextMenu(null);
    setShowNodeMenu(true);
  }, [reactFlowInstance]);

  const importCanvasMedia = useCallback(async (position: { x: number; y: number }) => {
    let selected: string | string[] | null;
    try {
      selected = await open({
        multiple: true,
        directory: false,
        filters: createCanvasMediaImportDialogFilters({
          images: t('canvas.mediaImport.images'),
          videos: t('canvas.mediaImport.videos'),
          audio: t('canvas.mediaImport.audio'),
        }),
      });
    } catch (error) {
      logger.error('Failed to open canvas media import dialog', error);
      void showErrorDialog(t('canvas.mediaImport.openFailed'), t('common.error'));
      return;
    }
    if (!selected) {
      return;
    }

    const paths = Array.isArray(selected) ? selected : [selected];
    const { items, failures } = await prepareCanvasMediaImportBatch(
      paths,
      getCurrentProject()?.id,
      useUploadFilenameAsNodeTitle,
    );
    if (items.length > 0) {
      addNodeBatch(layoutCanvasMediaImportNodes(items, position));
      scheduleCanvasPersist(0);
    }
    if (failures.length > 0) {
      const names = failures.map((failure) => getCanvasMediaFileName(failure.path)).join('、');
      void showErrorDialog(
        t('canvas.mediaImport.failed', { count: failures.length, names }),
        t('common.error'),
      );
    }
  }, [addNodeBatch, getCurrentProject, scheduleCanvasPersist, t, useUploadFilenameAsNodeTitle]);

  const handleCanvasDrop = useCallback(
    async (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const fileList = event.dataTransfer?.files;
      if (!fileList || fileList.length === 0) {
        return;
      }

      const imageFiles: File[] = [];
      const audioFiles: File[] = [];
      const videoFiles: File[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        if (file.type.startsWith('image/')) {
          imageFiles.push(file);
        } else if (file.type.startsWith('audio/')) {
          audioFiles.push(file);
        } else if (file.type.startsWith('video/')) {
          videoFiles.push(file);
        }
      }

      if (imageFiles.length === 0 && audioFiles.length === 0 && videoFiles.length === 0) {
        return;
      }

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) {
        return;
      }

      const flowPos = reactFlowInstance.screenToFlowPosition({
        x: event.clientX - containerRect.left,
        y: event.clientY - containerRect.top,
      });

      let currentX = flowPos.x;
      const baseY = flowPos.y;

      const projectId = getCurrentProject()?.id;

      for (const file of imageFiles) {
        try {
          const prepared = await prepareNodeImageFromFile(file, 512, projectId);
          const newNodeId = addNode(CANVAS_NODE_TYPES.upload, {
            x: currentX,
            y: baseY,
          }, {
            imageUrl: prepared.imageUrl,
            previewImageUrl: prepared.previewImageUrl ?? null,
            aspectRatio: prepared.aspectRatio,
            ...(useUploadFilenameAsNodeTitle ? { displayName: file.name } : {}),
          });
          void newNodeId;

          const newNode = nodes.find((n) => n.id === newNodeId);
          if (newNode) {
            currentX += (newNode.measured?.width ?? DEFAULT_NODE_WIDTH) + 40;
          }
        } catch (error) {
          logger.error('Failed to process dropped image:', error);
        }
      }

      for (const file of audioFiles) {
        try {
          const filePath = (file as File & { path?: string }).path;
          const sourcePath = typeof filePath === 'string' && filePath.trim().length > 0
            ? filePath
            : URL.createObjectURL(file);
          const audioUrl = projectId && filePath
            ? await convertAudioToMp3(sourcePath, projectId)
            : sourcePath;
          const newNodeId = addNode(CANVAS_NODE_TYPES.audioUpload, { x: currentX, y: baseY + 170 }, {
            audioUrl,
            sourceFileName: file.name,
            ...(useUploadFilenameAsNodeTitle ? { displayName: file.name } : {}),
          });
          void newNodeId;
          currentX += 240;
        } catch (error) {
          logger.error('Failed to process dropped audio:', error);
        }
      }

      for (const file of videoFiles) {
        try {
          const filePath = (file as File & { path?: string }).path;
          const sourcePath = typeof filePath === 'string' && filePath.trim().length > 0
            ? filePath
            : URL.createObjectURL(file);
          const videoUrl = projectId && filePath
            ? await convertVideoToMp4(sourcePath, projectId)
            : sourcePath;
          const newNodeId = addNode(CANVAS_NODE_TYPES.videoUpload, { x: currentX, y: baseY + 330 }, {
            videoUrl,
            sourceFileName: file.name,
            ...(useUploadFilenameAsNodeTitle ? { displayName: file.name } : {}),
          });
          void newNodeId;
          currentX += 260;
        } catch (error) {
          logger.error('Failed to process dropped video:', error);
        }
      }
    },
    [addNode, getCurrentProject, nodes, reactFlowInstance, useUploadFilenameAsNodeTitle]
  );

  const handleCanvasDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handlePaneClick = useCallback((event: ReactMouseEvent) => {
    if (shouldSuppressPaneClickAfterProjectOpen(event)) {
      return;
    }

    if (suppressNextPaneClickRef.current) {
      suppressNextPaneClickRef.current = false;
      return;
    }

    if (event.detail >= 2) {
      openNodeMenuAtClientPosition(event.clientX, event.clientY);
      return;
    }

    setSelectedNode(null);
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPendingMultiConnectSourceNodeIds(null);
    setPreviewConnectionVisual(null);
    setNodeContextMenu(null);
  }, [openNodeMenuAtClientPosition, setSelectedNode]);

  const handlePaneContextMenu = useCallback((event: MouseEvent | ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setNodeContextMenu(null);
    openNodeMenuAtClientPosition(event.clientX, event.clientY);
  }, [openNodeMenuAtClientPosition]);

  const handleNodeSelect = useCallback(
    (type: CanvasNodeType) => {
      const batchSourceNodeIds = pendingMultiConnectSourceNodeIds;
      if (
        type === CANVAS_NODE_TYPES.upload
        && !pendingConnectStart
        && (!batchSourceNodeIds || batchSourceNodeIds.length === 0)
      ) {
        void importCanvasMedia(flowPosition);
        return;
      }
      if (batchSourceNodeIds && batchSourceNodeIds.length > 0) {
        const currentNodes = useCanvasStore.getState().nodes;
        if (!getBatchConnectMenuNodeTypes(batchSourceNodeIds, currentNodes).includes(type)) {
          void showErrorDialog(
            t('canvas.multiConnect.invalidTarget'),
            t('common.error')
          );
          setShowNodeMenu(false);
          setMenuAllowedTypes(undefined);
          setPendingConnectStart(null);
          setPendingMultiConnectSourceNodeIds(null);
          setPreviewConnectionVisual(null);
          return;
        }
      }

      const newNodeId = addNode(type, flowPosition);
      if (batchSourceNodeIds && batchSourceNodeIds.length > 0) {
        const state = useCanvasStore.getState();
        const plan = buildBatchConnectionPlan(
          batchSourceNodeIds,
          newNodeId,
          state.nodes,
          state.edges
        );
        if (plan.invalidSourceIds.length > 0) {
          void showErrorDialog(
            t('canvas.multiConnect.invalidTarget'),
            t('common.error')
          );
        } else {
          connectNodesBatch(plan.connections);
        }
      } else if (pendingConnectStart) {
        const fixedNode = useCanvasStore.getState().nodes.find(
          (node) => node.id === pendingConnectStart.nodeId
        );
        const sourceType = pendingConnectStart.handleType === 'source'
          ? fixedNode?.type
          : type;
        const targetType = pendingConnectStart.handleType === 'source'
          ? type
          : fixedNode?.type;
        const targetHandleId = pendingConnectStart.handleType === 'target'
          && pendingConnectStart.handleId
          ? pendingConnectStart.handleId
          : sourceType && targetType
            ? getDefaultCanvasTargetHandle(sourceType, targetType)
            : 'target';

        if (pendingConnectStart.handleType === 'source') {
          connectNodes({
            source: pendingConnectStart.nodeId,
            target: newNodeId,
            sourceHandle: 'source',
            targetHandle: targetHandleId,
          });
        } else {
          connectNodes({
            source: newNodeId,
            target: pendingConnectStart.nodeId,
            sourceHandle: 'source',
            targetHandle: pendingConnectStart.handleId || targetHandleId,
          });
        }
      }

      scheduleCanvasPersist(0);
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPendingMultiConnectSourceNodeIds(null);
      setPreviewConnectionVisual(null);
    },
    [
      addNode,
      connectNodes,
      connectNodesBatch,
      flowPosition,
      importCanvasMedia,
      pendingConnectStart,
      pendingMultiConnectSourceNodeIds,
      scheduleCanvasPersist,
      setPreviewConnectionVisual,
      t,
    ]
  );

  const duplicateNodes = useCallback(
    (sourceNodeIds: string[], options: DuplicateOptions = {}) => {
      const dedupedIds = Array.from(new Set(sourceNodeIds));
      if (dedupedIds.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceNodes = nodes.filter((node) => dedupedIds.includes(node.id));
      if (sourceNodes.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceIdSet = new Set(sourceNodes.map((node) => node.id));
      const internalEdges = sortCanvasEdgesForDuplication(edges.filter(
        (edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target)
      ));

      const baseOffsets = [
        { x: 44, y: 30 },
        { x: 72, y: 8 },
        { x: 18, y: 68 },
        { x: 96, y: 42 },
      ];
      const existingNodes = useCanvasStore.getState().nodes;
      const ignoreNodeIds = new Set<string>();
      const offsetStep = options.disableOffsetIteration ? 0 : pasteIterationRef.current;
      let chosenOffset = options.explicitOffset ?? baseOffsets[0];

      const isOffsetAvailable = (offset: { x: number; y: number }) => sourceNodes.every((node) => {
        const size = getNodeSize(node);
        return !hasRectCollision(
          {
            x: node.position.x + offset.x + offsetStep * 8,
            y: node.position.y + offset.y + offsetStep * 6,
            width: size.width,
            height: size.height,
          },
          existingNodes,
          ignoreNodeIds
        );
      });

      if (!options.explicitOffset) {
        const matchedBaseOffset = baseOffsets.find((offset) => isOffsetAvailable(offset));
        if (matchedBaseOffset) {
          chosenOffset = matchedBaseOffset;
        } else {
          const maxStep = 16;
          for (let step = 1; step <= maxStep; step += 1) {
            const candidate = { x: 24 + step * 26, y: 16 + step * 18 };
            if (isOffsetAvailable(candidate)) {
              chosenOffset = candidate;
              break;
            }
          }
        }
      }

      const idMap = new Map<string, string>();
      const sizeMap = new Map<string, { width: number; height: number }>();
      for (const sourceNode of sourceNodes) {
        const data = cloneNodeData(sourceNode.data);
        if ('isGenerating' in (data as Record<string, unknown>)) {
          (data as { isGenerating?: boolean }).isGenerating = false;
        }
        if ('generationStartedAt' in (data as Record<string, unknown>)) {
          (data as { generationStartedAt?: number | null }).generationStartedAt = null;
        }
        if ('generationJobId' in (data as Record<string, unknown>)) {
          (data as { generationJobId?: string | null }).generationJobId = null;
        }
        if ('generationProviderId' in (data as Record<string, unknown>)) {
          (data as { generationProviderId?: string | null }).generationProviderId = null;
        }
        if ('generationProviderName' in (data as Record<string, unknown>)) {
          (data as { generationProviderName?: string | null }).generationProviderName = null;
        }
        if ('generationModelName' in (data as Record<string, unknown>)) {
          (data as { generationModelName?: string | null }).generationModelName = null;
        }
        if ('generationClientSessionId' in (data as Record<string, unknown>)) {
          (data as { generationClientSessionId?: string | null }).generationClientSessionId = null;
        }
        if ('generationStoryboardMetadata' in (data as Record<string, unknown>)) {
          (data as { generationStoryboardMetadata?: unknown }).generationStoryboardMetadata = undefined;
        }
        if ('generationError' in (data as Record<string, unknown>)) {
          (data as { generationError?: string | null }).generationError = null;
        }
        if ('generationErrorDetails' in (data as Record<string, unknown>)) {
          (data as { generationErrorDetails?: string | null }).generationErrorDetails = null;
        }
        if ('generationDebugContext' in (data as Record<string, unknown>)) {
          (data as { generationDebugContext?: unknown }).generationDebugContext = undefined;
        }
        if ('generationRecoveryState' in (data as Record<string, unknown>)) {
          (data as { generationRecoveryState?: string | null }).generationRecoveryState = null;
        }
        if ('generationRetryCount' in (data as Record<string, unknown>)) {
          (data as { generationRetryCount?: number }).generationRetryCount = 0;
        }
        if ('generationNextRetryAt' in (data as Record<string, unknown>)) {
          (data as { generationNextRetryAt?: number | null }).generationNextRetryAt = null;
        }
        if ('generationRetryError' in (data as Record<string, unknown>)) {
          (data as { generationRetryError?: string | null }).generationRetryError = null;
        }

        const nextNodeId = addNode(
          sourceNode.type as CanvasNodeType,
          {
            x: sourceNode.position.x + chosenOffset.x + offsetStep * 8,
            y: sourceNode.position.y + chosenOffset.y + offsetStep * 6,
          },
          { ...data }
        );
        idMap.set(sourceNode.id, nextNodeId);
        sizeMap.set(nextNodeId, getNodeSize(sourceNode));
      }

      const sizeSyncChanges = Array.from(sizeMap.entries()).map(([nodeId, size]) => ({
        id: nodeId,
        type: 'dimensions' as const,
        dimensions: { width: size.width, height: size.height },
        resizing: false,
        setAttributes: true,
      }));
      if (sizeSyncChanges.length > 0) {
        applyNodesChange(sizeSyncChanges);
      }

      for (const edge of internalEdges) {
        const nextSource = idMap.get(edge.source);
        const nextTarget = idMap.get(edge.target);
        if (!nextSource || !nextTarget) {
          continue;
        }
        connectNodes({
          source: nextSource,
          target: nextTarget,
          sourceHandle: edge.sourceHandle ?? 'source',
          targetHandle: edge.targetHandle ?? 'target',
        });
      }

      if (!options.disableOffsetIteration) {
        pasteIterationRef.current += 1;
      }
      const firstNodeId = idMap.get(sourceNodes[0].id) ?? null;
      if (firstNodeId && !options.suppressSelect) {
        setSelectedNode(firstNodeId);
      }
      if (!options.suppressPersist) {
        scheduleCanvasPersist(0);
      }
      return { firstNodeId, idMap };
    },
    [addNode, applyNodesChange, connectNodes, edges, nodes, scheduleCanvasPersist, setSelectedNode]
  );

  useEffect(() => {
    duplicateNodesRef.current = (sourceNodeIds: string[]) => duplicateNodes(sourceNodeIds)?.firstNodeId ?? null;
  }, [duplicateNodes]);

  const closeNodeContextMenu = useCallback(() => {
    setNodeContextMenu(null);
  }, []);

  const handleNodeContextMenu = useCallback(
    (event: ReactMouseEvent, node: CanvasNode) => {
      event.preventDefault();
      event.stopPropagation();

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) {
        return;
      }

      const isNodeAlreadySelected = selectedNodeIds.includes(node.id);
      const targetNodeIds = isNodeAlreadySelected && selectedNodeIds.length > 0
        ? selectedNodeIds
        : [node.id];
      if (!isNodeAlreadySelected) {
        const selectChanges: NodeChange<CanvasNode>[] = useCanvasStore
          .getState()
          .nodes.map((currentNode) => ({
            id: currentNode.id,
            type: 'select' as const,
            selected: currentNode.id === node.id,
          }));
        applyNodesChange(selectChanges);
        setSelectedNode(node.id);
      }

      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPendingMultiConnectSourceNodeIds(null);
      setPreviewConnectionVisual(null);
      setNodeContextMenu({
        id: nodeContextMenuSequenceRef.current += 1,
        nodeIds: targetNodeIds,
        position: {
          x: Math.min(
            Math.max(NODE_CONTEXT_MENU_INSET, event.clientX - containerRect.left),
            Math.max(
              NODE_CONTEXT_MENU_INSET,
              containerRect.width - NODE_CONTEXT_MENU_WIDTH - NODE_CONTEXT_MENU_INSET
            )
          ),
          y: Math.min(
            Math.max(NODE_CONTEXT_MENU_INSET, event.clientY - containerRect.top),
            Math.max(
              NODE_CONTEXT_MENU_INSET,
              containerRect.height - NODE_CONTEXT_MENU_HEIGHT - NODE_CONTEXT_MENU_INSET
            )
          ),
        },
      });
    },
    [applyNodesChange, selectedNodeIds, setSelectedNode]
  );

  const handleConnectStart = useCallback(
    (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingMultiConnectSourceNodeIds(null);
      setPreviewConnectionVisual(null);

      if (!params.nodeId || !params.handleType) {
        setPendingConnectStart(null);
        return;
      }

      if (
        params.handleType === 'source'
        && !canNodeBeManualConnectionSource(params.nodeId, useCanvasStore.getState().nodes)
      ) {
        setPendingConnectStart(null);
        return;
      }

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const eventTarget = event.target as Element | null;
      const handleElement = eventTarget?.closest?.('.react-flow__handle') as HTMLElement | null;
      const clientPosition = getClientPosition(event);
      let start: { x: number; y: number } | undefined;
      if (containerRect && handleElement) {
        const handleRect = handleElement.getBoundingClientRect();
        start = {
          x: handleRect.left - containerRect.left + handleRect.width / 2,
          y: handleRect.top - containerRect.top + handleRect.height / 2,
        };
      } else if (containerRect && clientPosition) {
        start = {
          x: clientPosition.x - containerRect.left,
          y: clientPosition.y - containerRect.top,
        };
      }

      setPendingConnectStart({
        nodeId: params.nodeId,
        handleType: params.handleType,
        handleId: params.handleId ?? undefined,
        start,
      });
    },
    []
  );

  const handleNodeDragStart = useCallback(
    (event: ReactMouseEvent, node: CanvasNode) => {
      setCanvasImageInteractionActive(true);
      if (!event.altKey) {
        altDragCopyRef.current = null;
        return;
      }

      const sourceNodeIds = selectedNodeIds.includes(node.id)
        ? selectedNodeIds
        : [node.id];
      if (sourceNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }
      const startPositions = new Map<string, { x: number; y: number }>();
      for (const sourceNodeId of sourceNodeIds) {
        const sourceNode = nodes.find((item) => item.id === sourceNodeId);
        if (!sourceNode) {
          continue;
        }
        startPositions.set(sourceNodeId, {
          x: sourceNode.position.x,
          y: sourceNode.position.y,
        });
      }
      if (startPositions.size === 0) {
        altDragCopyRef.current = null;
        return;
      }

      const duplicateResult = duplicateNodes(sourceNodeIds, {
        explicitOffset: { x: 0, y: 0 },
        disableOffsetIteration: true,
        suppressPersist: true,
        suppressSelect: true,
      });
      if (!duplicateResult) {
        altDragCopyRef.current = null;
        return;
      }

      const copiedNodeIds = sourceNodeIds
        .map((sourceId) => duplicateResult.idMap.get(sourceId))
        .filter((id): id is string => Boolean(id));
      if (copiedNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }

      // Keep the duplicated nodes visually above the original dragged node.
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          if (!copiedNodeIds.includes(currentNode.id)) {
            return currentNode;
          }
          return {
            ...currentNode,
            zIndex: ALT_DRAG_COPY_Z_INDEX,
            style: {
              ...(currentNode.style ?? {}),
              zIndex: ALT_DRAG_COPY_Z_INDEX,
            },
          };
        }),
      }));

      altDragCopyRef.current = {
        sourceNodeIds,
        startPositions,
        copiedNodeIds,
        sourceToCopyIdMap: duplicateResult.idMap,
      };
    },
    [duplicateNodes, nodes, selectedNodeIds, setCanvasImageInteractionActive]
  );

  const handleNodeDrag = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const deltaX = node.position.x - startPosition.x;
      const deltaY = node.position.y - startPosition.y;

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const moveCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + deltaX, y: sourceStart.y + deltaY },
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...moveCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
    },
    [applyNodesChange]
  );

  const handleNodeDragStop = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      setCanvasImageInteractionActive(false);
      scheduleCanvasImageFocus();
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }
      altDragCopyRef.current = null;

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const offset = {
        x: node.position.x - startPosition.x,
        y: node.position.y - startPosition.y,
      };

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const finalizeCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + offset.x, y: sourceStart.y + offset.y },
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...finalizeCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
      if (altCopyState.copiedNodeIds.length > 0) {
        setSelectedNode(altCopyState.copiedNodeIds[0]);
      }
      scheduleCanvasPersist(0);
    },
    [
      applyNodesChange,
      scheduleCanvasImageFocus,
      scheduleCanvasPersist,
      setCanvasImageInteractionActive,
      setSelectedNode,
    ]
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid || !pendingConnectStart) {
        setPendingConnectStart(null);
        setPendingMultiConnectSourceNodeIds(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const clientPosition = getClientPosition(event);
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!clientPosition || !containerRect) {
        setPendingConnectStart(null);
        setPendingMultiConnectSourceNodeIds(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const eventTarget = event.target as Element | null;
      const nodeElementFromTarget = eventTarget?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const nodeElementFromPoint = document.elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const dropNodeElement = nodeElementFromTarget ?? nodeElementFromPoint;
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;

      // Find the source node type for filtering allowed target types
      const currentNodes = useCanvasStore.getState().nodes;
      const fixedNodeForFilter = currentNodes.find(
        (node) => node.id === pendingConnectStart.nodeId
      );

      if (dropNodeId && dropNodeId !== pendingConnectStart.nodeId) {
        const sourceNode =
          pendingConnectStart.handleType === 'source'
            ? currentNodes.find((node) => node.id === pendingConnectStart.nodeId)
            : currentNodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pendingConnectStart.handleType === 'source'
            ? currentNodes.find((node) => node.id === dropNodeId)
            : currentNodes.find((node) => node.id === pendingConnectStart.nodeId);

        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          const defaultTargetHandle = getDefaultCanvasTargetHandle(
            sourceNode.type,
            targetNode.type
          );
          const targetHandleId = pendingConnectStart.handleType === 'target' && pendingConnectStart.handleId
            ? pendingConnectStart.handleId
            : defaultTargetHandle;
          logger.info('[handleConnectEnd] connecting:', {
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle: 'source',
            targetHandle: targetHandleId,
            pendingHandleType: pendingConnectStart.handleType,
            pendingHandleId: pendingConnectStart.handleId,
            targetNodeType: targetNode.type,
          });
          connectNodes({
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle: 'source',
            targetHandle: targetHandleId,
          });
          scheduleCanvasPersist(0);
          setPendingConnectStart(null);
          setPreviewConnectionVisual(null);
          return;
        }
      }

      const allowedTypes = resolveAllowedNodeTypes(
        pendingConnectStart.handleType,
        fixedNodeForFilter?.type
      );
      if (allowedTypes.length === 0) {
        setPendingConnectStart(null);
        setPendingMultiConnectSourceNodeIds(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const endX = clientPosition.x - containerRect.left;
      const endY = clientPosition.y - containerRect.top;
      let startX: number | null = pendingConnectStart.start?.x ?? null;
      let startY: number | null = pendingConnectStart.start?.y ?? null;

      if (startX === null || startY === null) {
        const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${pendingConnectStart.nodeId}"]`
        );
        const handleElement = nodeElement?.querySelector<HTMLElement>(
          `.react-flow__handle-${pendingConnectStart.handleType}`
        );
        if (handleElement) {
          const handleRect = handleElement.getBoundingClientRect();
          startX = handleRect.left - containerRect.left + handleRect.width / 2;
          startY = handleRect.top - containerRect.top + handleRect.height / 2;
        } else if (nodeElement) {
          const nodeRect = nodeElement.getBoundingClientRect();
          startX =
            pendingConnectStart.handleType === 'source'
              ? nodeRect.right - containerRect.left
              : nodeRect.left - containerRect.left;
          startY = nodeRect.top - containerRect.top + nodeRect.height / 2;
        } else if (connectionState.from) {
          startX = connectionState.from.x;
          startY = connectionState.from.y;
        }
      }

      if (startX === null || startY === null) {
        setPreviewConnectionVisual(null);
      } else {
        setPreviewConnectionVisual({
          d: createPreviewPath({
            start: { x: startX, y: startY },
            end: { x: endX, y: endY },
            handleType: pendingConnectStart.handleType,
          }),
          stroke: 'var(--accent)',
          strokeWidth: 2.5,
          strokeLinecap: 'round',
          left: 0,
          top: 0,
          width: containerRect.width,
          height: containerRect.height,
        });
      }

      const flowPos = reactFlowInstance.screenToFlowPosition(clientPosition);
      setFlowPosition(flowPos);
      setMenuPosition({
        x: clientPosition.x - containerRect.left,
        y: clientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      setPendingMultiConnectSourceNodeIds(null);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [connectNodes, pendingConnectStart, reactFlowInstance, scheduleCanvasPersist]
  );

  const emptyHint = useMemo(
    () => (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="flex max-w-3xl flex-col items-center gap-5 px-6 text-center">
          <div>
            <div className="mb-2 text-2xl text-text-muted">{t('canvas.emptyHintTitle')}</div>
            <div className="text-sm text-text-muted opacity-60">{t('canvas.emptyHintSubtitle')}</div>
          </div>
        </div>
      </div>
    ),
    [t]
  );

  return (
    <div
      ref={wrapperRef}
      className={`relative h-full w-full canvas-mode-${interactionMode} ${isSpacePanActive ? 'canvas-space-pan-active' : ''} ${hasMultiSelectionConnector ? 'canvas-multi-select-active' : ''}`}
      onPointerDownCapture={handleCanvasPointerDownCapture}
      onWheelCapture={handleCanvasWheelCapture}
      onDrop={handleCanvasDrop}
      onDragOver={handleCanvasDragOver}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onEdgeClick={handleEdgeClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        connectionRadius={resolveCanvasConnectionRadius(currentViewport.zoom)}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneClick={handlePaneClick}
        onPaneContextMenu={handlePaneContextMenu}
        onMove={handleMove}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        connectionLineStyle={CONNECTION_LINE_STYLE}
        defaultViewport={DEFAULT_VIEWPORT}
        minZoom={0.1}
        maxZoom={5}
        snapGrid={snapGrid}
        snapToGrid={snapToGridEnabled}
        panOnDrag={interactionMode === 'pan'}
        panActivationKeyCode="Space"
        selectionOnDrag={interactionMode === 'select'}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={MULTI_SELECTION_KEY_CODES}
        selectionKeyCode={null}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        deleteKeyCode={null}
        onlyRenderVisibleElements
        zoomOnDoubleClick={false}
        proOptions={REACT_FLOW_PRO_OPTIONS}
        className="canvas-surface"
      >
        {snapToGridEnabled && <CanvasGridBackground gap={snapGridSize} />}
        <CanvasMinimapControl />

        <SelectedNodeOverlay />
      </ReactFlow>

      <MultiSelectionConnector
        enabled={hasMultiSelectionConnector}
        nodes={nodes}
        selectedNodeIds={selectedNodeIds}
        sourceNodeIds={selectedConnectSourceNodeIds}
        viewport={currentViewport}
        wrapperRef={wrapperRef}
        onConnectEnd={handleMultiConnectEnd}
      />

      {nodeContextMenu && (
        <NodeContextMenu
          key={nodeContextMenu.id}
          position={nodeContextMenu.position}
          canPaste={hasCopiedNodes}
          onCopy={() => {
            copyNodesToClipboard(nodeContextMenu.nodeIds);
          }}
          onDuplicate={() => {
            duplicateNodes(nodeContextMenu.nodeIds);
          }}
          onPaste={() => {
            const copiedSnapshot = copiedSnapshotRef.current;
            if (!copiedSnapshot || copiedSnapshot.nodes.length === 0) {
              return;
            }
            duplicateNodes(copiedSnapshot.nodes.map((node) => node.id));
          }}
          onDelete={() => {
            deleteNodeIds(nodeContextMenu.nodeIds);
          }}
          onClose={closeNodeContextMenu}
        />
      )}

      <CanvasToolbar
        interactionMode={interactionMode}
        onInteractionModeChange={setInteractionMode}
      />

      {nodes.length === 0 && emptyHint}
      {showNodeMenu && previewConnectionVisual && (
        <svg
          className="pointer-events-none absolute z-40 overflow-visible"
          style={{
            left: previewConnectionVisual.left,
            top: previewConnectionVisual.top,
            width: previewConnectionVisual.width,
            height: previewConnectionVisual.height,
          }}
          width={previewConnectionVisual.width}
          height={previewConnectionVisual.height}
        >
          <path
            className="pointer-events-none"
            d={previewConnectionVisual.d}
            fill="none"
            stroke={previewConnectionVisual.stroke}
            strokeWidth={previewConnectionVisual.strokeWidth}
            strokeLinecap={previewConnectionVisual.strokeLinecap}
          />
        </svg>
      )}

      {showNodeMenu && (
        <NodeSelectionMenu
          position={menuPosition}
          allowedTypes={menuAllowedTypes}
          onSelect={handleNodeSelect}
          onClose={() => {
            setShowNodeMenu(false);
            setMenuAllowedTypes(undefined);
            setPendingConnectStart(null);
            setPendingMultiConnectSourceNodeIds(null);
            setPreviewConnectionVisual(null);
          }}
        />
      )}

      <NodeToolDialog />

      <ImageViewerModal
        open={imageViewer.isOpen}
        imageUrl={imageViewer.currentImageUrl || ''}
        imageList={imageViewer.imageList}
        currentIndex={imageViewer.currentIndex}
        onClose={closeImageViewer}
        onNavigate={navigateImageViewer}
      />

    </div>
  );
}
