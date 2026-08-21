import { describe, expect, it, vi } from 'vitest';

import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import { StorageCapacityError } from '@/runtime/browserStorage';
import { writeBrowserGeneratedAsset } from './browserGeneratedAsset';
import { writeBrowserGeneratedImage } from './browserGeneratedImage';

function repository(write: AssetRepository['write']): AssetRepository {
  return { write } as unknown as AssetRepository;
}

describe('writeBrowserGeneratedImage', () => {
  it('writes the fetched result before returning its stable asset id', async () => {
    const write = vi.fn().mockResolvedValue({
      assetId: 'asset-generated',
      projectId: 'project-1',
      kind: 'image',
      mimeType: 'image/png',
      byteCount: 4,
      createdAt: 1,
      sourceKind: 'generation',
      width: null,
      height: null,
      durationMs: null,
      sourceMetadata: {},
      lifecycleState: 'active',
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Blob(['data'], { type: 'image/png' }), { status: 200 }),
    );
    const result = await writeBrowserGeneratedImage({
      source: '/api/generation/jobs/job-1/result',
      projectId: 'project-1',
      providerId: 'ai-media',
      model: 'ai-media/gpt-image-2',
    }, repository(write), { assertCanWrite: vi.fn() }, fetchImpl);

    expect(result.assetId).toBe('asset-generated');
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      sourceKind: 'generation',
      blob: expect.any(Blob),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/generation/jobs/job-1/result/confirmed', {
      method: 'POST',
      credentials: 'same-origin',
    });
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(fetchImpl.mock.invocationCallOrder[1]);
  });

  it('does not write when capacity is rejected and normalizes late quota errors', async () => {
    const write = vi.fn().mockRejectedValue(Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
    const fetchImpl = vi.fn().mockImplementation(() => (
      Promise.resolve(new Response(new Blob(['data']), { status: 200 }))
    ));
    await expect(writeBrowserGeneratedImage({
      source: 'result', projectId: 'project-1', providerId: 'ai-media', model: 'ai-media/gpt-image-2',
    }, repository(write), {
      assertCanWrite: vi.fn().mockRejectedValue(new StorageCapacityError('insufficient-capacity', 'full')),
    }, fetchImpl)).rejects.toBeInstanceOf(StorageCapacityError);
    expect(write).not.toHaveBeenCalled();

    await expect(writeBrowserGeneratedImage({
      source: 'result', projectId: 'project-1', providerId: 'ai-media', model: 'ai-media/gpt-image-2',
    }, repository(write), { assertCanWrite: vi.fn() }, fetchImpl)).rejects.toMatchObject({ code: 'quota-exceeded' });
  });

  it('writes a generated video Blob as a stable browser video asset', async () => {
    const write = vi.fn().mockResolvedValue({
      assetId: 'asset-video',
      mimeType: 'video/mp4',
      byteCount: 5,
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Blob(['video'], { type: 'video/mp4' }), { status: 200 }),
    );

    await expect(writeBrowserGeneratedAsset({
      source: 'https://cdn.example.test/video.mp4',
      projectId: 'project-1',
      providerId: 'volcvideo',
      model: 'doubao-seedance-2-0-260128',
      kind: 'video',
    }, repository(write), { assertCanWrite: vi.fn() }, fetchImpl)).resolves.toEqual({
      assetId: 'asset-video',
      mimeType: 'video/mp4',
      byteCount: 5,
    });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video',
      sourceKind: 'generation',
      blob: expect.any(Blob),
    }));
  });
});
