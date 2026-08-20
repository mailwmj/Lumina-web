import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  createVideoOutputNode,
  resolveVideoResultNodeSize,
} from './videoOutput';

describe('video output layout', () => {
  it('fits result nodes to their configured display ratio', () => {
    expect(resolveVideoResultNodeSize('16:9')).toEqual({ width: 560, height: 315 });
    expect(resolveVideoResultNodeSize('1:1')).toEqual({ width: 400, height: 400 });
    expect(resolveVideoResultNodeSize('9:16')).toEqual({ width: 320, height: 569 });
  });

  it('uses the same upper-then-center result lane as image generation', () => {
    type Input = Parameters<typeof createVideoOutputNode>[0];
    type AddedNode = Parameters<Input['addNodeBatch']>[0][number];
    const addedNodes: AddedNode[] = [];
    const edges: CanvasEdge[] = [];
    const source: CanvasNode = {
      id: 'video-source',
      type: CANVAS_NODE_TYPES.videoSingle,
      position: { x: 100, y: 200 },
      width: 320,
      height: 240,
      data: {} as never,
    };
    const addNodeBatch: Input['addNodeBatch'] = (nodes) => {
      addedNodes.push(...nodes);
      return nodes.map((_, index) => `video-result-${addedNodes.length - nodes.length + index + 1}`);
    };
    const addEdge: Input['addEdge'] = (sourceId, targetId) => {
      edges.push({ id: `${sourceId}-${targetId}`, source: sourceId, target: targetId } as CanvasEdge);
      return `${sourceId}-${targetId}`;
    };

    const firstId = createVideoOutputNode({
      sourceNodeId: source.id,
      data: { aspectRatio: '16:9', isGenerating: true },
      existingNodes: [source],
      existingEdges: [],
      addNodeBatch,
      addEdge,
    });
    const first: CanvasNode = {
      id: firstId ?? 'missing',
      type: CANVAS_NODE_TYPES.exportVideo,
      position: addedNodes[0].position,
      width: addedNodes[0].width,
      height: addedNodes[0].height,
      data: addedNodes[0].data as never,
    };
    const secondId = createVideoOutputNode({
      sourceNodeId: source.id,
      data: { aspectRatio: '16:9', isGenerating: true },
      existingNodes: [source, first],
      existingEdges: edges,
      addNodeBatch,
      addEdge,
    });

    expect([firstId, secondId]).toEqual(['video-result-1', 'video-result-2']);
    expect(addedNodes.map(({ position, width, height, data }) => ({
      position,
      width,
      height,
      laneSlot: data?.generationLaneSlot,
    }))).toEqual([
      { position: { x: 448, y: -180 }, width: 560, height: 315, laneSlot: 0 },
      { position: { x: 448, y: 163 }, width: 560, height: 315, laneSlot: 1 },
    ]);
  });
});
