import { memo } from 'react';

import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { resolveNodeSurfaceStateClass } from '@/features/canvas/ui/nodeSurfaceStyles';
import { type GroupNodeData } from '@/features/canvas/domain/canvasNodes';

type GroupNodeProps = {
  id: string;
  data: GroupNodeData;
  selected?: boolean;
};

export const GroupNode = memo(({ selected }: GroupNodeProps) => {
  return (
    <div
      className={`group relative h-full w-full overflow-visible rounded-[var(--node-radius)] border ${resolveNodeSurfaceStateClass(selected)}`}
      style={{
        backgroundColor: 'var(--group-node-bg)',
      }}
    >
      <NodeResizeHandle minWidth={220} minHeight={140} maxWidth={2200} maxHeight={1600} />
    </div>
  );
});

GroupNode.displayName = 'GroupNode';
