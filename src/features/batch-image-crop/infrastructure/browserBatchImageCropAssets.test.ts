import { describe, expect, it, vi } from 'vitest';

import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import {
  downloadBrowserBatchCropResult,
  writeBrowserBatchCropResult,
} from './browserBatchImageCropAssets';

describe('browser batch crop result assets', () => {
  it('writes the completed JPG as a stable derived browser asset', async () => {
    const write = vi.fn().mockResolvedValue({ assetId: 'asset-output' });
    const result = await writeBrowserBatchCropResult({
      projectId: 'project-1',
      sourceFileName: 'look.book.png',
      target: { width: 1440, height: 1920 },
      blob: new Blob(['jpg'], { type: 'image/jpeg' }),
    }, { write } as unknown as AssetRepository, { assertCanWrite: vi.fn() });

    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      kind: 'image',
      sourceKind: 'derived',
      width: 1440,
      height: 1920,
      sourceMetadata: { fileName: 'look.book_1440x1920.jpg' },
    }));
    expect(result).toEqual({
      assetId: 'asset-output',
      fileName: 'look.book_1440x1920.jpg',
    });
  });

  it('downloads a hydrated asset through the common browser image downloader and releases its lease', async () => {
    const repository = {
      hydrateObjectUrl: vi.fn().mockResolvedValue('blob:batch-output'),
      releaseObjectUrl: vi.fn(),
    } as unknown as AssetRepository;
    const download = vi.fn();

    await downloadBrowserBatchCropResult('asset-output', 'look_1440x1920.jpg', repository, download);

    expect(download).toHaveBeenCalledWith('blob:batch-output', 'look_1440x1920.jpg');
    expect(repository.releaseObjectUrl).toHaveBeenCalledWith('asset-output');
  });
});
