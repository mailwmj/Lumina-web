import { describe, expect, it, vi } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveDownloadableCanvasImages,
  saveCanvasImagesToDirectory,
} from './imageBatchDownload';
import type { MediaDisplayResolver } from '@/features/assets/application/mediaDisplayResolver';

function uploadNode(id: string, imageUrl: string | null): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.upload,
    position: { x: 0, y: 0 },
    data: {
      imageUrl,
      aspectRatio: '1:1',
    },
  };
}

function outputNode(id: string, imageUrl: string | null): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.exportImage,
    position: { x: 0, y: 0 },
    data: {
      imageUrl,
      aspectRatio: '1:1',
    },
  };
}

describe('image batch download', () => {
  it('keeps only concrete selected image assets in selection order', () => {
    const nodes: CanvasNode[] = [
      uploadNode('upload-1', 'data:image/png;base64,abc'),
      {
        id: 'text-1',
        type: CANVAS_NODE_TYPES.textGeneration,
        position: { x: 0, y: 0 },
        data: {
          inputText: 'ignore me',
          generatedText: null,
        },
      },
      outputNode(
        'output-1',
        '/projects/project-1/outputs/images/AI_Media_GPT_Image_1_20260812_143015_a1b2c3d4.webp'
      ),
      {
        ...outputNode('pending-output', 'data:image/png;base64,pending'),
        data: {
          imageUrl: 'data:image/png;base64,pending',
          aspectRatio: '1:1',
          isGenerating: true,
        },
      },
    ];

    expect(resolveDownloadableCanvasImages(nodes)).toEqual([
      {
        nodeId: 'upload-1',
        source: 'data:image/png;base64,abc',
        suggestedFileName: 'node-upload-1',
      },
      {
        nodeId: 'output-1',
        source: '/projects/project-1/outputs/images/AI_Media_GPT_Image_1_20260812_143015_a1b2c3d4.webp',
        suggestedFileName: 'AI_Media_GPT_Image_1_20260812_143015_a1b2c3d4',
      },
    ]);
  });

  it('continues saving after one image fails and reports the exact result', async () => {
    const saveImage = vi.fn()
      .mockResolvedValueOnce('/downloads/first.png')
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce('/downloads/third.png');
    const images = [
      { nodeId: 'first', source: 'first', suggestedFileName: 'node-first' },
      { nodeId: 'second', source: 'second', suggestedFileName: 'node-second' },
      { nodeId: 'third', source: 'third', suggestedFileName: 'node-third' },
    ];

    await expect(saveCanvasImagesToDirectory(images, '/downloads', saveImage)).resolves.toEqual({
      savedPaths: ['/downloads/first.png', '/downloads/third.png'],
      failedNodeIds: ['second'],
    });
    expect(saveImage).toHaveBeenCalledTimes(3);
  });

  it('hydrates and releases stable assets when saving a selected image', async () => {
    const assetNode = uploadNode('asset-upload', null);
    assetNode.data = { ...assetNode.data, assetId: 'asset-image-1' };
    const images = resolveDownloadableCanvasImages([assetNode]);
    const release = vi.fn();
    const resolver: MediaDisplayResolver = {
      resolve: vi.fn(async () => ({
        url: 'blob:asset-image-1',
        source: 'asset' as const,
        release,
      })),
    };
    const saveImage = vi.fn(async () => '/downloads/asset-image.png');

    expect(images).toEqual([{
      nodeId: 'asset-upload',
      assetId: 'asset-image-1',
      suggestedFileName: 'node-asset-upload',
    }]);
    await expect(saveCanvasImagesToDirectory(images, '/downloads', saveImage, resolver))
      .resolves.toEqual({
        savedPaths: ['/downloads/asset-image.png'],
        failedNodeIds: [],
      });
    expect(saveImage).toHaveBeenCalledWith(
      'blob:asset-image-1',
      '/downloads',
      'node-asset-upload',
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
