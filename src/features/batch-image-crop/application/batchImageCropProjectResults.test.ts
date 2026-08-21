import { describe, expect, it, vi } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { createBatchImageCropResultSink } from './batchImageCropProjectResults';

describe('batch crop project result sink', () => {
  it('persists each exported asset as a project-owned result node and history step', async () => {
    let nodes: CanvasNode[] = [];
    let history = { past: [] as Array<{ nodes: CanvasNode[]; edges: [] }>, future: [] };
    const saveCurrentProject = vi.fn();
    const sink = createBatchImageCropResultSink('project-1', {
      projectState: () => ({ currentProjectId: 'project-1', saveCurrentProject }),
      canvasState: () => ({
        nodes,
        edges: [],
        history,
        currentViewport: { x: 0, y: 0, zoom: 1 },
        addNode: (_type, _position, data) => {
          history = { past: [{ nodes, edges: [] }], future: [] };
          nodes = [{
            id: 'result-1',
            type: CANVAS_NODE_TYPES.exportImage,
            position: { x: 64, y: 64 },
            data: data as CanvasNode['data'],
          }];
          return 'result-1';
        },
      }),
    });

    await sink.record({
      assetId: 'asset-1',
      fileName: 'look_1440x1920.jpg',
      target: { id: '1440x1920', width: 1440, height: 1920 },
    });

    expect(nodes[0]).toMatchObject({
      type: CANVAS_NODE_TYPES.exportImage,
      data: {
        assetId: 'asset-1',
        imageUrl: null,
        previewImageUrl: null,
        aspectRatio: '3:4',
        displayName: 'look_1440x1920.jpg',
      },
    });
    expect(history.past).toHaveLength(1);
    expect(saveCurrentProject).toHaveBeenCalledWith(nodes, [], { x: 0, y: 0, zoom: 1 }, history);
  });
});
