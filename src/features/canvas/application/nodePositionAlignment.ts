import type { NodeBase, NodeChange, NodePositionChange, XYPosition } from '@xyflow/system';

export const NODE_ALIGNMENT_SNAP_DISTANCE = 12;

interface AlignableNode extends NodeBase {
  position: XYPosition;
  parentId?: string;
}

type NodeDimension = 'width' | 'height';

export function resolveCenterPreservingPositionY(
  currentY: number,
  previousHeight: number,
  nextHeight: number
): number {
  return currentY + (previousHeight - nextHeight) / 2;
}

function isPositionChange<NodeType extends NodeBase>(
  change: NodeChange<NodeType>
): change is NodePositionChange & { position: XYPosition } {
  return change.type === 'position' && Boolean(change.position);
}

function resolveNodeDimension(node: AlignableNode, dimension: NodeDimension): number | null {
  const measured = node.measured?.[dimension];
  if (typeof measured === 'number' && Number.isFinite(measured)) {
    return measured;
  }

  const declared = node[dimension];
  return typeof declared === 'number' && Number.isFinite(declared) ? declared : null;
}

function alignmentOffsets(size: number | null): number[] {
  return size === null ? [0] : [0, size / 2, size];
}

function closestAlignedCoordinate(
  coordinate: number,
  movingSize: number | null,
  siblingNodes: AlignableNode[],
  axis: keyof XYPosition,
  dimension: NodeDimension,
  distance: number
): number | null {
  const movingOffsets = alignmentOffsets(movingSize);
  let nearest: number | null = null;
  let nearestDistance = distance;

  for (const siblingNode of siblingNodes) {
    const siblingOffsets = alignmentOffsets(resolveNodeDimension(siblingNode, dimension));
    const comparableAnchorCount = Math.min(movingOffsets.length, siblingOffsets.length);

    for (let index = 0; index < comparableAnchorCount; index += 1) {
      const candidate = siblingNode.position[axis] + siblingOffsets[index] - movingOffsets[index];
      const candidateDistance = Math.abs(candidate - coordinate);
      if (candidateDistance <= nearestDistance) {
        nearest = candidate;
        nearestDistance = candidateDistance;
      }
    }
  }

  return nearest;
}

/**
 * Makes a single dragged node magnetically align corresponding outer edges or
 * center lines with a sibling node. Grid snapping remains independent; this
 * also works when the grid is hidden and aligns directly to visible geometry.
 */
export function snapNodePositionChanges<NodeType extends AlignableNode>(
  changes: NodeChange<NodeType>[],
  nodes: NodeType[],
  distance = NODE_ALIGNMENT_SNAP_DISTANCE
): NodeChange<NodeType>[] {
  const positionChanges = changes.filter(isPositionChange);
  if (positionChanges.length !== 1) {
    return changes;
  }

  const [positionChange] = positionChanges;
  const movingNode = nodes.find((node) => node.id === positionChange.id);
  if (!movingNode) {
    return changes;
  }

  const siblingNodes = nodes.filter(
    (node) => node.id !== movingNode.id && node.parentId === movingNode.parentId
  );
  const alignedX = closestAlignedCoordinate(
    positionChange.position.x,
    resolveNodeDimension(movingNode, 'width'),
    siblingNodes,
    'x',
    'width',
    distance
  );
  const alignedY = closestAlignedCoordinate(
    positionChange.position.y,
    resolveNodeDimension(movingNode, 'height'),
    siblingNodes,
    'y',
    'height',
    distance
  );

  if (alignedX === null && alignedY === null) {
    return changes;
  }

  const snappedPosition = {
    x: alignedX ?? positionChange.position.x,
    y: alignedY ?? positionChange.position.y,
  };
  const delta = {
    x: snappedPosition.x - positionChange.position.x,
    y: snappedPosition.y - positionChange.position.y,
  };

  return changes.map((change) => {
    if (change !== positionChange) {
      return change;
    }
    return {
      ...change,
      position: snappedPosition,
      positionAbsolute: change.positionAbsolute
        ? {
          x: change.positionAbsolute.x + delta.x,
          y: change.positionAbsolute.y + delta.y,
        }
        : undefined,
    };
  });
}
