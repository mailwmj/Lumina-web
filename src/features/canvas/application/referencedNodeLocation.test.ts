import { describe, expect, it, vi } from 'vitest';

import { locateReferencedNode } from './referencedNodeLocation';

describe('referenced node location', () => {
  it('selects the referenced node and pans to its center without changing the current zoom', async () => {
    const setSelectedNode = vi.fn();
    const setCenter = vi.fn().mockResolvedValue(true);
    const getViewport = vi.fn(() => ({ zoom: 1.75 }));
    const getInternalNode = vi.fn(() => ({
      measured: { width: 240, height: 120 },
      internals: { positionAbsolute: { x: 480, y: 360 } },
    }));

    const located = await locateReferencedNode('upstream-node', {
      setSelectedNode,
      getInternalNode,
      getViewport,
      setCenter,
    });

    expect(located).toBe(true);
    expect(setSelectedNode).toHaveBeenCalledOnce();
    expect(setSelectedNode).toHaveBeenCalledWith('upstream-node');
    expect(setCenter).toHaveBeenCalledOnce();
    expect(setCenter).toHaveBeenCalledWith(600, 420, {
      duration: 240,
      zoom: 1.75,
    });
  });
});
