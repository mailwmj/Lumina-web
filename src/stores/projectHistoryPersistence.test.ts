import { describe, expect, it } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { CanvasHistoryState } from './canvasStore';
import {
  deserializeProjectHistory,
  serializeProjectHistory,
} from '@/features/project/application/projectHistoryPersistence';
import { useCanvasStore } from './canvasStore';

describe('project history persistence', () => {
  it('keeps the latest twelve snapshots and stores media history by assetId', () => {
    const snapshots = Array.from({ length: 20 }, (_, index) => ({
      nodes: [canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: index, y: 0 }, {
        assetId: `asset-${index}`,
        imageUrl: `data:image/png;base64,${'x'.repeat(20_000)}`,
      })],
      edges: [],
    }));
    const history: CanvasHistoryState = { past: snapshots, future: snapshots.slice(0, 2) };

    const encoded = serializeProjectHistory(history);
    expect(encoded.past).toHaveLength(12);
    expect(encoded.future).toHaveLength(2);
    expect(JSON.stringify(encoded)).not.toContain('data:image/png;base64');
    expect(encoded.past[0]?.nodes[0]?.data).toMatchObject({ assetId: 'asset-8' });

    const decoded = deserializeProjectHistory(JSON.stringify(encoded));
    expect(decoded.past[0]?.nodes[0]?.data).toMatchObject({ assetId: 'asset-8' });
    expect(decoded.past[0]?.nodes[0]?.data).not.toHaveProperty('imageUrl');
  });

  it('strips legacy media URLs from history snapshots without an assetId', () => {
    const legacy = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {
      imageUrl: 'data:image/png;base64,legacy-image',
      previewImageUrl: 'blob:legacy-preview',
    });

    const encoded = serializeProjectHistory({
      past: [{ nodes: [legacy], edges: [] }],
      future: [],
    });

    expect(encoded.past[0]?.nodes[0]?.data).not.toHaveProperty('imageUrl');
    expect(encoded.past[0]?.nodes[0]?.data).not.toHaveProperty('previewImageUrl');
    expect(JSON.stringify(encoded)).not.toContain('data:image/png;base64,legacy-image');
  });

  it('restores large valid history instead of dropping it by serialized size', () => {
    const history: CanvasHistoryState = {
      past: Array.from({ length: 12 }, (_, index) => ({
        nodes: [{
          id: `node-${index}`,
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: { content: 'a'.repeat(200_000) },
        } as never],
        edges: [],
      })),
      future: [],
    };

    const decoded = deserializeProjectHistory(JSON.stringify(serializeProjectHistory(history)));
    expect(decoded.past).toHaveLength(12);
    expect((decoded.past[0]?.nodes[0]?.data as { content: string }).content).toHaveLength(200_000);
  });

  it('keeps an asset reference resolvable through persisted undo and redo', () => {
    const first = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {
      assetId: 'asset-before',
      imageUrl: 'data:image/png;base64,before',
    });
    const second = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 20, y: 0 }, {
      assetId: 'asset-after',
      imageUrl: 'data:image/png;base64,after',
    });
    const history = deserializeProjectHistory(JSON.stringify(serializeProjectHistory({
      past: [{ nodes: [first], edges: [] }],
      future: [],
    })));

    useCanvasStore.getState().setCanvasData([second], [], history);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0]?.data).toMatchObject({ assetId: 'asset-before' });
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0]?.data).toMatchObject({ assetId: 'asset-after' });
  });
});
