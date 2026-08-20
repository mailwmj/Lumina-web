import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasWorkflowNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  collectCanvasImagePreviewJobs,
  createCanvasImagePreviewPatch,
} from './canvasImagePreviewBackfill';

function createImageNode(
  id: string,
  imageUrl: string,
  previewImageUrl: string | null
): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.upload,
    position: { x: 0, y: 0 },
    data: {
      imageUrl,
      previewImageUrl,
      aspectRatio: '1:1',
    },
  };
}

describe('canvas image preview backfill', () => {
  it('collects root images whose preview is missing or still points to the original', () => {
    const original = 'file:///original.jpg';
    const nodes: CanvasWorkflowNode[] = [
      createImageNode('missing-preview', original, null),
      createImageNode('same-preview', 'file:///same.jpg', 'file:///same.jpg'),
      createImageNode('ready-preview', 'file:///ready.jpg', 'file:///thumb.jpg'),
    ];

    expect(collectCanvasImagePreviewJobs(nodes)).toEqual([
      { kind: 'node', nodeId: 'missing-preview', imageUrl: original },
      { kind: 'node', nodeId: 'same-preview', imageUrl: 'file:///same.jpg' },
    ]);
  });

  it('collects storyboard frames that need a thumbnail and patches only that frame', () => {
    const node: CanvasNode = {
      id: 'storyboard-1',
      type: CANVAS_NODE_TYPES.storyboardSplit,
      position: { x: 0, y: 0 },
      data: {
        aspectRatio: '16:9',
        gridRows: 1,
        gridCols: 2,
        frames: [
          {
            id: 'frame-1',
            imageUrl: 'file:///frame-original.jpg',
            previewImageUrl: 'file:///frame-original.jpg',
            aspectRatio: '16:9',
            note: '',
            order: 0,
          },
          {
            id: 'frame-2',
            imageUrl: 'file:///frame-2-original.jpg',
            previewImageUrl: 'file:///frame-2-thumb.jpg',
            aspectRatio: '16:9',
            note: '',
            order: 1,
          },
        ],
      },
    };

    const [job] = collectCanvasImagePreviewJobs([node]);
    expect(job).toEqual({
      kind: 'storyboardFrame',
      nodeId: 'storyboard-1',
      frameId: 'frame-1',
      imageUrl: 'file:///frame-original.jpg',
    });
    expect(createCanvasImagePreviewPatch(node, job, 'file:///frame-thumb.jpg')).toEqual({
      frames: [
        {
          id: 'frame-1',
          imageUrl: 'file:///frame-original.jpg',
          previewImageUrl: 'file:///frame-thumb.jpg',
          aspectRatio: '16:9',
          note: '',
          order: 0,
        },
        {
          id: 'frame-2',
          imageUrl: 'file:///frame-2-original.jpg',
          previewImageUrl: 'file:///frame-2-thumb.jpg',
          aspectRatio: '16:9',
          note: '',
          order: 1,
        },
      ],
    });
  });

  it('patches a root image only while it still needs a preview', () => {
    const node = createImageNode('image-1', 'file:///original.jpg', 'file:///original.jpg');
    const [job] = collectCanvasImagePreviewJobs([node]);

    expect(createCanvasImagePreviewPatch(node, job, 'file:///preview.jpg')).toEqual({
      previewImageUrl: 'file:///preview.jpg',
    });
    expect(createCanvasImagePreviewPatch({
      ...node,
      data: { ...node.data, previewImageUrl: 'file:///existing-thumb.jpg' },
    }, job, 'file:///preview.jpg')).toBeNull();
  });
});
