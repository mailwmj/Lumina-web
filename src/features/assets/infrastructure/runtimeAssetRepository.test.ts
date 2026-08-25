import { describe, expect, it, vi } from 'vitest';

import type { RuntimeProjectClient } from '@/runtime/runtimeProjectClient';
import { createRuntimeAssetRepository } from './runtimeAssetRepository';

function runtimeMetadata(assetId = 'asset-1') {
  return {
    assetId,
    projectId: 'project-1',
    kind: 'image' as const,
    mimeType: 'image/png',
    byteCount: 6,
    createdAt: 10,
    sourceKind: 'import' as const,
    width: 3,
    height: 2,
    durationMs: null,
    sourceMetadata: { fileName: 'source.png' },
  };
}

describe('RuntimeAssetRepository', () => {
  it('writes admitted metadata and bytes through the shared Runtime client', async () => {
    const writeAsset = vi.fn().mockResolvedValue(runtimeMetadata());
    const repository = createRuntimeAssetRepository({ writeAsset } as unknown as RuntimeProjectClient, {
      createAssetId: () => 'asset-1',
      now: () => 10,
      objectUrlApi: { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() },
    });
    const blob = new Blob(['pixels'], { type: 'image/png' });

    await expect(repository.write({
      projectId: 'project-1',
      kind: 'image',
      sourceKind: 'import',
      blob,
      width: 3,
      height: 2,
      sourceMetadata: { fileName: 'source.png' },
    })).resolves.toEqual(runtimeMetadata());
    expect(writeAsset).toHaveBeenCalledWith({
      assetId: 'asset-1',
      projectId: 'project-1',
      kind: 'image',
      sourceKind: 'import',
      mimeType: 'image/png',
      createdAt: 10,
      width: 3,
      height: 2,
      durationMs: null,
      sourceMetadata: { fileName: 'source.png' },
    }, blob);
  });

  it('deduplicates hydration and revokes the Object URL after the final lease', async () => {
    const readAsset = vi.fn().mockResolvedValue(new Blob(['pixels'], { type: 'image/png' }));
    const revokeObjectURL = vi.fn();
    const repository = createRuntimeAssetRepository({ readAsset } as unknown as RuntimeProjectClient, {
      objectUrlApi: {
        createObjectURL: vi.fn(() => 'blob:asset-1'),
        revokeObjectURL,
      },
    });

    const [first, second] = await Promise.all([
      repository.hydrateObjectUrl('asset-1'),
      repository.hydrateObjectUrl('asset-1'),
    ]);
    expect(first).toBe('blob:asset-1');
    expect(second).toBe(first);
    expect(readAsset).toHaveBeenCalledTimes(1);

    repository.releaseObjectUrl('asset-1');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    repository.releaseObjectUrl('asset-1');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:asset-1');
  });

  it('blocks new hydration after deletion but restores access when deletion is rejected', async () => {
    const readAsset = vi.fn().mockResolvedValue(new Blob(['pixels'], { type: 'image/png' }));
    const deleteAsset = vi.fn()
      .mockRejectedValueOnce(new Error('asset still referenced'))
      .mockResolvedValueOnce(true);
    const repository = createRuntimeAssetRepository({
      readAsset,
      deleteAsset,
    } as unknown as RuntimeProjectClient, {
      objectUrlApi: {
        createObjectURL: vi.fn(() => 'blob:asset-1'),
        revokeObjectURL: vi.fn(),
      },
    });

    await expect(repository.delete('asset-1')).rejects.toThrow('asset still referenced');
    await expect(repository.hydrateObjectUrl('asset-1')).resolves.toBe('blob:asset-1');
    repository.releaseObjectUrl('asset-1');

    await repository.delete('asset-1');
    await expect(repository.hydrateObjectUrl('asset-1')).resolves.toBeNull();
  });
});
