import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { buildCanvasAgentVideoResults } from './canvasAgentVideoResults';

const mocks = vi.hoisted(() => ({
  createPreviewDataUrl: vi.fn(),
}));

vi.mock('@/features/canvas/application/imageData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/canvas/application/imageData')>();
  return { ...actual, createPreviewDataUrl: mocks.createPreviewDataUrl };
});

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      getCurrentProject: () => ({ id: 'project-1', name: 'Project' }),
    }),
  },
}));

describe('canvas Agent video result reads', () => {
  beforeEach(() => {
    mocks.createPreviewDataUrl.mockResolvedValue('data:image/webp;base64,cG9zdGVy');
  });

  afterEach(() => {
    vi.clearAllMocks();
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('returns bounded metadata and compressed previews without exposing video sources or task handles', async () => {
    const resultNode = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.exportVideo, { x: 0, y: 0 }, {
      displayName: 'Product orbit',
      videoUrl: 'https://signed.example.test/private-video.mp4?secret=1',
      previewImageUrl: '/private/project/poster.webp',
      lastFrameImageUrl: '/private/project/last-frame.webp',
      assetId: 'video-asset-1',
      previewAssetId: 'poster-asset-1',
      lastFrameAssetId: 'last-frame-asset-1',
      aspectRatio: '16:9',
      model: 'doubao-seedance-2-0-260128',
      duration: 5,
      isGenerating: false,
      generationJobId: null,
      generationTaskHandle: {
        kind: 'browser-direct',
        baseUrl: 'https://provider.example.test/v1',
        externalTaskId: 'provider-task-1',
      },
    });
    useCanvasStore.getState().setCanvasData([resultNode], []);

    const result = await buildCanvasAgentVideoResults({
      projectId: 'project-1',
      nodeIds: [resultNode.id],
      maxDimension: 768,
    });

    expect(result.videos).toEqual([expect.objectContaining({
      nodeId: resultNode.id,
      status: 'ready',
      assetId: 'video-asset-1',
      previewAssetId: 'poster-asset-1',
      lastFrameAssetId: 'last-frame-asset-1',
      posterPreview: expect.objectContaining({
        mimeType: 'image/webp',
        dataUrl: 'data:image/webp;base64,cG9zdGVy',
      }),
      lastFramePreview: expect.objectContaining({
        mimeType: 'image/webp',
        dataUrl: 'data:image/webp;base64,cG9zdGVy',
      }),
    })]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('/private/project');
    expect(serialized).not.toContain('signed.example.test');
    expect(serialized).not.toContain('provider.example.test');
    expect(serialized).not.toContain('provider-task-1');
  });
});
