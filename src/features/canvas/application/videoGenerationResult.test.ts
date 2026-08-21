import { describe, expect, it, vi } from 'vitest';

import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import { persistBrowserVideoGenerationAssets } from './videoGenerationResult';

function repository() {
  return {
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as AssetRepository;
}

describe('video generation result assets', () => {
  it('persists video, preview, and optional last-frame media as separate browser assets', async () => {
    const writeAsset = vi.fn()
      .mockResolvedValueOnce({ assetId: 'video-asset' })
      .mockResolvedValueOnce({ assetId: 'preview-asset' })
      .mockResolvedValueOnce({ assetId: 'last-frame-asset' });

    await expect(persistBrowserVideoGenerationAssets({
      projectId: 'project-1',
      providerId: 'volcvideo',
      model: 'doubao-seedance-2-0-260128',
      result: 'https://cdn.example.test/video.mp4',
      preview: 'https://cdn.example.test/video.jpg',
      lastFrame: 'https://cdn.example.test/video-last.jpg',
      repository: repository(),
      isCurrent: () => true,
      writeAsset,
    })).resolves.toEqual({
      stale: false,
      videoAssetId: 'video-asset',
      previewAssetId: 'preview-asset',
      lastFrameAssetId: 'last-frame-asset',
    });

    expect(writeAsset.mock.calls.map(([input]) => input.kind)).toEqual(['video', 'image', 'image']);
  });

  it('deletes assets already written when the task becomes stale before commit', async () => {
    const repo = repository();
    const writeAsset = vi.fn()
      .mockResolvedValueOnce({ assetId: 'video-asset' })
      .mockResolvedValueOnce({ assetId: 'preview-asset' });
    let currentChecks = 0;

    await expect(persistBrowserVideoGenerationAssets({
      projectId: 'project-1',
      providerId: 'volcvideo',
      model: 'doubao-seedance-2-0-260128',
      result: 'https://cdn.example.test/video.mp4',
      preview: 'https://cdn.example.test/video.jpg',
      repository: repo,
      isCurrent: () => {
        currentChecks += 1;
        return currentChecks < 3;
      },
      writeAsset,
    })).resolves.toEqual({ stale: true });

    expect(repo.delete).toHaveBeenCalledWith('video-asset');
    expect(repo.delete).toHaveBeenCalledWith('preview-asset');
  });

  it('does not write any browser asset when the task is already stale', async () => {
    const writeAsset = vi.fn();

    await expect(persistBrowserVideoGenerationAssets({
      projectId: 'project-1',
      providerId: 'volcvideo',
      model: 'doubao-seedance-2-0-260128',
      result: 'https://cdn.example.test/video.mp4',
      repository: repository(),
      isCurrent: () => false,
      writeAsset,
    })).resolves.toEqual({ stale: true });

    expect(writeAsset).not.toHaveBeenCalled();
  });
});
