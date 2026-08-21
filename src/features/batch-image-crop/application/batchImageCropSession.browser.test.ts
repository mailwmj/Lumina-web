import { describe, expect, it, vi } from 'vitest';

import { createDefaultFixedCanvasDraft, type BatchCropImageItem } from '../domain';
import { createBatchImageCropSession } from './batchImageCropSession';

const item: BatchCropImageItem = {
  id: 'image-1',
  sourcePath: 'blob:source',
  fileName: 'look.jpg',
  fileSize: 1,
  previewPath: 'blob:preview',
  thumbnailPath: 'blob:thumbnail',
  width: 100,
  height: 200,
  rotationDegrees: 0,
  compositionMode: 'crop',
  status: 'confirmed',
  cropStatus: 'confirmed',
  crop: { x: 0, y: 0, width: 1, height: 1 },
  automaticCrop: { x: 0, y: 0, width: 1, height: 1 },
  requiresReview: false,
  lowResolution: false,
  fixedCanvas: createDefaultFixedCanvasDraft(),
};

describe('browser batch crop session', () => {
  it('writes and downloads a crop result through its project asset owner', async () => {
    const renderCrop = vi.fn().mockResolvedValue(new Blob(['jpg'], { type: 'image/jpeg' }));
    const writeResult = vi.fn().mockResolvedValue({ assetId: 'asset-output', fileName: 'look_1440x1920.jpg' });
    const downloadResult = vi.fn().mockResolvedValue(undefined);
    const recordResult = vi.fn().mockResolvedValue(undefined);
    const session = createBatchImageCropSession({
      isDesktop: () => false,
      projectId: 'project-1',
      browserGateway: {
        prepare: vi.fn(),
        renderCrop,
        renderFixedCanvas: vi.fn(),
        renderFixedCanvasBlob: vi.fn(),
        cleanup: vi.fn(),
      },
      getAssetRepository: () => ({}) as never,
      writeBrowserResult: writeResult,
      downloadBrowserResult: downloadResult,
      recordBrowserResult: recordResult,
    });

    await expect(session.exportItem(item, { id: '1440x1920', width: 1440, height: 1920 }, null))
      .resolves.toEqual({ outputAssetId: 'asset-output' });

    expect(renderCrop).toHaveBeenCalledWith({
      sourcePath: 'blob:source',
      rotationDegrees: 0,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      target: { id: '1440x1920', width: 1440, height: 1920 },
    });
    expect(writeResult).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      sourceFileName: 'look.jpg',
    }), expect.anything());
    expect(recordResult).toHaveBeenCalledWith({
      assetId: 'asset-output',
      fileName: 'look_1440x1920.jpg',
      target: { id: '1440x1920', width: 1440, height: 1920 },
    });
    expect(downloadResult).toHaveBeenCalledWith('asset-output', 'look_1440x1920.jpg', expect.anything());
  });

  it('releases only transient browser resources when clearing a batch', async () => {
    const gatewayCleanup = vi.fn();
    const session = createBatchImageCropSession({
      isDesktop: () => false,
      browserGateway: {
        prepare: vi.fn(),
        renderCrop: vi.fn(),
        renderFixedCanvas: vi.fn(),
        renderFixedCanvasBlob: vi.fn(),
        cleanup: gatewayCleanup,
      },
    });

    await session.releaseTransientResources('batch-1');
    expect(gatewayCleanup).toHaveBeenCalledWith('batch-1');

    await session.cleanup('batch-1');
    expect(gatewayCleanup).toHaveBeenCalledTimes(2);
  });
});
