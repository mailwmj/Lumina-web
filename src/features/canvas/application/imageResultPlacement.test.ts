import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import {
  IMAGE_RESULT_LANE_ROWS,
  resolveImageResultBatchPositions,
} from './imageResultPlacement';

function node(
  id: string,
  type: CanvasNodeType,
  x: number,
  y: number,
  width: number,
  height: number,
  options: {
    parentId?: string;
    resultKind?: 'generic';
    generationLaneSlot?: number;
  } = {}
): CanvasNode {
  return {
    id,
    type,
    position: { x, y },
    width,
    height,
    parentId: options.parentId,
    data: {
      ...(options.resultKind ? { resultKind: options.resultKind } : {}),
      ...(options.generationLaneSlot === undefined
        ? {}
        : { generationLaneSlot: options.generationLaneSlot }),
    },
  } as CanvasNode;
}

function edge(source: string, target: string): CanvasEdge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
  } as CanvasEdge;
}

describe('image result placement', () => {
  const resultSize = { width: 288, height: 288 };

  it('uses upper, center, and lower slots before opening the next column', () => {
    const source = node('source', CANVAS_NODE_TYPES.imageEdit, 100, 200, 320, 240);

    expect(IMAGE_RESULT_LANE_ROWS).toBe(3);
    expect(resolveImageResultBatchPositions({
      sourceNodeId: source.id,
      nodes: [source],
      edges: [],
      resultSize,
      resultCount: 4,
    })).toEqual([
      { laneSlot: 0, position: { x: 448, y: -140 } },
      { laneSlot: 1, position: { x: 448, y: 176 } },
      { laneSlot: 2, position: { x: 448, y: 492 } },
      { laneSlot: 3, position: { x: 764, y: -140 } },
    ]);
  });

  it('continues a source-owned lane in the next column after its first three results', () => {
    const source = node('source', CANVAS_NODE_TYPES.imageEdit, 100, 200, 320, 240);
    const firstResult = node(
      'result-1',
      CANVAS_NODE_TYPES.exportImage,
      448,
      -140,
      288,
      288,
      { resultKind: 'generic', generationLaneSlot: 0 }
    );
    const secondResult = node(
      'result-2',
      CANVAS_NODE_TYPES.exportImage,
      448,
      176,
      288,
      288,
      { resultKind: 'generic', generationLaneSlot: 1 }
    );
    const thirdResult = node(
      'result-3',
      CANVAS_NODE_TYPES.exportImage,
      448,
      492,
      288,
      288,
      { resultKind: 'generic', generationLaneSlot: 2 }
    );

    expect(resolveImageResultBatchPositions({
      sourceNodeId: source.id,
      nodes: [source, firstResult, secondResult, thirdResult],
      edges: [
        edge(source.id, firstResult.id),
        edge(source.id, secondResult.id),
        edge(source.id, thirdResult.id),
      ],
      resultSize,
      resultCount: 1,
    })).toEqual([
      { laneSlot: 3, position: { x: 764, y: -140 } },
    ]);
  });

  it('uses direct legacy results to reserve earlier slots without moving them', () => {
    const source = node('source', CANVAS_NODE_TYPES.imageEdit, 100, 200, 320, 240);
    const result = node(
      'result',
      CANVAS_NODE_TYPES.exportImage,
      448,
      -140,
      288,
      288,
      { resultKind: 'generic' }
    );

    expect(resolveImageResultBatchPositions({
      sourceNodeId: source.id,
      nodes: [source, result],
      edges: [edge(source.id, result.id)],
      resultSize,
      resultCount: 1,
    })).toEqual([
      { laneSlot: 1, position: { x: 448, y: 176 } },
    ]);
  });

  it('skips a blocked upper slot before choosing the center slot', () => {
    const source = node('source', CANVAS_NODE_TYPES.imageEdit, 100, 200, 320, 240);
    const blocker = node('blocker', CANVAS_NODE_TYPES.textGeneration, 448, -140, 288, 288);

    expect(resolveImageResultBatchPositions({
      sourceNodeId: source.id,
      nodes: [source, blocker],
      edges: [],
      resultSize,
      resultCount: 1,
    })).toEqual([
      { laneSlot: 1, position: { x: 448, y: 176 } },
    ]);
  });

  it('moves to the next column when a blocker covers a complete result column', () => {
    const source = node('source', CANVAS_NODE_TYPES.imageEdit, 100, 200, 320, 240);
    const blocker = node('blocker', CANVAS_NODE_TYPES.textGeneration, 448, 0, 288, 2_000);

    expect(resolveImageResultBatchPositions({
      sourceNodeId: source.id,
      nodes: [source, blocker],
      edges: [],
      resultSize,
      resultCount: 1,
    })).toEqual([
      { laneSlot: 3, position: { x: 764, y: -140 } },
    ]);
  });

  it('uses absolute source coordinates while ignoring its group container as an obstacle', () => {
    const group = node('group', CANVAS_NODE_TYPES.group, 1_000, 800, 900, 640);
    const source = node(
      'source',
      CANVAS_NODE_TYPES.imageEdit,
      100,
      50,
      320,
      240,
      { parentId: group.id }
    );

    expect(resolveImageResultBatchPositions({
      sourceNodeId: source.id,
      nodes: [group, source],
      edges: [],
      resultSize,
      resultCount: 1,
    })).toEqual([
      { laneSlot: 0, position: { x: 1_448, y: 510 } },
    ]);
  });
});
