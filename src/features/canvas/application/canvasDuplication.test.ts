import { describe, expect, it } from 'vitest';

import type { CanvasEdge } from '../domain/canvasNodes';
import { sortCanvasEdgesForDuplication } from './canvasDuplication';

function edge(
  id: string,
  source: string,
  target: string,
  valueType: 'text' | 'image',
  inputOrder: number
): CanvasEdge {
  return { id, source, target, data: { valueType, inputOrder } };
}

describe('canvas subgraph duplication ordering', () => {
  it('preserves each target/type order even when edge groups are interleaved', () => {
    const edges = [
      edge('text-later', 'text-a', 'target', 'text', 1),
      edge('image', 'image-a', 'target', 'image', 0),
      edge('other-target', 'text-c', 'other', 'text', 0),
      edge('text-earlier', 'text-b', 'target', 'text', 0),
    ];

    const sorted = sortCanvasEdgesForDuplication(edges);
    const targetTextSources = sorted
      .filter((item) => item.target === 'target' && item.data?.valueType === 'text')
      .map((item) => item.source);

    expect(targetTextSources).toEqual(['text-b', 'text-a']);
  });
});
