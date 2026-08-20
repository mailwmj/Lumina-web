import { create } from 'zustand';
import { logger } from '@/lib/logger';
import {
  Connection,
  EdgeChange,
  NodeChange,
  type Viewport,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
} from '@xyflow/react';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_NODE_WIDTH,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type ActiveToolDialog,
  type CanvasEdge,
  type CanvasDataType,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  type ExportImageNodeResultKind,
  type NodeToolType,
  type StoryboardExportOptions,
  type StoryboardFrameItem,
  isStoryboardSplitNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { EXPORT_RESULT_DISPLAY_NAME } from '@/features/canvas/domain/nodeDisplay';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import {
  inferCanvasConnectionValueType,
  isCanvasProgrammaticConnectionValid,
  isCanvasStoredConnectionValid,
} from '@/features/canvas/application/canvasConnection';
import { resolveTextModelSelection } from '@/features/canvas/application/textModelSelection';
import { resolveConfiguredImageModel } from '@/features/canvas/models';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  resolveMinEdgeFittedSize,
  resolveFittedImageNodeSize,
} from '@/features/canvas/application/imageNodeSizing';
import { pruneImageReferencePromptTokensForEdges } from '@/features/canvas/application/imageReferencePrompt';
import {
  applyCanvasChangeSet,
} from '@/features/canvas-agent/application/canvasChangeSet';
import type {
  CanvasChangeApplyResult,
  CanvasChangeSet,
} from '@/features/canvas-agent/domain/types';

export type {
  ActiveToolDialog,
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  NodeToolType,
  StoryboardFrameItem,
};

export interface CanvasHistorySnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface CanvasHistoryState {
  past: CanvasHistorySnapshot[];
  future: CanvasHistorySnapshot[];
}

const MAX_HISTORY_STEPS = 50;
const IMAGE_NODE_VISUAL_MIN_EDGE = 96;
const COALESCED_EDIT_WINDOW_MS = 700;
let activeCoalescedEdit: { key: string; expiresAt: number } | null = null;

function clearCoalescedEdit(): void {
  activeCoalescedEdit = null;
}

function applyNodeModelDefaults(
  type: CanvasNodeType,
  data: Partial<CanvasNodeData>
): Partial<CanvasNodeData> {
  if (type === CANVAS_NODE_TYPES.textGeneration) {
    const selectionData = data as { textApiId?: unknown; textModelId?: unknown };
    if (typeof selectionData.textApiId === 'string' || typeof selectionData.textModelId === 'string') {
      return data;
    }
    const settings = useSettingsStore.getState();
    const lastSelection = settings.lastTextGenerationModelSelection;
    if (lastSelection) {
      return {
        ...data,
        textApiId: lastSelection.apiId,
        textModelId: lastSelection.modelId,
      };
    }
    const resolved = resolveTextModelSelection(settings.textApis);
    return resolved
      ? { ...data, textApiId: resolved.apiId, textModelId: resolved.modelId }
      : data;
  }

  if ((type !== CANVAS_NODE_TYPES.imageEdit && type !== CANVAS_NODE_TYPES.storyboardGen)
    || typeof (data as { model?: unknown }).model === 'string') {
    return data;
  }

  const settings = useSettingsStore.getState();
  const rememberedOptions = settings.lastImageGenerationOptions;
  const selectedModel = resolveConfiguredImageModel(settings, undefined);
  const commonData = {
    ...(rememberedOptions.size ? { size: rememberedOptions.size } : {}),
    ...(rememberedOptions.requestAspectRatio
      ? { requestAspectRatio: rememberedOptions.requestAspectRatio }
      : {}),
    ...(rememberedOptions.extraParams
      ? { extraParams: { ...rememberedOptions.extraParams } }
      : {}),
  };
  const typeSpecificData = type === CANVAS_NODE_TYPES.imageEdit
    ? {
      ...(rememberedOptions.outputCount !== undefined
        ? { outputCount: rememberedOptions.outputCount }
        : {}),
    }
    : {
      ...(rememberedOptions.storyboardGridRows !== undefined
        ? { gridRows: rememberedOptions.storyboardGridRows }
        : {}),
      ...(rememberedOptions.storyboardGridCols !== undefined
        ? { gridCols: rememberedOptions.storyboardGridCols }
        : {}),
      ...(rememberedOptions.storyboardRatioControlMode
        ? { ratioControlMode: rememberedOptions.storyboardRatioControlMode }
        : {}),
    };

  return {
    ...commonData,
    ...typeSpecificData,
    ...data,
    ...(selectedModel ? { model: selectedModel.id } : {}),
  } as Partial<CanvasNodeData>;
}

function applyDefaultDisplayName(
  type: CanvasNodeType,
  data: Partial<CanvasNodeData>,
  existingNodes: readonly CanvasNode[],
  batchOffset = 0
): Partial<CanvasNodeData> {
  if (
    type !== CANVAS_NODE_TYPES.imageEdit
    || (typeof data.displayName === 'string' && data.displayName.trim())
  ) {
    return data;
  }
  const nextIndex = existingNodes.filter((node) => node.type === CANVAS_NODE_TYPES.imageEdit).length
    + batchOffset
    + 1;
  return { ...data, displayName: `AI生图 ${nextIndex}` };
}

interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeId: string | null;
  activeToolDialog: ActiveToolDialog | null;
  history: CanvasHistoryState;
  dragHistorySnapshot: CanvasHistorySnapshot | null;
  currentViewport: Viewport;
  canvasViewportSize: { width: number; height: number };
  imageViewer: {
    isOpen: boolean;
    currentImageUrl: string | null;
    imageList: string[];
    currentIndex: number;
  };

  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<CanvasEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  onConnectBatch: (connections: Connection[]) => number;
  applyAgentChangeSet: (changeSet: CanvasChangeSet) => CanvasChangeApplyResult;

  setCanvasData: (nodes: CanvasNode[], edges: CanvasEdge[], history?: CanvasHistoryState) => void;
  addNode: (
    type: CanvasNodeType,
    position: { x: number; y: number },
    data?: Partial<CanvasNodeData>
  ) => string;
  addNodeBatch: (
    nodes: Array<{
      type: CanvasNodeType;
      position: { x: number; y: number };
      data?: Partial<CanvasNodeData>;
      width?: number;
      height?: number;
    }>
  ) => string[];
  addEdge: (source: string, target: string) => string | null;
  connectNodesSequentially: (nodeIds: string[]) => string[];
  autoLayoutNodes: (nodeIds: string[], direction?: 'horizontal' | 'vertical' | 'grid', gap?: number) => void;
  findNodePosition: (sourceNodeId: string, newNodeWidth: number, newNodeHeight: number) => { x: number; y: number };
  arrangeNodesSequentially: (sourceNodeId: string, newNodeIds: string[], direction?: 'horizontal' | 'vertical') => void;
  addDerivedUploadNode: (
    sourceNodeId: string,
    imageUrl: string,
    aspectRatio: string,
    previewImageUrl?: string
  ) => string | null;
  addDerivedExportNode: (
    sourceNodeId: string,
    imageUrl: string,
    aspectRatio: string,
    previewImageUrl?: string,
    options?: {
      defaultTitle?: string;
      resultKind?: ExportImageNodeResultKind;
      aspectRatioStrategy?: 'provided' | 'derivedFromSource';
      sizeStrategy?: 'generated' | 'autoMinEdge' | 'matchSource';
      matchSourceNodeSize?: boolean;
    }
  ) => string | null;
  addStoryboardSplitNode: (
    sourceNodeId: string,
    rows: number,
    cols: number,
    frames: StoryboardFrameItem[],
    frameAspectRatio?: string
  ) => string | null;

  updateNodeData: (nodeId: string, data: Partial<CanvasNodeData>) => void;
  updateNodeDataWithoutHistory: (nodeId: string, data: Partial<CanvasNodeData>) => void;
  updateNodeDataCoalesced: (
    nodeId: string,
    data: Partial<CanvasNodeData>,
    historyGroup: string
  ) => void;
  updateNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  updateStoryboardFrame: (
    nodeId: string,
    frameId: string,
    data: Partial<StoryboardFrameItem>
  ) => void;
  reorderStoryboardFrame: (
    nodeId: string,
    draggedFrameId: string,
    targetFrameId: string
  ) => void;
  reorderNodeInput: (
    nodeId: string,
    valueType: CanvasDataType,
    draggedSourceId: string,
    targetSourceId: string
  ) => boolean;

  deleteNode: (nodeId: string) => void;
  deleteNodes: (nodeIds: string[]) => void;
  groupNodes: (nodeIds: string[]) => string | null;
  ungroupNode: (groupNodeId: string) => boolean;
  deleteEdge: (edgeId: string) => void;
  setSelectedNode: (nodeId: string | null) => void;

  openToolDialog: (dialog: ActiveToolDialog) => void;
  closeToolDialog: () => void;
  setViewportState: (viewport: Viewport) => void;
  setCanvasViewportSize: (size: { width: number; height: number }) => void;
  openImageViewer: (imageUrl: string, imageList?: string[]) => void;
  closeImageViewer: () => void;
  navigateImageViewer: (direction: 'prev' | 'next') => void;

  undo: () => boolean;
  redo: () => boolean;

  clearCanvas: () => void;
}

