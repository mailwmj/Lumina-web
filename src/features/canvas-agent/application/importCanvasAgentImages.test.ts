import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { importCanvasAgentImages } from './importCanvasAgentImages';

const mocks = vi.hoisted(() => ({
  prepareNodeImage: vi.fn(),
}));

vi.mock('@/features/canvas/application/imageData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/canvas/application/imageData')>();
  return { ...actual, prepareNodeImage: mocks.prepareNodeImage };
});

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      getCurrentProject: () => ({ id: 'project-1', name: 'Project' }),
    }),
  },
}));

describe('canvas Agent image import', () => {
  beforeEach(() => {
    mocks.prepareNodeImage.mockImplementation(async (source: string) => ({
      imageUrl: `/project/uploads/${source.includes('model') ? 'model.png' : 'product.png'}`,
      previewImageUrl: `/project/uploads/${source.includes('model') ? 'model-preview.webp' : 'product-preview.webp'}`,
      aspectRatio: source.includes('model') ? '2:3' : '1:1',
    }));
    useCanvasStore.getState().setCanvasData([], []);
  });

  afterEach(() => {
    vi.clearAllMocks();
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('prepares a batch and creates one readable upload column in one undo step', async () => {
    const assertCurrent = vi.fn();
    const result = await importCanvasAgentImages({
      projectId: 'project-1',
      images: [
        {
          clientId: 'model',
          source: '/tmp/model%20card.png',
          displayName: '模特参考',
        },
        {
          clientId: 'product',
          source: 'https://example.com/product.png',
          fileName: 'references/product.png',
          displayName: '商品参考',
        },
      ],
      assertCurrent,
    });

    const canvas = useCanvasStore.getState();
    expect(mocks.prepareNodeImage).toHaveBeenCalledTimes(2);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    expect(result.createdNodeIds).toHaveLength(2);
    expect(result.nodeIdMap).toEqual({
      model: result.createdNodeIds[0],
      product: result.createdNodeIds[1],
    });
    expect(canvas.history.past).toHaveLength(1);
    expect(canvas.nodes.map((node) => node.type)).toEqual([
      CANVAS_NODE_TYPES.upload,
      CANVAS_NODE_TYPES.upload,
    ]);
    expect(canvas.nodes.map((node) => node.position.x)).toEqual([120, 120]);
    expect(canvas.nodes[1].position.y).toBeGreaterThan(
      canvas.nodes[0].position.y + (canvas.nodes[0].height ?? 0)
    );
    expect(canvas.nodes.map((node) => node.data)).toMatchObject([
      { displayName: '模特参考', sourceFileName: 'model card.png', aspectRatio: '2:3' },
      { displayName: '商品参考', sourceFileName: 'product.png', aspectRatio: '1:1' },
    ]);
  });

  it('rejects duplicate client IDs before preparing any image', async () => {
    await expect(importCanvasAgentImages({
      projectId: 'project-1',
      images: [
        { clientId: 'same', source: '/tmp/model.png' },
        { clientId: 'same', source: '/tmp/product.png' },
      ],
      assertCurrent: vi.fn(),
    })).rejects.toThrow(/Duplicate imported image clientId/);
    expect(mocks.prepareNodeImage).not.toHaveBeenCalled();
  });
});
