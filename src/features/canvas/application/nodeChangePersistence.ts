import type { NodeChange, Node } from '@xyflow/react';

export type CanvasPersistenceMode = 'skip' | 'immediate' | 'debounced';

export function getNodeChangePersistenceMode<NodeType extends Node>(
  changes: NodeChange<NodeType>[]
): CanvasPersistenceMode {
  const hasInteractionMove = changes.some(
    (change) =>
      (change.type === 'position' && 'dragging' in change && Boolean(change.dragging)) ||
      (change.type === 'dimensions' && 'resizing' in change && Boolean(change.resizing))
  );
  if (hasInteractionMove) {
    return 'skip';
  }

  const hasInteractionEnd = changes.some(
    (change) =>
      (change.type === 'position' && 'dragging' in change && change.dragging === false) ||
      (change.type === 'dimensions' && 'resizing' in change && change.resizing === false)
  );
  return hasInteractionEnd ? 'immediate' : 'debounced';
}