function normalizeHandleId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') {
    return undefined;
  }
  return trimmed;
}

function normalizeEdgesWithNodes(rawEdges: CanvasEdge[], nodes: CanvasNode[]): CanvasEdge[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
  const nextOrderByTargetAndType = new Map<string, number>();

  const normalizedEdges = rawEdges
    .filter((edge) => {
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) {
        return false;
      }
      return nodeHasSourceHandle(sourceNode.type) && nodeHasTargetHandle(targetNode.type);
    })
    .map((edge) => {
      const sourceNode = nodeMap.get(edge.source);
      const inferredType = sourceNode ? inferCanvasConnectionValueType(sourceNode) : null;
      const valueType = edge.data?.valueType ?? inferredType ?? undefined;
      const orderKey = valueType ? `${edge.target}:${valueType}` : '';
      const nextOrder = orderKey ? nextOrderByTargetAndType.get(orderKey) ?? 0 : 0;
      const inputOrder = Number.isFinite(edge.data?.inputOrder)
        ? Number(edge.data?.inputOrder)
        : nextOrder;
      if (orderKey) {
        nextOrderByTargetAndType.set(orderKey, Math.max(nextOrder, inputOrder + 1));
      }

      return {
        ...edge,
        type: edge.type ?? 'disconnectableEdge',
        sourceHandle:
          normalizeHandleId((edge as CanvasEdge & { sourceHandle?: unknown }).sourceHandle) ?? 'source',
        targetHandle:
          normalizeHandleId((edge as CanvasEdge & { targetHandle?: unknown }).targetHandle) ?? 'target',
        data: valueType ? { ...edge.data, valueType, inputOrder } : edge.data,
      };
    });

  return normalizedEdges.reduce<CanvasEdge[]>((accepted, edge) => {
    return isCanvasStoredConnectionValid(edge, nodes, accepted)
      ? [...accepted, edge]
      : accepted;
  }, []);
}

function createInputEdgeData(
  sourceNode: CanvasNode,
  targetId: string,
  edges: CanvasEdge[]
): CanvasEdge['data'] {
  const valueType = inferCanvasConnectionValueType(sourceNode);
  if (!valueType) {
    return undefined;
  }
  const inputOrder = edges.reduce((highest, edge) => {
    if (edge.target !== targetId || edge.data?.valueType !== valueType) {
      return highest;
    }
    const order = Number.isFinite(edge.data?.inputOrder) ? Number(edge.data?.inputOrder) : -1;
    return Math.max(highest, order);
  }, -1) + 1;
  return { valueType, inputOrder };
}

function normalizeNodes(rawNodes: CanvasNode[]): CanvasNode[] {
  return rawNodes
    .map((node) => {
      if (!Object.values(CANVAS_NODE_TYPES).includes(node.type as CanvasNodeType)) {
        return null;
      }

      const definition = nodeCatalog.getDefinition(node.type as CanvasNodeType);
      const mergedData = {
        ...definition.createDefaultData(),
        ...(node.data as Partial<CanvasNodeData>),
      } as CanvasNodeData;

      if (node.type === CANVAS_NODE_TYPES.storyboardSplit) {
        const frames = (mergedData as { frames?: StoryboardFrameItem[] }).frames ?? [];
        const firstFrameAspectRatio = frames.find((frame) => typeof frame.aspectRatio === 'string')
          ?.aspectRatio;
        const normalizedFrameAspectRatio =
          (typeof (mergedData as { frameAspectRatio?: unknown }).frameAspectRatio === 'string'
            ? (mergedData as { frameAspectRatio?: string }).frameAspectRatio
            : null) ??
          firstFrameAspectRatio ??
          DEFAULT_ASPECT_RATIO;

        (mergedData as { frameAspectRatio: string }).frameAspectRatio = normalizedFrameAspectRatio;
        (mergedData as { frames: StoryboardFrameItem[] }).frames = frames.map((frame, index) => ({
          id: frame.id,
          imageUrl: frame.imageUrl ?? null,
          previewImageUrl: frame.previewImageUrl ?? null,
          aspectRatio:
            typeof frame.aspectRatio === 'string'
              ? frame.aspectRatio
              : normalizedFrameAspectRatio,
          note: frame.note ?? '',
          order: Number.isFinite(frame.order) ? frame.order : index,
        }));

        const rawExportOptions = (mergedData as { exportOptions?: Partial<StoryboardExportOptions> })
          .exportOptions;
        const rawFontSize = Number.isFinite(rawExportOptions?.fontSize)
          ? Number(rawExportOptions?.fontSize)
          : createDefaultStoryboardExportOptions().fontSize;
        const normalizedFontSize = rawFontSize > 20
          ? Math.round(rawFontSize / 6)
          : rawFontSize;
        (mergedData as { exportOptions: StoryboardExportOptions }).exportOptions = {
          ...createDefaultStoryboardExportOptions(),
          ...(rawExportOptions ?? {}),
          fontSize: Math.max(1, Math.min(20, Math.round(normalizedFontSize))),
        };
      }

      if ('aspectRatio' in mergedData && !mergedData.aspectRatio) {
        mergedData.aspectRatio = DEFAULT_ASPECT_RATIO;
      }

      // Keep generation state only when there is a recoverable job id.
      if ('isGenerating' in mergedData && mergedData.isGenerating) {
        const generationJobId =
          typeof (mergedData as { generationJobId?: unknown }).generationJobId === 'string'
            ? (mergedData as { generationJobId?: string }).generationJobId?.trim() ?? ''
            : '';
        if (!generationJobId) {
          mergedData.isGenerating = false;
          if ('generationStartedAt' in mergedData) {
            mergedData.generationStartedAt = null;
          }
        }
      }

      return {
        ...node,
        type: node.type as CanvasNodeType,
        data: mergedData,
      };
    })
    .filter((node): node is CanvasNode => Boolean(node));
}

function normalizeHistory(history?: CanvasHistoryState): CanvasHistoryState {
  if (!history) {
    return { past: [], future: [] };
  }

  const normalizeSnapshot = (snapshot: CanvasHistorySnapshot): CanvasHistorySnapshot => {
    const normalizedNodes = normalizeNodes(snapshot.nodes);
    return {
      nodes: normalizedNodes,
      edges: normalizeEdgesWithNodes(snapshot.edges, normalizedNodes),
    };
  };

  return {
    past: history.past.slice(-MAX_HISTORY_STEPS).map(normalizeSnapshot),
    future: history.future.slice(-MAX_HISTORY_STEPS).map(normalizeSnapshot),
  };
}

function createSnapshot(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasHistorySnapshot {
  return { nodes, edges };
}

function collectNodeIdsWithDescendants(nodes: CanvasNode[], seedIds: string[]): Set<string> {
  const deleteSet = new Set(seedIds);
  let changed = true;

  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!node.parentId || deleteSet.has(node.id)) {
        continue;
      }
      if (deleteSet.has(node.parentId)) {
        deleteSet.add(node.id);
        changed = true;
      }
    }
  }

  return deleteSet;
}

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  return {
    width:
      typeof node.measured?.width === 'number'
        ? node.measured.width
        : typeof node.width === 'number'
          ? node.width
          : DEFAULT_NODE_WIDTH,
    height:
      typeof node.measured?.height === 'number'
        ? node.measured.height
        : typeof node.height === 'number'
          ? node.height
          : 200,
  };
}

