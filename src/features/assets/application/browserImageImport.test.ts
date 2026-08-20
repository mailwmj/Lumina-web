import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import { StorageCapacityError } from '@/runtime/browserStorage';
import { importBrowserImageAsset } from './browserImageImport';

describe('browser image import', () => {
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 640,
      height: 480,
      close: vi.fn(),
    })));
  });

  it('writes the source Blob and returns an asset-only node payload', async () => {
    const write = vi.fn(async () => ({
      assetId: 'asset-1',
      projectId: 'project-1',
      kind: 'image' as const,
      mimeType: 'image/png',
      byteCount: 4,
      createdAt: 123,
      sourceKind: 'import' as const,
      width: 640,
      height: 480,
      durationMs: null,
      sourceMetadata: { fileName: 'photo.png' },
      lifecycleState: 'active' as const,
    }));
    const repository = { write } as unknown as AssetRepository;

    const result = await importBrowserImageAsset(
      new File(['data'], 'photo.png', { type: 'image/png' }),
      'project-1',
      repository,
    );

    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      kind: 'image',
      sourceKind: 'import',
      width: 640,
      height: 480,
      sourceMetadata: { fileName: 'photo.png' },
    }));
    expect(result).toEqual({
      assetId: 'asset-1',
      previewAssetId: null,
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: '4:3',
      width: 640,
      height: 480,
      sourceFileName: 'photo.png',
    });
  });

  it('checks available browser storage before decoding or writing the imported Blob', async () => {
    const assertCanWrite = vi.fn().mockRejectedValue(new StorageCapacityError(
      'insufficient-capacity',
      'Browser storage does not have enough free space for this media operation.',
    ));
    const write = vi.fn();
    const file = new File(['data'], 'photo.png', { type: 'image/png' });

    await expect(importBrowserImageAsset(
      file,
      'project-1',
      { write } as unknown as AssetRepository,
      { assertCanWrite },
    )).rejects.toMatchObject({ code: 'insufficient-capacity' });

    expect(assertCanWrite).toHaveBeenCalledWith(file.size);
    expect(write).not.toHaveBeenCalled();
    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
  });

  it('turns a late IndexedDB quota failure into a recoverable capacity error', async () => {
    const write = vi.fn().mockRejectedValue(new DOMException('full', 'QuotaExceededError'));

    await expect(importBrowserImageAsset(
      new File(['data'], 'photo.png', { type: 'image/png' }),
      'project-1',
      { write } as unknown as AssetRepository,
      { assertCanWrite: vi.fn().mockResolvedValue(undefined) },
    )).rejects.toMatchObject({
      name: 'StorageCapacityError',
      code: 'quota-exceeded',
    });
  });

  it('recovers a quota error wrapped by the IndexedDB transaction boundary', async () => {
    const write = vi.fn().mockRejectedValue({
      name: 'WebDatabaseError',
      cause: new DOMException('full', 'QuotaExceededError'),
    });

    await expect(importBrowserImageAsset(
      new File(['data'], 'photo.png', { type: 'image/png' }),
      'project-1',
      { write } as unknown as AssetRepository,
      { assertCanWrite: vi.fn().mockResolvedValue(undefined) },
    )).rejects.toMatchObject({
      name: 'StorageCapacityError',
      code: 'quota-exceeded',
    });
  });
});
