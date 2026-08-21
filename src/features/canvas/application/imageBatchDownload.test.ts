import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { resolveDownloadableCanvasMedia } from './imageBatchDownload';

describe('canvas browser media output', () => {
  it('keeps completed image and video assets in selection order', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'upload-1',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: {
          imageUrl: null,
          aspectRatio: '1:1',
          assetId: 'asset-image',
          sourceFileName: 'reference.png',
        },
      },
      {
        id: 'video-1',
        type: CANVAS_NODE_TYPES.exportVideo,
        position: { x: 0, y: 0 },
        data: {
          assetId: 'asset-video',
          videoUrl: null,
          aspectRatio: '16:9',
          model: 'seedance-2.0',
        },
      },
      {
        id: 'pending-video',
        type: CANVAS_NODE_TYPES.exportVideo,
        position: { x: 0, y: 0 },
        data: {
          assetId: 'asset-pending',
          videoUrl: null,
          aspectRatio: '16:9',
          model: 'seedance-2.0',
          isGenerating: true,
        },
      },
    ];

    expect(resolveDownloadableCanvasMedia(nodes)).toEqual([
      {
        nodeId: 'upload-1',
        kind: 'image',
        assetId: 'asset-image',
        suggestedFileName: 'reference.png',
      },
      {
        nodeId: 'video-1',
        kind: 'video',
        assetId: 'asset-video',
        suggestedFileName: 'node-video-1.mp4',
      },
    ]);
  });
});