function isImageAutoResizableType(type: CanvasNodeType): boolean {
  return type === CANVAS_NODE_TYPES.upload
    || type === CANVAS_NODE_TYPES.imageEdit
    || type === CANVAS_NODE_TYPES.exportImage;
}

function isContextAwareGenerationNode(type: CanvasNodeType): boolean {
  return type === CANVAS_NODE_TYPES.textGeneration
    || type === CANVAS_NODE_TYPES.imageEdit
    || type === CANVAS_NODE_TYPES.videoFrame
    || type === CANVAS_NODE_TYPES.videoSingle
    || type === CANVAS_NODE_TYPES.seedanceAutoVideo
    || type === CANVAS_NODE_TYPES.sd2VideoGen;
}

function withManualSizeLock(node: CanvasNode): CanvasNode {
  const nodeData = node.data as CanvasNodeData & { isSizeManuallyAdjusted?: boolean };
  if (nodeData.isSizeManuallyAdjusted) {
    return node;
  }

  return {
    ...node,
    data: {
      ...node.data,
      isSizeManuallyAdjusted: true,
    } as CanvasNodeData,
  };
}

function resolveAutoImageNodeDimensions(
  aspectRatio: string,
  options?: {
    minWidth?: number;
    minHeight?: number;
  }
): { width: number; height: number } {
  const minWidth = options?.minWidth ?? EXPORT_RESULT_NODE_MIN_WIDTH;
  const minHeight = options?.minHeight ?? EXPORT_RESULT_NODE_MIN_HEIGHT;
  return resolveMinEdgeFittedSize(aspectRatio, { minWidth, minHeight });
}

function resolveGeneratedImageNodeDimensions(
  aspectRatio: string,
  options?: {
    minWidth?: number;
    minHeight?: number;
  }
): { width: number; height: number } {
  const minWidth = options?.minWidth ?? IMAGE_NODE_VISUAL_MIN_EDGE;
  const minHeight = options?.minHeight ?? IMAGE_NODE_VISUAL_MIN_EDGE;

  return resolveFittedImageNodeSize(
    aspectRatio,
    {
      width: EXPORT_RESULT_NODE_DEFAULT_WIDTH,
      height: EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
    },
    { minWidth, minHeight }
  );
}

function resolveDerivedAspectRatio(
  sourceNode: CanvasNode | undefined,
  fallbackAspectRatio: string
): string {
  if (!sourceNode) {
    return fallbackAspectRatio;
  }

  if (sourceNode.type === CANVAS_NODE_TYPES.storyboardGen) {
    const data = sourceNode.data as { requestAspectRatio?: string; aspectRatio?: string };
    const preferred = data.requestAspectRatio && data.requestAspectRatio !== 'auto'
      ? data.requestAspectRatio
      : data.aspectRatio;
    return preferred || fallbackAspectRatio;
  }

  if (sourceNode.type === CANVAS_NODE_TYPES.storyboardSplit) {
    const data = sourceNode.data as { frameAspectRatio?: string; aspectRatio?: string };
    return data.frameAspectRatio || data.aspectRatio || fallbackAspectRatio;
  }

  if (sourceNode.type === CANVAS_NODE_TYPES.imageEdit) {
    const data = sourceNode.data as { requestAspectRatio?: string; aspectRatio?: string };
    const preferred = data.requestAspectRatio && data.requestAspectRatio !== 'auto'
      ? data.requestAspectRatio
      : data.aspectRatio;
    return preferred || fallbackAspectRatio;
  }

  const imageLikeAspect = (sourceNode.data as { aspectRatio?: string }).aspectRatio;
  return imageLikeAspect || fallbackAspectRatio;
}

function maybeApplyImageAutoResize(node: CanvasNode, patch: Partial<CanvasNodeData>): CanvasNode {
  if (!isImageAutoResizableType(node.type)) {
    return node;
  }

  const nodeData = node.data as CanvasNodeData & {
    imageUrl?: string | null;
    aspectRatio?: string;
    isSizeManuallyAdjusted?: boolean;
  };
  const patchData = patch as Partial<CanvasNodeData> & {
    imageUrl?: string | null;
    aspectRatio?: string;
    isSizeManuallyAdjusted?: boolean;
  };

  const hasImageRelatedChange = 'imageUrl' in patchData || 'previewImageUrl' in patchData || 'aspectRatio' in patchData;
  if (!hasImageRelatedChange) {
    return node;
  }

  const isSizeManuallyAdjusted = patchData.isSizeManuallyAdjusted ?? nodeData.isSizeManuallyAdjusted ?? false;
  if (isSizeManuallyAdjusted) {
    return node;
  }

  const nextImageUrl = patchData.imageUrl ?? nodeData.imageUrl;
  if (typeof nextImageUrl !== 'string' || nextImageUrl.trim().length === 0) {
    return node;
  }

  const nextAspectRatio = patchData.aspectRatio ?? nodeData.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const nextSize = node.type === CANVAS_NODE_TYPES.exportImage
    ? resolveGeneratedImageNodeDimensions(nextAspectRatio, {
      minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
      minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
    })
    : resolveAutoImageNodeDimensions(nextAspectRatio);

  return {
    ...node,
    width: nextSize.width,
    height: nextSize.height,
    style: {
      ...(node.style ?? {}),
      width: nextSize.width,
      height: nextSize.height,
    },
  };
}

