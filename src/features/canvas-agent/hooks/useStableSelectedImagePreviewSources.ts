import { useRef } from 'react';

import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  collectSelectedImagePreviewSources,
  type SelectedImagePreviewSource,
} from '@/features/canvas-agent/application/selectedImagePreviews';

export function useStableSelectedImagePreviewSources(
  nodes: CanvasNode[],
  selectedNodeIds: string[]
): SelectedImagePreviewSource[] {
  const nextSources = collectSelectedImagePreviewSources(nodes, selectedNodeIds);
  const stableSourcesRef = useRef(nextSources);
  if (!areSourcesEqual(stableSourcesRef.current, nextSources)) {
    stableSourcesRef.current = nextSources;
  }
  return stableSourcesRef.current;
}

function areSourcesEqual(
  left: SelectedImagePreviewSource[],
  right: SelectedImagePreviewSource[]
): boolean {
  return left.length === right.length && left.every((item, index) => (
    item.nodeId === right[index]?.nodeId && item.source === right[index]?.source
  ));
}
