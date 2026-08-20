import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { buildReadonlyCanvasSnapshot } from './readonlyCanvasSnapshot';

describe('buildReadonlyCanvasSnapshot', () => {
  it('uses the current project revision and only node-registry readable fields', () => {
    const result = buildReadonlyCanvasSnapshot({
      projectId: 'project-1',
      projectName: 'Current project',
      projectRevision: 'r12',
      nodes: [{
        id: 'image-1',
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 10, y: 20 },
        data: {
          displayName: 'Draft',
          prompt: 'A lamp',
          apiKey: 'must-not-leak',
          imageUrl: 'must-not-leak',
        },
      }] as unknown as CanvasNode[],
      edges: [],
      selectedNodeIds: ['image-1'],
      viewport: { x: 1, y: 2, zoom: 1.5 },
    });

    expect(result.state.project).toEqual({ id: 'project-1', name: 'Current project', revision: 'r12' });
    expect(result.state.nodes[0]?.data).toEqual({ displayName: 'Draft', prompt: 'A lamp' });
    expect(result.selection).toEqual({ nodeIds: ['image-1'] });
    expect(result.capabilities).toEqual([
      'canvas.read.state',
      'canvas.read.selection',
      'canvas.read.capabilities',
    ]);
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('writableFields');
  });
});
