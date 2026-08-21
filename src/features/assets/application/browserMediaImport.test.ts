import { describe, expect, it, vi } from 'vitest';

import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import {
  importBrowserMediaAsset,
  type BrowserMediaMetadata,
} from './browserMediaImport';

function metadata(overrides: Partial<BrowserMediaMetadata> = {}): BrowserMediaMetadata {
  return {
    durationMs: 4_200,
    width: 1_920,
    height: 1_080,
    ...overrides,
  };
}

function repositoryWithAsset(assetId = 'asset-media-1') {
  const write = vi.fn(async () => ({
    assetId,
    projectId: 'project-1',
    kind: 'video' as const,
    mimeType: 'video/mp4',
    byteCount: 5,
    createdAt: 123,
    sourceKind: 'import' as const,
    width: 1_920,
    height: 1_080,
    durationMs: 4_200,
    sourceMetadata: { fileName: 'clip.mp4' },
    lifecycleState: 'active' as const,
  }));
  return { repository: { write } as unknown as AssetRepository, write };
}

describe('browser media import', () => {
  it('reads reliable media locally and returns an asset-only video node payload', async () => {
    const { repository, write } = repositoryWithAsset();
    const readMetadata = vi.fn(async () => metadata());
    const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });

    const result = await importBrowserMediaAsset(file, 'project-1', repository, {
      readMetadata,
      assertCanWrite: vi.fn().mockResolvedValue(undefined),
    });

    expect(readMetadata).toHaveBeenCalledWith(file, 'video');
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      kind: 'video',
      blob: file,
      width: 1_920,
      height: 1_080,
      durationMs: 4_200,
      sourceMetadata: { fileName: 'clip.mp4', sourceMimeType: 'video/mp4' },
    }));
    expect(result).toEqual({
      assetId: 'asset-media-1',
      mediaUrl: null,
      sourceFileName: 'clip.mp4',
      sourceMimeType: 'video/mp4',
      mimeType: 'video/mp4',
      durationMs: 4_200,
      width: 1_920,
      height: 1_080,
    });
  });

  it('uses the Gateway for an unreliable input and stores only the converted asset identity', async () => {
    const { repository, write } = repositoryWithAsset('asset-converted-1');
    const transcoded = new File(['mp4'], 'clip.mp4', { type: 'video/mp4' });
    const transcode = vi.fn(async () => transcoded);

    const result = await importBrowserMediaAsset(
      new File(['mov'], 'clip.mov', { type: 'video/quicktime' }),
      'project-1',
      repository,
      {
        readMetadata: vi.fn(async () => metadata()),
        transcode,
        assertCanWrite: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(transcode).toHaveBeenCalledWith(expect.objectContaining({ name: 'clip.mov' }), 'video');
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      blob: transcoded,
      sourceMetadata: { fileName: 'clip.mov', sourceMimeType: 'video/quicktime' },
    }));
    expect(result).toMatchObject({
      assetId: 'asset-converted-1',
      mediaUrl: null,
      sourceFileName: 'clip.mov',
      sourceMimeType: 'video/quicktime',
      mimeType: 'video/mp4',
    });
  });

  it('does not write an asset or return a successful import when Gateway transcoding fails', async () => {
    const { repository, write } = repositoryWithAsset();

    await expect(importBrowserMediaAsset(
      new File(['flac'], 'voice.flac', { type: 'audio/flac' }),
      'project-1',
      repository,
      {
        readMetadata: vi.fn(async () => metadata({ width: null, height: null })),
        transcode: vi.fn().mockRejectedValue(new Error('Gateway transcode is temporarily unavailable.')),
        assertCanWrite: vi.fn().mockResolvedValue(undefined),
      },
    )).rejects.toThrow('Gateway transcode is temporarily unavailable.');

    expect(write).not.toHaveBeenCalled();
  });
});
