import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type CanvasEdge,
  type CanvasNode,
  type ExportImageNodeData,
} from '@/features/canvas/domain/canvasNodes';

export interface ImageResultBatchSize {
  width: number;
  height: number;
}

export interface ImageResultBatchPlacementInput {
  sourceNodeId: string;
  nodes: readonly CanvasNode[];
  edges: readonly CanvasEdge[];
  resultSize: ImageResultBatchSize;
  resultCount: number;
  resultNodeType?: typeof CANVAS_NODE_TYPES.exportImage | typeof CANVAS_NODE_TYPES.exportVideo;
}

export interface ImageResultBatchPlacement {
  laneSlot: number;
  position: { x: number; y: number };
}

interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IMAGE_RESULT_LANE_GAP = 28;
export const IMAGE_RESULT_LANE_ROWS = 3;
const MAX_LANE_SLOT_SEARCH = 1_000;

function resolveNodeSize(node: CanvasNode): ImageResultBatchSize {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  const declaredWidth = typeof node.width === 'number' ? node.width : null;
  const declaredHeight = typeof node.height === 'number' ? node.height : null;

  return {
    width: node.measured?.width ?? declaredWidth ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? declaredHeight ?? styleHeight ?? 200,
  };
}

function resolveAbsolutePosition(
  node: CanvasNode,
  nodesById: ReadonlyMap<string, CanvasNode>
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const visited = new Set<string>();

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodesById.get(parentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }

  return { x, y };
}

function resolveNodeRect(
  node: CanvasNode,
  nodesById: ReadonlyMap<string, CanvasNode>
): CanvasRect {
  const position = resolveAbsolutePosition(node, nodesById);
  const size = resolveNodeSize(node);
  return { ...position, ...size };
}

function rectsCollide(left: CanvasRect, right: CanvasRect): boolean {
  return (
    left.x < right.x + right.width + IMAGE_RESULT_LANE_GAP
    && left.x + left.width + IMAGE_RESULT_LANE_GAP > right.x
    && left.y < right.y + right.height + IMAGE_RESULT_LANE_GAP
    && left.y + left.height + IMAGE_RESULT_LANE_GAP > right.y
  );
}

function isTrackedResult(
  node: CanvasNode,
  resultNodeType: NonNullable<ImageResultBatchPlacementInput['resultNodeType']>
): boolean {
  if (node.type !== resultNodeType) {
    return false;
  }

  if (resultNodeType === CANVAS_NODE_TYPES.exportVideo) {
    return true;
  }

  const data = node.data as ExportImageNodeData;
  return data.resultKind === undefined || data.resultKind === 'generic';
}

function getDirectTrackedResults(
  sourceNodeId: string,
  nodesById: ReadonlyMap<string, CanvasNode>,
  edges: readonly CanvasEdge[],
  resultNodeType: NonNullable<ImageResultBatchPlacementInput['resultNodeType']>
): CanvasNode[] {
  const targetIds = new Set(
    edges
      .filter((edge) => edge.source === sourceNodeId)
      .map((edge) => edge.target)
  );

  return Array.from(targetIds)
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is CanvasNode => Boolean(node))
    .filter((node) => isTrackedResult(node, resultNodeType));
}

function resolveNextLaneSlot(results: readonly CanvasNode[]): number {
  const assignedSlots = results.flatMap((node) => {
    const laneSlot = (node.data as { generationLaneSlot?: unknown }).generationLaneSlot;
    return typeof laneSlot === 'number' && Number.isInteger(laneSlot) && laneSlot >= 0
      ? [laneSlot]
      : [];
  });
  const nextAssignedSlot = assignedSlots.length > 0
    ? Math.max(...assignedSlots) + 1
    : 0;
  const legacyResultCount = results.length - assignedSlots.length;

  return Math.max(nextAssignedSlot, legacyResultCount);
}

