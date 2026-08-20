import {
  CANVAS_NODE_TYPES,
  VIDEO_RESULT_NODE_DEFAULT_HEIGHT,
  VIDEO_RESULT_NODE_DEFAULT_WIDTH,
  VIDEO_RESULT_NODE_MIN_HEIGHT,
  VIDEO_RESULT_NODE_MIN_WIDTH,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type ExportVideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveFittedImageNodeSize, type ImageNodeSize } from './imageNodeSizing';
import { resolveImageResultBatchPositions } from './imageResultPlacement';

export function resolveVideoResultNodeSize(aspectRatio: string): ImageNodeSize {
  return resolveFittedImageNodeSize(
    aspectRatio,
    {
      width: VIDEO_RESULT_NODE_DEFAULT_WIDTH,
      height: VIDEO_RESULT_NODE_DEFAULT_HEIGHT,
    },
    {
      minWidth: VIDEO_RESULT_NODE_MIN_WIDTH,
      minHeight: VIDEO_RESULT_NODE_MIN_HEIGHT,
    }
  );
}

interface CreateVideoOutputNodeInput {
  sourceNodeId: string;
  data: Partial<ExportVideoNodeData>;
  existingNodes: readonly CanvasNode[];
  existingEdges: readonly CanvasEdge[];
  addNodeBatch: (nodes: Array<{
    type: typeof CANVAS_NODE_TYPES.exportVideo;
    position: { x: number; y: number };
    data?: Partial<CanvasNodeData>;
    width?: number;
    height?: number;
  }>) => string[];
  addEdge: (source: string, target: string) => string | null;
}

/** Creates a size-aware video result in the source node's deterministic result lane. */
export function createVideoOutputNode({
  sourceNodeId,
  data,
  existingNodes,
  existingEdges,
  addNodeBatch,
  addEdge,
}: CreateVideoOutputNodeInput): string | null {
  const aspectRatio = typeof data.aspectRatio === 'string' && data.aspectRatio.trim()
    ? data.aspectRatio
    : '16:9';
  const size = resolveVideoResultNodeSize(aspectRatio);
  const placement = resolveImageResultBatchPositions({
    sourceNodeId,
    nodes: existingNodes,
    edges: existingEdges,
    resultSize: size,
    resultCount: 1,
    resultNodeType: CANVAS_NODE_TYPES.exportVideo,
  })[0];

  if (!placement) {
    return null;
  }

  const [nodeId] = addNodeBatch([{
    type: CANVAS_NODE_TYPES.exportVideo,
    position: placement.position,
    width: size.width,
    height: size.height,
    data: {
      ...data,
      aspectRatio,
      generationLaneSlot: placement.laneSlot,
    },
  }]);

  if (!nodeId) {
    return null;
  }

  addEdge(sourceNodeId, nodeId);
  return nodeId;
}
