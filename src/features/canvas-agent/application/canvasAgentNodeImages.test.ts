import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { buildCanvasAgentNodeImages } from './canvasAgentNodeImages';

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

describe('canvas Agent node image reads', () => {
  beforeEach(() => {
    mocks.createPreviewDataUrl.mockResolvedValue('data:image/webp;base64,cHJldmlldw==');
  });

  afterEach(() => {
    vi.clearAllMocks();
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('returns compressed vision data and status without exposing source paths', async () => {
    const resultNode = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.exportImage, { x: 0, y: 0 }, {
      displayName: '正面全身',
      imageUrl: '/private/project/outputs/front.png',
      previewImageUrl: '/private/project/outputs/front-preview.png',
      aspectRatio: '2:3',
      isGenerating: false,
      resultKind: 'imageEdit',
    });
    useCanvasStore.getState().setCanvasData([resultNode], []);

    const result = await buildCanvasAgentNodeImages({
      projectId: 'project-1',
      nodeIds: [resultNode.id],
      maxDimension: 768,
    });

    expect(mocks.createPreviewDataUrl).toHaveBeenCalledWith(
      '/private/project/outputs/front-preview.png',
      768,
      true,
      'image/webp'
    );
    expect(result.images).toEqual([expect.objectContaining({
      nodeId: resultNode.id,
      displayName: '正面全身',
      status: 'ready',
      mimeType: 'image/webp',
      dataUrl: 'data:image/webp;base64,cHJldmlldw==',
    })]);
    expect(JSON.stringify(result)).not.toContain('/private/project');
  });

  it('returns failed generation metadata even when no image exists', async () => {
    const failedNode = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.exportImage, { x: 0, y: 0 }, {
      displayName: '细节镜头',
      imageUrl: null,
      previewImageUrl: null,
      generationError: 'Provider rejected the prompt',
      isGenerating: false,
      resultKind: 'imageEdit',
    });
    useCanvasStore.getState().setCanvasData([failedNode], []);

    const result = await buildCanvasAgentNodeImages({
      projectId: 'project-1',
      nodeIds: [failedNode.id],
      maxDimension: 512,
    });

    expect(result.images).toEqual([expect.objectContaining({
      nodeId: failedNode.id,
      status: 'failed',
      generationError: 'Provider rejected the prompt',
    })]);
    expect(mocks.createPreviewDataUrl).not.toHaveBeenCalled();
  });
});
