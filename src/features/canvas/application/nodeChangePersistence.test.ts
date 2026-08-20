import { describe, expect, it } from 'vitest';
import type { NodeChange } from '@xyflow/react';

import type { CanvasNode } from '@/stores/canvasStore';
import { getNodeChangePersistenceMode } from './nodeChangePersistence';

describe('node change persistence policy', () => {
  it('skips full persistence for drag and resize frames', () => {
    expect(
      getNodeChangePersistenceMode<CanvasNode>([
        { id: 'node-1', type: 'position', position: { x: 1, y: 2 }, dragging: true },
      ])
    ).toBe('skip');
    expect(
      getNodeChangePersistenceMode<CanvasNode>([
        { id: 'node-1', type: 'dimensions', dimensions: { width: 100, height: 100 }, resizing: true },
      ])
    ).toBe('skip');
  });

  it('persists interaction end immediately and ordinary changes with debounce', () => {
    expect(
      getNodeChangePersistenceMode<CanvasNode>([
        { id: 'node-1', type: 'position', position: { x: 1, y: 2 }, dragging: false },
      ])
    ).toBe('immediate');
    expect(
      getNodeChangePersistenceMode<CanvasNode>([
        { id: 'node-1', type: 'select', selected: true },
      ] as NodeChange<CanvasNode>[])
    ).toBe('debounced');
  });
});
