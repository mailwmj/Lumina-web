import { useLayoutEffect, useRef } from 'react';

import { resolveCenterPreservingPositionY } from '@/features/canvas/application/nodePositionAlignment';
import { useCanvasStore } from '@/stores/canvasStore';

interface PreserveNodeCenterOnAutoResizeOptions {
  nodeId: string;
  height: number;
  enabled: boolean;
}

/** Keeps connection handles on the same horizontal line when content changes a node's automatic height. */
export function usePreserveNodeCenterOnAutoResize({
  nodeId,
  height,
  enabled,
}: PreserveNodeCenterOnAutoResizeOptions): void {
  const previousHeightRef = useRef(height);
  const updateNodePosition = useCanvasStore((state) => state.updateNodePosition);

  useLayoutEffect(() => {
    const previousHeight = previousHeightRef.current;
    previousHeightRef.current = height;

    if (!enabled || previousHeight === height) {
      return;
    }

    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
    if (!node || node.dragging) {
      return;
    }

    updateNodePosition(nodeId, {
      x: node.position.x,
      y: resolveCenterPreservingPositionY(node.position.y, previousHeight, height),
    });
  }, [enabled, height, nodeId, updateNodePosition]);
}