function resolveAbsolutePosition(
  node: CanvasNode,
  nodeMap: Map<string, CanvasNode>
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let currentParentId = node.parentId;
  const visited = new Set<string>();

  while (currentParentId && !visited.has(currentParentId)) {
    visited.add(currentParentId);
    const parent = nodeMap.get(currentParentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    currentParentId = parent.parentId;
  }

  return { x, y };
}

function pushSnapshot(
  snapshots: CanvasHistorySnapshot[],
  snapshot: CanvasHistorySnapshot,
  preserveCoalescedEdit = false
): CanvasHistorySnapshot[] {
  if (!preserveCoalescedEdit) {
    clearCoalescedEdit();
  }
  const last = snapshots[snapshots.length - 1];
  if (last && last.nodes === snapshot.nodes && last.edges === snapshot.edges) {
    return snapshots;
  }

  const next = [...snapshots, snapshot];
  if (next.length > MAX_HISTORY_STEPS) {
    next.shift();
  }
  return next;
}

function getDerivedNodePosition(nodes: CanvasNode[], sourceNodeId: string): { x: number; y: number } {
  const sourceNode = nodes.find((node) => node.id === sourceNodeId);
  if (!sourceNode) {
    return { x: 100, y: 100 };
  }

  return {
    x: sourceNode.position.x + DEFAULT_NODE_WIDTH + 100,
    y: sourceNode.position.y,
  };
}

function resolveSelectedNodeId(selectedNodeId: string | null, nodes: CanvasNode[]): string | null {
  if (!selectedNodeId) {
    return null;
  }
  return nodes.some((node) => node.id === selectedNodeId) ? selectedNodeId : null;
}

function resolveActiveToolDialog(
  activeToolDialog: ActiveToolDialog | null,
  nodes: CanvasNode[]
): ActiveToolDialog | null {
  if (!activeToolDialog) {
    return null;
  }
  return nodes.some((node) => node.id === activeToolDialog.nodeId) ? activeToolDialog : null;
}

function createDefaultStoryboardExportOptions(): StoryboardExportOptions {
  return {
    showFrameIndex: false,
    showFrameNote: false,
    notePlacement: 'overlay',
    imageFit: 'cover',
    frameIndexPrefix: 'S',
    cellGap: 8,
    outerPadding: 0,
    fontSize: 4,
    backgroundColor: '#0f1115',
    textColor: '#f8fafc',
  };
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  activeToolDialog: null,
  history: { past: [], future: [] },
  dragHistorySnapshot: null,
  currentViewport: { x: 0, y: 0, zoom: 1 },
  canvasViewportSize: { width: 0, height: 0 },
  imageViewer: {
    isOpen: false,
    currentImageUrl: null,
    imageList: [],
    currentIndex: 0,
  },

  onNodesChange: (changes) => {
    set((state) => {
      const removedNodeIds = new Set(
        changes
          .filter((change): change is NodeChange<CanvasNode> & { id: string } =>
            change.type === 'remove' && typeof change.id === 'string'
          )
          .map((change) => change.id)
      );
      const removedEdges = removedNodeIds.size > 0
        ? state.edges.filter(
          (edge) => removedNodeIds.has(edge.source) || removedNodeIds.has(edge.target)
        )
        : [];
      const resizedNodeIds = new Set(
        changes
          .filter(
            (change): change is NodeChange<CanvasNode> & { id: string } =>
              change.type === 'dimensions'
              && 'resizing' in change
              && change.resizing === false
              && typeof change.id === 'string'
          )
          .map((change) => change.id)
      );
      const contextAwareGenerationResizeIds = new Set(
        changes
          .filter(
            (change): change is NodeChange<CanvasNode> & { id: string } =>
              change.type === 'dimensions'
              && 'resizing' in change
              && (
                change.resizing === true
                || (change.resizing === false && change.setAttributes !== true)
              )
              && typeof change.id === 'string'
          )
          .map((change) => change.id)
      );

      let nextNodes = applyNodeChanges<CanvasNode>(changes, state.nodes);
      if (removedEdges.length > 0) {
        nextNodes = pruneImageReferencePromptTokensForEdges(
          nextNodes,
          removedEdges.map((edge) => edge.id)
        );
      }
      const nextEdges = removedEdges.length > 0
        ? state.edges.filter((edge) => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target))
        : state.edges;
      if (resizedNodeIds.size > 0 || contextAwareGenerationResizeIds.size > 0) {
        nextNodes = nextNodes.map((node) => {
          const shouldLockImageSize = resizedNodeIds.has(node.id) && isImageAutoResizableType(node.type);
          const shouldLockContextAwareGenerationSize =
            contextAwareGenerationResizeIds.has(node.id) && isContextAwareGenerationNode(node.type);
          if (!shouldLockImageSize && !shouldLockContextAwareGenerationSize) {
            return node;
          }
          return withManualSizeLock(node);
        });
      }
      const hasMeaningfulChange = changes.some((change) => change.type !== 'select');
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
      const hasInteractionMove = hasDragMove || hasResizeMove;
      const hasInteractionEnd = hasDragEnd || hasResizeEnd;

      let nextHistory = state.history;
      let nextDragHistorySnapshot = state.dragHistorySnapshot;

      if (hasInteractionMove && !nextDragHistorySnapshot) {
        nextDragHistorySnapshot = createSnapshot(state.nodes, state.edges);
      }

      if (hasInteractionEnd) {
        const snapshot = nextDragHistorySnapshot ?? createSnapshot(state.nodes, state.edges);
        nextHistory = {
          past: pushSnapshot(state.history.past, snapshot),
          future: [],
        };
        nextDragHistorySnapshot = null;
      } else if (hasMeaningfulChange && !hasInteractionMove) {
        nextHistory = {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        };
        nextDragHistorySnapshot = null;
      }

      return {
        nodes: nextNodes,
        edges: nextEdges,
        selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, nextNodes),
        activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, nextNodes),
        history: nextHistory,
        dragHistorySnapshot: nextDragHistorySnapshot,
      };
    });
  },

  onEdgesChange: (changes) => {
    set((state) => {
      const nextEdges = applyEdgeChanges<CanvasEdge>(changes, state.edges);
      const removedEdgeIds = changes
        .filter((change): change is EdgeChange<CanvasEdge> & { id: string } =>
          change.type === 'remove'
          && typeof change.id === 'string'
          && state.edges.some((edge) => edge.id === change.id)
        )
        .map((change) => change.id);
      const nextNodes = pruneImageReferencePromptTokensForEdges(state.nodes, removedEdgeIds);
      const hasMeaningfulChange = changes.some((change) => {
        if (change.type === 'select') {
          return false;
        }
        if (change.type === 'add') {
          return true;
        }
        return state.edges.some((edge) => edge.id === change.id);
      });

      if (!hasMeaningfulChange) {
        return { nodes: nextNodes, edges: nextEdges };
      }

      return {
        nodes: nextNodes,
        edges: nextEdges,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  onConnect: (connection) => {
    const sourceHandle = normalizeHandleId(connection.sourceHandle) ?? 'source';
    const targetHandle = normalizeHandleId(connection.targetHandle) ?? 'target';

    logger.info('[CanvasStore onConnect] connection:', {
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
    });

    set((state) => {
      if (!isCanvasProgrammaticConnectionValid(connection, state.nodes, state.edges)) {
        return state;
      }
      // 限制首尾帧节点（videoFrame）的每个 targetHandle 只能连接一条边
      let newEdges = state.edges;

      if (connection.target) {
        const targetNode = state.nodes.find((n) => n.id === connection.target);
        // 检查目标节点是否为 videoFrame 类型
        const isVideoFrame = targetNode?.type === CANVAS_NODE_TYPES.videoFrame;

        if (isVideoFrame && targetHandle) {
          // 对于 videoFrame 节点，删除该 targetHandle 上的已有连接
          const edgesToRemove = state.edges.filter(
            (edge) => edge.target === connection.target && edge.targetHandle === targetHandle
          );
          if (edgesToRemove.length > 0) {
            newEdges = state.edges.filter(
              (edge) => !(edge.target === connection.target && edge.targetHandle === targetHandle)
            );
          }
        }
      }

      const sourceNode = connection.source
        ? state.nodes.find((node) => node.id === connection.source)
        : undefined;
      const edgeData = sourceNode && connection.target
        ? createInputEdgeData(sourceNode, connection.target, newEdges)
        : undefined;

      return {
        edges: addEdge<CanvasEdge>(
          { ...connection, sourceHandle, targetHandle, type: 'disconnectableEdge', data: edgeData },
          newEdges
        ),
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  onConnectBatch: (connections) => {
    if (connections.length === 0) {
      return 0;
    }

    let addedCount = 0;
    set((state) => {
      let nextEdges = state.edges;

      for (const connection of connections) {
        if (!connection.source || !connection.target) {
          continue;
        }
        if (!isCanvasProgrammaticConnectionValid(connection, state.nodes, nextEdges)) {
          continue;
        }

        const sourceHandle = normalizeHandleId(connection.sourceHandle) ?? 'source';
        const targetHandle = normalizeHandleId(connection.targetHandle) ?? 'target';
        const beforeCount = nextEdges.length;
        const sourceNode = state.nodes.find((node) => node.id === connection.source);
        const edgeData = sourceNode
          ? createInputEdgeData(sourceNode, connection.target, nextEdges)
          : undefined;
        nextEdges = addEdge<CanvasEdge>(
          {
            ...connection,
            sourceHandle,
            targetHandle,
            type: 'disconnectableEdge',
            data: edgeData,
          },
          nextEdges
        );
        if (nextEdges.length > beforeCount) {
          addedCount += 1;
        }
      }

      if (addedCount === 0) {
        return state;
      }

      return {
        edges: nextEdges,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });

    return addedCount;
  },

  applyAgentChangeSet: (changeSet) => {
    let result: CanvasChangeApplyResult | null = null;
    set((state) => {
      const applied = applyCanvasChangeSet(
        { nodes: state.nodes, edges: state.edges },
        changeSet
      );
      result = applied.result;
      return {
        nodes: applied.nodes,
        edges: applied.edges,
        selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, applied.nodes),
        activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, applied.nodes),
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
    if (!result) {
      throw new Error('Canvas change set did not produce a result.');
    }
    return result;
  },

  setCanvasData: (nodes, edges, history) => {
    clearCoalescedEdit();
    const normalizedNodes = normalizeNodes(nodes);
    const normalizedEdges = normalizeEdgesWithNodes(edges, normalizedNodes);

    set({
      nodes: normalizedNodes,
      edges: normalizedEdges,
      selectedNodeId: null,
      activeToolDialog: null,
      history: normalizeHistory(history),
      dragHistorySnapshot: null,
    });
  },

  setViewportState: (viewport) => {
    set({ currentViewport: viewport });
  },

  setCanvasViewportSize: (size) => {
    set({ canvasViewportSize: size });
  },

  openImageViewer: (imageUrl, imageList = []) => {
    const list = imageList.length > 0 ? imageList : [imageUrl];
    const index = list.indexOf(imageUrl);
    set({
      imageViewer: {
        isOpen: true,
        currentImageUrl: imageUrl,
        imageList: list,
        currentIndex: index >= 0 ? index : 0,
      },
    });
  },

  closeImageViewer: () => {
    set({
      imageViewer: {
        isOpen: false,
        currentImageUrl: null,
        imageList: [],
        currentIndex: 0,
      },
    });
  },

  navigateImageViewer: (direction) => {
    const state = get();
    const { currentIndex, imageList } = state.imageViewer;
    if (direction === 'prev' && currentIndex > 0) {
      const newIndex = currentIndex - 1;
      set({
        imageViewer: {
          ...state.imageViewer,
          currentIndex: newIndex,
          currentImageUrl: imageList[newIndex],
        },
      });
    } else if (direction === 'next' && currentIndex < imageList.length - 1) {
      const newIndex = currentIndex + 1;
      set({
        imageViewer: {
          ...state.imageViewer,
          currentIndex: newIndex,
          currentImageUrl: imageList[newIndex],
        },
      });
    }
  },

  addNode: (type, position, data = {}) => {
    const state = get();
    const newNode = canvasNodeFactory.createNode(
      type,
      position,
      applyDefaultDisplayName(type, applyNodeModelDefaults(type, data), state.nodes)
    );
    set({
      nodes: [...state.nodes, newNode],
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });
    return newNode.id;
  },

  addNodeBatch: (nodeInputs) => {
    if (nodeInputs.length === 0) {
      return [];
    }
    const state = get();
    let imageNodeOffset = 0;
    const newNodes = nodeInputs.map(({ type, position, data = {}, width, height }) => {
      const node = canvasNodeFactory.createNode(
        type,
        position,
        applyDefaultDisplayName(
          type,
          applyNodeModelDefaults(type, data),
          state.nodes,
          imageNodeOffset
        )
      );
      if (type === CANVAS_NODE_TYPES.imageEdit) {
        imageNodeOffset += 1;
      }
      const hasExplicitSize =
        typeof width === 'number' && Number.isFinite(width) && width > 1
        && typeof height === 'number' && Number.isFinite(height) && height > 1;
      if (!hasExplicitSize) {
        return node;
      }
      const resolvedWidth = Math.round(width);
      const resolvedHeight = Math.round(height);
      return {
        ...node,
        width: resolvedWidth,
        height: resolvedHeight,
        style: {
          ...(node.style ?? {}),
          width: resolvedWidth,
          height: resolvedHeight,
        },
      };
    });
    set({
      nodes: [...state.nodes, ...newNodes],
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });
    return newNodes.map((node) => node.id);
  },

  addEdge: (source, target) => {
    const state = get();
    // Check if both nodes exist
    const sourceNode = state.nodes.find((n) => n.id === source);
    const targetNode = state.nodes.find((n) => n.id === target);
    if (!sourceNode || !targetNode) {
      return null;
    }
    if (!nodeHasSourceHandle(sourceNode.type) || !nodeHasTargetHandle(targetNode.type)) {
      return null;
    }

    const connection: Connection = {
      source,
      target,
      sourceHandle: 'source',
      targetHandle: 'target',
    };
    if (!isCanvasProgrammaticConnectionValid(connection, state.nodes, state.edges)) {
      return null;
    }

    const edgeId = `e-${source}-${target}`;
    // Check if edge already exists
    if (state.edges.some((e) => e.id === edgeId)) {
      return edgeId;
    }

    const newEdge: CanvasEdge = {
      id: edgeId,
      source,
      target,
      sourceHandle: 'source',
      targetHandle: 'target',
      type: 'disconnectableEdge',
      data: createInputEdgeData(sourceNode, target, state.edges),
    };

    set({
      edges: [...state.edges, newEdge],
    });

    return edgeId;
  },

  connectNodesSequentially: (nodeIds) => {
    if (nodeIds.length < 2) {
      return [];
    }

    const state = get();
    const addedEdgeIds: string[] = [];

    for (let i = 0; i < nodeIds.length - 1; i++) {
      const sourceId = nodeIds[i];
      const targetId = nodeIds[i + 1];
      const edgeId = `e-${sourceId}-${targetId}`;

      // Skip if edge already exists
      if (state.edges.some((e) => e.id === edgeId)) {
        continue;
      }

      const sourceNode = state.nodes.find((n) => n.id === sourceId);
      const targetNode = state.nodes.find((n) => n.id === targetId);

      if (!sourceNode || !targetNode) {
        continue;
      }

      if (!nodeHasSourceHandle(sourceNode.type) || !nodeHasTargetHandle(targetNode.type)) {
        continue;
      }

      const connection: Connection = {
        source: sourceId,
        target: targetId,
        sourceHandle: 'source',
        targetHandle: 'target',
      };
      if (!isCanvasProgrammaticConnectionValid(connection, get().nodes, get().edges)) {
        continue;
      }

      const newEdge: CanvasEdge = {
        id: edgeId,
        source: sourceId,
        target: targetId,
        sourceHandle: 'source',
        targetHandle: 'target',
        type: 'disconnectableEdge',
        data: createInputEdgeData(sourceNode, targetId, get().edges),
      };

      set((s) => ({
        edges: [...s.edges, newEdge],
      }));

      addedEdgeIds.push(edgeId);
    }

    return addedEdgeIds;
  },

  autoLayoutNodes: (nodeIds, direction = 'grid', gap = 80) => {
    if (nodeIds.length < 2) {
      return;
    }

    const state = get();
    const nodesToLayout = state.nodes.filter((n) => nodeIds.includes(n.id));
    if (nodesToLayout.length < 2) {
      return;
    }

    // Calculate bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodesToLayout) {
      const width = node.measured?.width ?? DEFAULT_NODE_WIDTH;
      const height = node.measured?.height ?? 200;
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + width);
      maxY = Math.max(maxY, node.position.y + height);
    }

    // Sort nodes by position for consistent layout
    const sortedNodes = [...nodesToLayout].sort((a, b) => {
      if (direction === 'horizontal') {
        return a.position.x - b.position.x;
      } else if (direction === 'vertical') {
        return a.position.y - b.position.y;
      }
      // For grid, sort by y first then x
      if (Math.abs(a.position.y - b.position.y) < 50) {
        return a.position.x - b.position.x;
      }
      return a.position.y - b.position.y;
    });

    const updates: { id: string; position: { x: number; y: number } }[] = [];
    let currentX = minX;
    let currentY = minY;
    let rowMaxHeight = 0;
    let colMaxWidth = 0;
    const colCount = direction === 'vertical' ? 1 : Math.ceil(Math.sqrt(sortedNodes.length));

    for (let i = 0; i < sortedNodes.length; i++) {
      const node = sortedNodes[i];
      const width = node.measured?.width ?? DEFAULT_NODE_WIDTH;
      const height = node.measured?.height ?? 200;

      if (direction === 'grid' && i > 0 && i % colCount === 0) {
        currentX = minX;
        currentY += rowMaxHeight + gap;
        rowMaxHeight = 0;
      }

      updates.push({
        id: node.id,
        position: { x: currentX, y: currentY },
      });

      if (direction === 'vertical') {
        currentY += height + gap;
      } else {
        currentX += width + gap;
        rowMaxHeight = Math.max(rowMaxHeight, height);
      }
      colMaxWidth = Math.max(colMaxWidth, width);
    }

    if (updates.length > 0) {
      set((s) => ({
        nodes: s.nodes.map((node) => {
          const update = updates.find((u) => u.id === node.id);
          if (update) {
            return { ...node, position: update.position };
          }
          return node;
        }),
      }));
    }
  },

  findNodePosition: (sourceNodeId, newNodeWidth, newNodeHeight) => {
    const state = get();
    const sourceNode = state.nodes.find((n) => n.id === sourceNodeId);
    if (!sourceNode) {
      return { x: 100, y: 100 };
    }

    // Helper to check if a position collides with existing nodes.
    const collides = (x: number, y: number, width: number, height: number) => {
      return state.nodes.some((node) => {
        const nodeWidth = node.measured?.width ?? DEFAULT_NODE_WIDTH;
        const nodeHeight = node.measured?.height ?? 200;
        const margin = 8;
        return (
          x < node.position.x + nodeWidth + margin &&
          x + width + margin > node.position.x &&
          y < node.position.y + nodeHeight + margin &&
          y + height + margin > node.position.y
        );
      });
    };

    const sourceWidth = sourceNode.measured?.width ?? DEFAULT_NODE_WIDTH;
    const sourceHeight = sourceNode.measured?.height ?? 200;
    const anchorX = sourceNode.position.x + sourceWidth + 28;
    const anchorY = sourceNode.position.y;

    const zoom = Math.max(0.01, state.currentViewport.zoom || 1);
    const viewportWidth = state.canvasViewportSize.width;
    const viewportHeight = state.canvasViewportSize.height;
    const hasViewportBounds = viewportWidth > 0 && viewportHeight > 0;
    const visibleBounds = hasViewportBounds
      ? {
          minX: -state.currentViewport.x / zoom,
          minY: -state.currentViewport.y / zoom,
          maxX: -state.currentViewport.x / zoom + viewportWidth / zoom,
          maxY: -state.currentViewport.y / zoom + viewportHeight / zoom,
        }
      : null;

    const overflowAmount = (x: number, y: number): number => {
      if (!visibleBounds) {
        return 0;
      }
      const overLeft = Math.max(0, visibleBounds.minX - x);
      const overTop = Math.max(0, visibleBounds.minY - y);
      const overRight = Math.max(0, x + newNodeWidth - visibleBounds.maxX);
      const overBottom = Math.max(0, y + newNodeHeight - visibleBounds.maxY);
      return overLeft + overTop + overRight + overBottom;
    };

    const stepX = Math.max(newNodeWidth + 12, 110);
    const stepY = Math.max(Math.round(newNodeHeight * 0.35), 54);
    const baseCandidates = [
      { x: anchorX, y: anchorY },
      { x: sourceNode.position.x, y: sourceNode.position.y + sourceHeight + 20 },
      { x: sourceNode.position.x - newNodeWidth - 20, y: sourceNode.position.y },
      { x: sourceNode.position.x, y: sourceNode.position.y - newNodeHeight - 20 },
    ];

    let bestInView: { x: number; y: number; score: number } | null = null;
    let bestOutOfView: { x: number; y: number; score: number } | null = null;

    const evaluateCandidate = (x: number, y: number) => {
      if (collides(x, y, newNodeWidth, newNodeHeight)) {
        return;
      }

      const dx = x - anchorX;
      const dy = y - anchorY;
      const distanceScore = Math.hypot(dx, dy);
      const upwardPenalty = dy < 0 ? Math.abs(dy) * 0.25 : 0;
      const overflow = overflowAmount(x, y);
      const score = distanceScore + upwardPenalty + overflow * 1000;
      const candidate = { x, y, score };

      if (overflow === 0) {
        if (!bestInView || score < bestInView.score) {
          bestInView = candidate;
        }
      } else if (!bestOutOfView || score < bestOutOfView.score) {
        bestOutOfView = candidate;
      }
    };

    for (const base of baseCandidates) {
      evaluateCandidate(base.x, base.y);
    }

    for (let ring = 1; ring <= 8; ring += 1) {
      const offsets = [
        { x: ring, y: 0 },
        { x: ring, y: 1 },
        { x: ring, y: -1 },
        { x: 0, y: ring },
        { x: 0, y: -ring },
        { x: -ring, y: 0 },
        { x: ring, y: 2 },
        { x: ring, y: -2 },
        { x: -ring, y: 1 },
        { x: -ring, y: -1 },
      ];
      for (const offset of offsets) {
        evaluateCandidate(anchorX + offset.x * stepX, anchorY + offset.y * stepY);
      }
    }

    // If ring sampling misses an available slot in current viewport,
    // run a denser viewport sweep before falling back outside view.
    if (!bestInView && visibleBounds) {
      const padding = 8;
      const minX = visibleBounds.minX + padding;
      const maxX = visibleBounds.maxX - newNodeWidth - padding;
      const minY = visibleBounds.minY + padding;
      const maxY = visibleBounds.maxY - newNodeHeight - padding;

      if (maxX >= minX && maxY >= minY) {
        const scanStepX = Math.max(42, Math.round(newNodeWidth * 0.32));
        const scanStepY = Math.max(42, Math.round(newNodeHeight * 0.32));

        for (let y = minY; y <= maxY; y += scanStepY) {
          for (let x = minX; x <= maxX; x += scanStepX) {
            evaluateCandidate(x, y);
          }
        }

        // Ensure boundary positions are also considered.
        evaluateCandidate(minX, minY);
        evaluateCandidate(maxX, minY);
        evaluateCandidate(minX, maxY);
        evaluateCandidate(maxX, maxY);
      }
    }

    const resolvedCandidate = (bestInView || bestOutOfView) as
      | { x: number; y: number; score: number }
      | null;
    if (resolvedCandidate) {
      return { x: resolvedCandidate.x, y: resolvedCandidate.y };
    }

    return { x: anchorX + 2 * stepX, y: anchorY };
  },

  arrangeNodesSequentially: (sourceNodeId, newNodeIds, direction = 'vertical') => {
    const state = get();
    const sourceNode = state.nodes.find((n) => n.id === sourceNodeId);
    if (!sourceNode || newNodeIds.length === 0) {
      return;
    }

    const DEFAULT_NODE_WIDTH = 280;
    const DEFAULT_NODE_HEIGHT = 200;
    const GAP = 40;

    const sourceWidth = sourceNode.measured?.width ?? DEFAULT_NODE_WIDTH;
    const sourceHeight = sourceNode.measured?.height ?? DEFAULT_NODE_HEIGHT;

    const updates: { id: string; position: { x: number; y: number } }[] = [];

    if (direction === 'horizontal') {
      let currentX = sourceNode.position.x + sourceWidth + GAP;
      const startY = sourceNode.position.y;
      newNodeIds.forEach((nodeId, index) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          const nodeHeight = node.measured?.height ?? DEFAULT_NODE_HEIGHT;
          updates.push({
            id: nodeId,
            position: { x: currentX, y: startY + index * (nodeHeight + GAP) },
          });
        }
      });
    } else {
      let currentY = sourceNode.position.y + sourceHeight + GAP;
      const startX = sourceNode.position.x + sourceWidth + GAP;
      newNodeIds.forEach((nodeId, index) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node) {
          const nodeWidth = node.measured?.width ?? DEFAULT_NODE_WIDTH;
          updates.push({
            id: nodeId,
            position: { x: startX + index * (nodeWidth + GAP), y: currentY },
          });
        }
      });
    }

    if (updates.length > 0) {
      set((s) => ({
        nodes: s.nodes.map((node) => {
          const update = updates.find((u) => u.id === node.id);
          if (update) {
            return { ...node, position: update.position };
          }
          return node;
        }),
      }));
    }
  },

  addDerivedUploadNode: (sourceNodeId, imageUrl, aspectRatio, previewImageUrl) => {
    const state = get();
    const position = getDerivedNodePosition(state.nodes, sourceNodeId);
    const sourceNode = state.nodes.find((node) => node.id === sourceNodeId);
    const resolvedAspectRatio = resolveDerivedAspectRatio(sourceNode, aspectRatio);
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, position, {
      imageUrl,
      previewImageUrl: previewImageUrl ?? null,
      aspectRatio: resolvedAspectRatio,
    });
    const derivedSize = resolveGeneratedImageNodeDimensions(resolvedAspectRatio);
    node.width = derivedSize.width;
    node.height = derivedSize.height;
    node.style = {
      ...(node.style ?? {}),
      width: derivedSize.width,
      height: derivedSize.height,
    };

    set({
      nodes: [...state.nodes, node],
      selectedNodeId: node.id,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return node.id;
  },

  addDerivedExportNode: (sourceNodeId, imageUrl, aspectRatio, previewImageUrl, options) => {
    const state = get();
    const sourceNode = state.nodes.find((node) => node.id === sourceNodeId);
    const aspectRatioStrategy = options?.aspectRatioStrategy ?? 'provided';
    const resolvedAspectRatio = aspectRatioStrategy === 'derivedFromSource'
      ? resolveDerivedAspectRatio(sourceNode, aspectRatio)
      : (aspectRatio || resolveDerivedAspectRatio(sourceNode, DEFAULT_ASPECT_RATIO));
    const autoSize = resolveAutoImageNodeDimensions(resolvedAspectRatio, {
      minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
      minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
    });
    const generatedSize = resolveGeneratedImageNodeDimensions(resolvedAspectRatio, {
      minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
      minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
    });
    const sourceSize = sourceNode ? getNodeSize(sourceNode) : null;
    const sizeStrategy = options?.sizeStrategy
      ?? (options?.matchSourceNodeSize ? 'matchSource' : 'generated');
    let derivedSize = generatedSize;
    if (sizeStrategy === 'autoMinEdge') {
      derivedSize = autoSize;
    } else if (sizeStrategy === 'matchSource' && sourceSize) {
      derivedSize = {
        width: Math.max(1, Math.round(sourceSize.width)),
        height: Math.max(1, Math.round(sourceSize.height)),
      };
    }
    const position = state.findNodePosition(
      sourceNodeId,
      derivedSize.width,
      derivedSize.height
    );
    const exportNodeData: Partial<CanvasNodeData> = {
      imageUrl,
      previewImageUrl: previewImageUrl ?? null,
      aspectRatio: resolvedAspectRatio,
    };
    if (options?.defaultTitle) {
      (exportNodeData as { displayName?: string }).displayName = options.defaultTitle;
    }
    if (options?.resultKind) {
      (exportNodeData as { resultKind?: ExportImageNodeResultKind }).resultKind = options.resultKind;
      if (!options.defaultTitle) {
        (exportNodeData as { displayName?: string }).displayName =
          EXPORT_RESULT_DISPLAY_NAME[options.resultKind];
      }
    }
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.exportImage, position, {
      ...exportNodeData,
    });
    node.width = derivedSize.width;
    node.height = derivedSize.height;
    node.style = {
      ...(node.style ?? {}),
      width: derivedSize.width,
      height: derivedSize.height,
    };

    set({
      nodes: [...state.nodes, node],
      selectedNodeId: node.id,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return node.id;
  },

  addStoryboardSplitNode: (sourceNodeId, rows, cols, frames, frameAspectRatio) => {
    const state = get();
    const position = getDerivedNodePosition(state.nodes, sourceNodeId);
    const resolvedFrameAspectRatio =
      frameAspectRatio ??
      frames.find((frame) => typeof frame.aspectRatio === 'string')?.aspectRatio ??
      DEFAULT_ASPECT_RATIO;

    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.storyboardSplit, position, {
      gridRows: rows,
      gridCols: cols,
      frames,
      aspectRatio: resolvedFrameAspectRatio,
      frameAspectRatio: resolvedFrameAspectRatio,
      exportOptions: createDefaultStoryboardExportOptions(),
    });

    set({
      nodes: [...state.nodes, node],
      selectedNodeId: node.id,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return node.id;
  },

  updateNodeData: (nodeId, data) => {
    clearCoalescedEdit();
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        const hasDataChange = Object.entries(data).some(([key, nextValue]) => {
          const previousValue = (node.data as Record<string, unknown>)[key];
          return !Object.is(previousValue, nextValue);
        });
        if (!hasDataChange) {
          return node;
        }

        const mergedData = {
          ...node.data,
          ...data,
        } as CanvasNodeData;
        const resizedNode = maybeApplyImageAutoResize(
          {
            ...node,
            data: mergedData,
          },
          data
        );

        changed = true;
        return resizedNode;
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  updateNodeDataWithoutHistory: (nodeId, data) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        const hasDataChange = Object.entries(data).some(([key, nextValue]) => {
          const previousValue = (node.data as Record<string, unknown>)[key];
          return !Object.is(previousValue, nextValue);
        });
        if (!hasDataChange) {
          return node;
        }

        changed = true;
        return {
          ...node,
          data: {
            ...node.data,
            ...data,
          } as CanvasNodeData,
        };
      });

      return changed ? { nodes: nextNodes } : {};
    });
  },

  updateNodeDataCoalesced: (nodeId, data, historyGroup) => {
    const editKey = `${nodeId}:${historyGroup}`;
    const now = Date.now();
    const shouldRecordHistory = activeCoalescedEdit?.key !== editKey
      || activeCoalescedEdit.expiresAt <= now;
    activeCoalescedEdit = {
      key: editKey,
      expiresAt: now + COALESCED_EDIT_WINDOW_MS,
    };

    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }
        const hasDataChange = Object.entries(data).some(([key, nextValue]) =>
          !Object.is((node.data as Record<string, unknown>)[key], nextValue)
        );
        if (!hasDataChange) {
          return node;
        }
        changed = true;
        return {
          ...node,
          data: { ...node.data, ...data } as CanvasNodeData,
        };
      });
      if (!changed) {
        return {};
      }
      return {
        nodes: nextNodes,
        ...(shouldRecordHistory ? {
          history: {
            past: pushSnapshot(
              state.history.past,
              createSnapshot(state.nodes, state.edges),
              true
            ),
            future: [],
          },
          dragHistorySnapshot: null,
        } : {}),
      };
    });
  },

  reorderNodeInput: (nodeId, valueType, draggedSourceId, targetSourceId) => {
    if (draggedSourceId === targetSourceId) {
      return false;
    }

    let reordered = false;
    set((state) => {
      const matchingEdges = state.edges
        .filter((edge) => edge.target === nodeId && edge.data?.valueType === valueType)
        .sort((left, right) => Number(left.data?.inputOrder) - Number(right.data?.inputOrder));
      const draggedIndex = matchingEdges.findIndex((edge) => edge.source === draggedSourceId);
      const targetIndex = matchingEdges.findIndex((edge) => edge.source === targetSourceId);
      if (draggedIndex < 0 || targetIndex < 0) {
        return {};
      }

      const reorderedEdges = [...matchingEdges];
      const [draggedEdge] = reorderedEdges.splice(draggedIndex, 1);
      reorderedEdges.splice(targetIndex, 0, draggedEdge);
      const orderByEdgeId = new Map(reorderedEdges.map((edge, index) => [edge.id, index]));
      const nextEdges = state.edges.map((edge) => {
        const inputOrder = orderByEdgeId.get(edge.id);
        return inputOrder === undefined
          ? edge
          : { ...edge, data: { ...edge.data, valueType, inputOrder } };
      });
      reordered = true;
      return {
        edges: nextEdges,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
    return reordered;
  },

  updateNodePosition: (nodeId, position) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        if (node.position.x === position.x && node.position.y === position.y) {
          return node;
        }

        changed = true;
        return {
          ...node,
          position,
        };
      });

      if (!changed) {
        return {};
      }

      return { nodes: nextNodes };
    });
  },

  updateStoryboardFrame: (nodeId, frameId, data) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId || !isStoryboardSplitNode(node)) {
          return node;
        }

        const nextFrames = node.data.frames.map((frame) => {
          if (frame.id !== frameId) {
            return frame;
          }

          const patchEntries = Object.entries(data) as Array<
            [keyof StoryboardFrameItem, StoryboardFrameItem[keyof StoryboardFrameItem]]
          >;
          const hasFrameChange = patchEntries.some(([key, nextValue]) =>
            !Object.is(frame[key], nextValue)
          );
          if (!hasFrameChange) {
            return frame;
          }

          changed = true;
          return {
            ...frame,
            ...data,
          };
        });

        return {
          ...node,
          data: {
            ...node.data,
            frames: nextFrames,
          },
        };
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  reorderStoryboardFrame: (nodeId, draggedFrameId, targetFrameId) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId || !isStoryboardSplitNode(node)) {
          return node;
        }

        const frames = [...node.data.frames].sort((a, b) => a.order - b.order);
        const fromIndex = frames.findIndex((frame) => frame.id === draggedFrameId);
        const toIndex = frames.findIndex((frame) => frame.id === targetFrameId);

        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
          return node;
        }

        changed = true;
        const [movedFrame] = frames.splice(fromIndex, 1);
        frames.splice(toIndex, 0, movedFrame);

        return {
          ...node,
          data: {
            ...node.data,
            frames: frames.map((frame, index) => ({
              ...frame,
              order: index,
            })),
          },
        };
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  deleteNode: (nodeId) => {
    get().deleteNodes([nodeId]);
  },

  deleteNodes: (nodeIds) => {
    const uniqueIds = Array.from(new Set(nodeIds.filter((nodeId) => nodeId.trim().length > 0)));
    if (uniqueIds.length === 0) {
      return;
    }

    set((state) => {
      const existingIds = uniqueIds.filter((nodeId) => state.nodes.some((node) => node.id === nodeId));
      if (existingIds.length === 0) {
        return {};
      }

      const deleteSet = collectNodeIdsWithDescendants(state.nodes, existingIds);
      const removedEdges = state.edges.filter(
        (edge) => deleteSet.has(edge.source) || deleteSet.has(edge.target)
      );
      const remainingNodes = state.nodes.filter((node) => !deleteSet.has(node.id));
      const nextNodes = pruneImageReferencePromptTokensForEdges(
        remainingNodes,
        removedEdges.map((edge) => edge.id)
      );
      const nextEdges = state.edges.filter(
        (edge) => !deleteSet.has(edge.source) && !deleteSet.has(edge.target)
      );

      return {
        nodes: nextNodes,
        edges: nextEdges,
        selectedNodeId:
          state.selectedNodeId && deleteSet.has(state.selectedNodeId) ? null : state.selectedNodeId,
        activeToolDialog:
          state.activeToolDialog && deleteSet.has(state.activeToolDialog.nodeId)
            ? null
            : state.activeToolDialog,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  groupNodes: (nodeIds) => {
    const uniqueIds = Array.from(new Set(nodeIds.filter((nodeId) => nodeId.trim().length > 0)));
    if (uniqueIds.length < 2) {
      return null;
    }

    const state = get();
    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const existingIds = uniqueIds.filter((nodeId) => nodeMap.has(nodeId));
    if (existingIds.length < 2) {
      return null;
    }

    const selectedSet = new Set(existingIds);
    const memberIds = existingIds.filter((nodeId) => {
      let currentParentId = nodeMap.get(nodeId)?.parentId;
      const visited = new Set<string>();
      while (currentParentId && !visited.has(currentParentId)) {
        if (selectedSet.has(currentParentId)) {
          return false;
        }
        visited.add(currentParentId);
        currentParentId = nodeMap.get(currentParentId)?.parentId;
      }
      return true;
    });
    if (memberIds.length < 2) {
      return null;
    }

    const memberSet = new Set(memberIds);
    const members = memberIds
      .map((id) => nodeMap.get(id))
      .filter((node): node is CanvasNode => Boolean(node));

    const absoluteBounds = members.reduce(
      (acc, node) => {
        const absolute = resolveAbsolutePosition(node, nodeMap);
        const size = getNodeSize(node);
        return {
          minX: Math.min(acc.minX, absolute.x),
          minY: Math.min(acc.minY, absolute.y),
          maxX: Math.max(acc.maxX, absolute.x + size.width),
          maxY: Math.max(acc.maxY, absolute.y + size.height),
        };
      },
      {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      }
    );

    if (!Number.isFinite(absoluteBounds.minX) || !Number.isFinite(absoluteBounds.minY)) {
      return null;
    }

    const SIDE_PADDING = 20;
    const TOP_PADDING = 34;
    const BOTTOM_PADDING = 20;
    const groupX = Math.round(absoluteBounds.minX - SIDE_PADDING);
    const groupY = Math.round(absoluteBounds.minY - TOP_PADDING);
    const groupWidth = Math.round(
      Math.max(220, absoluteBounds.maxX - absoluteBounds.minX + SIDE_PADDING * 2)
    );
    const groupHeight = Math.round(
      Math.max(140, absoluteBounds.maxY - absoluteBounds.minY + TOP_PADDING + BOTTOM_PADDING)
    );

    const existingGroupCount = state.nodes.filter((node) => node.type === CANVAS_NODE_TYPES.group).length;
    const groupDisplayName = `组 ${existingGroupCount + 1}`;
    const groupNode = canvasNodeFactory.createNode(
      CANVAS_NODE_TYPES.group,
      { x: groupX, y: groupY },
      {
        label: groupDisplayName,
        displayName: groupDisplayName,
      }
    );
    groupNode.style = { width: groupWidth, height: groupHeight };
    groupNode.selected = true;

    const updatedMemberMap = new Map<string, CanvasNode>();
    for (const node of members) {
      const absolute = resolveAbsolutePosition(node, nodeMap);
      updatedMemberMap.set(node.id, {
        ...node,
        parentId: groupNode.id,
        extent: 'parent',
        position: {
          x: Math.round(absolute.x - groupX),
          y: Math.round(absolute.y - groupY),
        },
        selected: false,
      });
    }

    const firstMemberIndex = state.nodes.reduce((acc, node, index) => {
      if (!memberSet.has(node.id)) {
        return acc;
      }
      return acc === -1 ? index : Math.min(acc, index);
    }, -1);

    const nextNodes: CanvasNode[] = [];
    let insertedGroup = false;
    for (let index = 0; index < state.nodes.length; index += 1) {
      const node = state.nodes[index];
      if (!insertedGroup && index === firstMemberIndex) {
        nextNodes.push(groupNode);
        insertedGroup = true;
      }

      const updatedMember = updatedMemberMap.get(node.id);
      if (updatedMember) {
        nextNodes.push(updatedMember);
      } else {
        nextNodes.push({
          ...node,
          selected: false,
        });
      }
    }

    if (!insertedGroup) {
      nextNodes.push(groupNode);
    }

    set({
      nodes: nextNodes,
      selectedNodeId: groupNode.id,
      activeToolDialog:
        state.activeToolDialog && memberSet.has(state.activeToolDialog.nodeId)
          ? null
          : state.activeToolDialog,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return groupNode.id;
  },

  ungroupNode: (groupNodeId) => {
    const state = get();
    const groupNode = state.nodes.find(
      (node) => node.id === groupNodeId && node.type === CANVAS_NODE_TYPES.group
    );
    if (!groupNode) {
      return false;
    }

    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const children = state.nodes.filter((node) => node.parentId === groupNodeId);
    if (children.length === 0) {
      return false;
    }

    const nextNodes = state.nodes
      .filter((node) => node.id !== groupNodeId)
      .map((node) => {
        if (node.parentId !== groupNodeId) {
          return node;
        }

        const absolute = resolveAbsolutePosition(node, nodeMap);
        return {
          ...node,
          parentId: undefined,
          extent: undefined,
          position: {
            x: Math.round(absolute.x),
            y: Math.round(absolute.y),
          },
          selected: false,
        };
      });

    const nextEdges = state.edges.filter(
      (edge) => edge.source !== groupNodeId && edge.target !== groupNodeId
    );

    set({
      nodes: nextNodes,
      edges: nextEdges,
      selectedNodeId: state.selectedNodeId === groupNodeId ? null : state.selectedNodeId,
      activeToolDialog:
        state.activeToolDialog?.nodeId === groupNodeId ? null : state.activeToolDialog,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
    });

    return true;
  },

  deleteEdge: (edgeId) => {
    set((state) => {
      const hasEdge = state.edges.some((edge) => edge.id === edgeId);
      if (!hasEdge) {
        return {};
      }

      return {
        nodes: pruneImageReferencePromptTokensForEdges(state.nodes, [edgeId]),
        edges: state.edges.filter((edge) => edge.id !== edgeId),
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },

  setSelectedNode: (nodeId) => {
    set({ selectedNodeId: nodeId });
  },

  openToolDialog: (dialog) => {
    set({ activeToolDialog: dialog });
  },

  closeToolDialog: () => {
    set({ activeToolDialog: null });
  },

  undo: () => {
    clearCoalescedEdit();
    const state = get();
    const target = state.history.past[state.history.past.length - 1];
    if (!target) {
      return false;
    }

    const currentSnapshot = createSnapshot(state.nodes, state.edges);
    const nextPast = state.history.past.slice(0, -1);

    set({
      nodes: target.nodes,
      edges: target.edges,
      selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, target.nodes),
      activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, target.nodes),
      history: {
        past: nextPast,
        future: pushSnapshot(state.history.future, currentSnapshot),
      },
      dragHistorySnapshot: null,
    });
    return true;
  },

  redo: () => {
    clearCoalescedEdit();
    const state = get();
    const target = state.history.future[state.history.future.length - 1];
    if (!target) {
      return false;
    }

    const currentSnapshot = createSnapshot(state.nodes, state.edges);
    const nextFuture = state.history.future.slice(0, -1);

    set({
      nodes: target.nodes,
      edges: target.edges,
      selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, target.nodes),
      activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, target.nodes),
      history: {
        past: pushSnapshot(state.history.past, currentSnapshot),
        future: nextFuture,
      },
      dragHistorySnapshot: null,
    });
    return true;
  },

  clearCanvas: () => {
    set((state) => {
      if (state.nodes.length === 0 && state.edges.length === 0) {
        return {};
      }

      return {
        nodes: [],
        edges: [],
        selectedNodeId: null,
        activeToolDialog: null,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
      };
    });
  },
}));
