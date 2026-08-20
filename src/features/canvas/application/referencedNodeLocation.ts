import type { XYPosition } from '@xyflow/react';

const REFERENCE_NODE_LOCATE_DURATION_MS = 240;

interface ReferencedNode {
  measured: {
    width?: number;
    height?: number;
  };
  internals: {
    positionAbsolute: XYPosition;
  };
}

export interface ReferencedNodeLocator {
  setSelectedNode: (nodeId: string) => void;
  getInternalNode: (nodeId: string) => ReferencedNode | undefined;
  getViewport: () => { zoom: number };
  setCenter: (
    x: number,
    y: number,
    options: { duration: number; zoom: number }
  ) => Promise<boolean>;
}

export async function locateReferencedNode(
  nodeId: string,
  locator: ReferencedNodeLocator
): Promise<boolean> {
  locator.setSelectedNode(nodeId);

  const node = locator.getInternalNode(nodeId);
  if (!node) {
    return false;
  }

  const width = node.measured.width ?? 0;
  const height = node.measured.height ?? 0;
  const { positionAbsolute } = node.internals;
  const { zoom } = locator.getViewport();

  return await locator.setCenter(
    positionAbsolute.x + width / 2,
    positionAbsolute.y + height / 2,
    { duration: REFERENCE_NODE_LOCATE_DURATION_MS, zoom }
  );
}
