import { describe, expect, it } from 'vitest';

import type {
  AssetMetadata,
  AssetRepository,
  AssetWriteInput,
} from '@/features/assets/domain/assetRepository';
import {
  readStoryboardAssetMetadata,
  writeBrowserDerivedImageAsset,
} from './browserDerivedImage';

function createRepository(): AssetRepository {
  const records = new Map<string, AssetMetadata>();
  let sequence = 0;

  return {
    async write(input: AssetWriteInput): Promise<AssetMetadata> {
      const metadata: AssetMetadata = {
        assetId: `asset-${++sequence}`,
        projectId: input.projectId,
        kind: input.kind,
        mimeType: input.blob.type,
        byteCount: input.blob.size,
        createdAt: 1,
        sourceKind: input.sourceKind,
        width: input.width ?? null,
        height: input.height ?? null,
        durationMs: input.durationMs ?? null,
        sourceMetadata: input.sourceMetadata ?? {},
      };
      records.set(metadata.assetId, metadata);
      return metadata;
    },
    async getMetadata(assetId) {
      return records.get(assetId) ?? null;
    },
  } as AssetRepository;
}

describe('browser derived image assets', () => {
  it('persists storyboard metadata with a derived asset and reads it back by stable identity', async () => {
    const repository = createRepository();
    const metadata = {
      gridRows: 2,
      gridCols: 3,
      frameNotes: ['opening', 'middle', 'ending'],
      exportOptions: {
        showFrameIndex: true,
        showFrameNote: true,
        notePlacement: 'bottom' as const,
        imageFit: 'contain' as const,
        frameIndexPrefix: 'S',
        cellGap: 12,
        outerPadding: 16,
        fontSize: 5,
        backgroundColor: '#101010',
        textColor: '#fefefe',
      },
    };

    const written = await writeBrowserDerivedImageAsset({
      projectId: 'project-1',
      blob: new Blob(['storyboard pixels'], { type: 'image/png' }),
      width: 1200,
      height: 800,
      metadata,
    }, repository);

    expect(written).toMatchObject({
      assetId: 'asset-1',
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: '3:2',
    });
    await expect(readStoryboardAssetMetadata(written.assetId, repository)).resolves.toEqual(metadata);
  });

  it('retains caller metadata alongside the derived image bytes', async () => {
    const repository = createRepository();
    const written = await writeBrowserDerivedImageAsset({
      projectId: 'project-1',
      blob: new Blob(['result'], { type: 'image/jpeg' }),
      width: 1440,
      height: 1920,
      sourceMetadata: { fileName: 'look_1440x1920.jpg' },
    }, repository);

    await expect(repository.getMetadata(written.assetId)).resolves.toMatchObject({
      sourceMetadata: { fileName: 'look_1440x1920.jpg' },
    });
  });
});
