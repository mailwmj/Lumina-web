import { describe, expect, it } from 'vitest';

import type { AssetRepository } from './assetRepository';

export function defineAssetRepositoryContract(
  implementationName: string,
  createRepository: () => AssetRepository,
): void {
  describe(`${implementationName} AssetRepository contract`, () => {
    it('round-trips Blob bytes and media metadata under a stable assetId', async () => {
      const repository = createRepository();
      const written = await repository.write({
        projectId: 'project-1',
        kind: 'image',
        blob: new Blob(['image-bytes'], { type: 'image/png' }),
        sourceKind: 'import',
        width: 1280,
        height: 720,
        sourceMetadata: { fileName: 'source.png' },
      });

      expect(written).toMatchObject({
        projectId: 'project-1',
        kind: 'image',
        mimeType: 'image/png',
        byteCount: 11,
        createdAt: expect.any(Number),
        sourceKind: 'import',
        width: 1280,
        height: 720,
        durationMs: null,
        sourceMetadata: { fileName: 'source.png' },
      });
      expect(written.assetId).toBeTruthy();
      expect(await (await repository.read(written.assetId))?.text()).toBe('image-bytes');
      expect(await repository.getMetadata(written.assetId)).toEqual(written);
    });

    it('reuses hydrated Object URLs until every lease is released and revokes them on delete', async () => {
      const repository = createRepository();
      const asset = await repository.write({
        projectId: 'project-1',
        kind: 'image',
        sourceKind: 'derived',
        blob: new Blob(['image'], { type: 'image/png' }),
      });

      const first = await repository.hydrateObjectUrl(asset.assetId);
      const second = await repository.hydrateObjectUrl(asset.assetId);
      expect(first).toBeTruthy();
      expect(second).toBe(first);

      repository.releaseObjectUrl(asset.assetId);
      expect(await repository.hydrateObjectUrl(asset.assetId)).toBe(first);
      repository.releaseObjectUrl(asset.assetId);
      repository.releaseObjectUrl(asset.assetId);

      const afterRelease = await repository.hydrateObjectUrl(asset.assetId);
      expect(afterRelease).not.toBe(first);

      await repository.delete(asset.assetId);
      expect(await repository.read(asset.assetId)).toBeNull();
      expect(await repository.getMetadata(asset.assetId)).toBeNull();
      expect(await repository.hydrateObjectUrl(asset.assetId)).toBeNull();
    });
  });
}
