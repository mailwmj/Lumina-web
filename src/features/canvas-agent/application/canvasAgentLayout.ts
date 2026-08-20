import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type CanvasNode,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';

export interface CanvasAgentLayoutItem {
  key: string;
  width?: number;
  height?: number;
  nodeType?: CanvasNodeType;
}

export interface CanvasAgentLayoutPlacement {
  key: string;
  position: { x: number; y: number };
  width: number;
  height: number;
}

const COLUMN_GAP = 160;
const ROW_GAP = 72;
const EMPTY_CANVAS_ORIGIN = { x: 120, y: 120 };

export function resolveCanvasAgentColumnLayout(
  nodes: readonly CanvasNode[],
  items: readonly CanvasAgentLayoutItem[],
  anchor?: { x: number; y: number }
): CanvasAgentLayoutPlacement[] {
  if (items.length === 0) {
    return [];
  }

  const measuredNodes = nodes.map((node) => ({
    x: node.position.x,
    y: node.position.y,
    width: resolveNodeWidth(node),
    height: resolveNodeHeight(node),
  }));
  const columnX = anchor?.x ?? (
    measuredNodes.length > 0
      ? Math.max(...measuredNodes.map((node) => node.x + node.width)) + COLUMN_GAP
      : EMPTY_CANVAS_ORIGIN.x
  );
  let nextY = anchor?.y ?? (
    measuredNodes.length > 0
      ? Math.min(...measuredNodes.map((node) => node.y))
      : EMPTY_CANVAS_ORIGIN.y
  );

  return items.map((item) => {
    const estimated = estimateCanvasAgentNodeSize(item.nodeType);
    const width = normalizeDimension(item.width, estimated.width);
    const height = normalizeDimension(item.height, estimated.height);
    const placement = {
      key: item.key,
      position: { x: columnX, y: nextY },
      width,
      height,
    };
    nextY += height + ROW_GAP;
    return placement;
  });
}

function resolveNodeWidth(node: CanvasNode): number {
  return normalizeDimension(
    node.measured?.width ?? node.width,
    estimateCanvasAgentNodeSize(node.type).width
  );
}

function resolveNodeHeight(node: CanvasNode): number {
  return normalizeDimension(
    node.measured?.height ?? node.height,
    estimateCanvasAgentNodeSize(node.type).height
  );
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 1
    ? Math.round(value)
    : fallback;
}

function estimateCanvasAgentNodeSize(nodeType?: CanvasNodeType): {
  width: number;
  height: number;
} {
  if (
    nodeType === CANVAS_NODE_TYPES.imageEdit
    || nodeType === CANVAS_NODE_TYPES.textGeneration
    || nodeType === CANVAS_NODE_TYPES.storyboardGen
  ) {
    return { width: 520, height: 380 };
  }
  if (
    nodeType === CANVAS_NODE_TYPES.videoFrame
    || nodeType === CANVAS_NODE_TYPES.videoSingle
    || nodeType === CANVAS_NODE_TYPES.sd2VideoGen
  ) {
    return { width: 520, height: 360 };
  }
  if (nodeType === CANVAS_NODE_TYPES.textAnnotation) {
    return { width: 320, height: 180 };
  }
  return { width: DEFAULT_NODE_WIDTH, height: 220 };
}