function resolveLanePosition(
  laneSlot: number,
  origin: { x: number; centerY: number },
  resultSize: ImageResultBatchSize
): { x: number; y: number } {
  const column = Math.floor(laneSlot / IMAGE_RESULT_LANE_ROWS);
  const row = laneSlot % IMAGE_RESULT_LANE_ROWS;

  return {
    x: Math.round(origin.x + column * (resultSize.width + IMAGE_RESULT_LANE_GAP)),
    y: Math.round(
      origin.centerY - resultSize.height / 2
        + (row - 1) * (resultSize.height + IMAGE_RESULT_LANE_GAP)
    ),
  };
}

/**
 * Reserves deterministic mind-map result slots to the right of one source node.
 * A source-local lane holds upper, center, then lower slots per column. Existing nodes
 * are never moved; unrelated obstacles only cause later slots to be selected.
 */
export function resolveImageResultBatchPositions({
  sourceNodeId,
  nodes,
  edges,
  resultSize,
  resultCount,
  resultNodeType = CANVAS_NODE_TYPES.exportImage,
}: ImageResultBatchPlacementInput): ImageResultBatchPlacement[] {
  const safeResultCount = Math.max(0, Math.floor(resultCount));
  if (safeResultCount === 0) {
    return [];
  }

  const sourceNode = nodes.find((node) => node.id === sourceNodeId);
  if (!sourceNode) {
    return Array.from({ length: safeResultCount }, (_, laneSlot) => ({
      laneSlot,
      position: resolveLanePosition(laneSlot, { x: 100, centerY: 100 }, resultSize),
    }));
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const sourceRect = resolveNodeRect(sourceNode, nodesById);
  const origin = {
    x: sourceRect.x + sourceRect.width + IMAGE_RESULT_LANE_GAP,
    centerY: sourceRect.y + sourceRect.height / 2,
  };
  const directResults = getDirectTrackedResults(sourceNodeId, nodesById, edges, resultNodeType);
  const ignoredNodeIds = new Set([sourceNodeId]);
  const obstacleRects = nodes
    .filter((node) => node.type !== CANVAS_NODE_TYPES.group && !ignoredNodeIds.has(node.id))
    .map((node) => resolveNodeRect(node, nodesById));
  const placements: ImageResultBatchPlacement[] = [];
  const reservedRects: CanvasRect[] = [];
  let nextLaneSlot = resolveNextLaneSlot(directResults);

  for (let outputIndex = 0; outputIndex < safeResultCount; outputIndex += 1) {
    let laneSlot = nextLaneSlot;
    let candidate: CanvasRect | null = null;

    for (let searchStep = 0; searchStep < MAX_LANE_SLOT_SEARCH; searchStep += 1) {
      const position = resolveLanePosition(laneSlot, origin, resultSize);
      const nextCandidate = { ...position, ...resultSize };
      const collides = [...obstacleRects, ...reservedRects].some((obstacle) => (
        rectsCollide(nextCandidate, obstacle)
      ));
      if (!collides) {
        candidate = nextCandidate;
        break;
      }
      laneSlot += 1;
    }

    if (!candidate) {
      const rightmostObstacleEdge = obstacleRects.reduce((rightEdge, obstacle) => (
        Math.max(rightEdge, obstacle.x + obstacle.width)
      ), origin.x - IMAGE_RESULT_LANE_GAP);
      const minimumColumn = Math.max(
        Math.floor(laneSlot / IMAGE_RESULT_LANE_ROWS),
        Math.ceil((rightmostObstacleEdge + IMAGE_RESULT_LANE_GAP - origin.x)
          / (resultSize.width + IMAGE_RESULT_LANE_GAP))
      );
      laneSlot = minimumColumn * IMAGE_RESULT_LANE_ROWS;
      const position = resolveLanePosition(laneSlot, origin, resultSize);
      candidate = { ...position, ...resultSize };
    }

    placements.push({
      laneSlot,
      position: { x: Math.round(candidate.x), y: Math.round(candidate.y) },
    });
    reservedRects.push(candidate);
    nextLaneSlot = laneSlot + 1;
  }

  return placements;
}
