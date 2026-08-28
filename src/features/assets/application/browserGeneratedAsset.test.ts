import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import { StorageCapacityError } from '@/runtime/browserStorage';
import { writeBrowserGeneratedAsset } from './browserGeneratedAsset';
import { writeBrowserGeneratedImage } from './browserGeneratedImage';

function repository(write: AssetRepository['write']): AssetRepository {
  return { write } as unknown as AssetRepository;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('releases a same-origin Gateway media result after the Runtime asset is written', async () => {
    vi.stubGlobal('location', { origin: 'https://lumina.test' });
    const write = vi.fn().mockResolvedValue({
      assetId: 'asset-video',
      mimeType: 'video/mp4',
      byteCount: 5,
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(new Blob(['video'], { type: 'video/mp4' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const source = 'https://lumina.test/api/generation/media/media-01234567-89ab-cdef-0123-456789abcdef'
      + '?grant=89abcdef-0123-4567-89ab-cdef01234567&provider=volcengine-seedance-result';

    await expect(writeBrowserGeneratedAsset({
      source,
      projectId: 'project-1',
      providerId: 'volcvideo',
      model: 'doubao-seedance-2-0-260128',
      kind: 'video',
    }, repository(write), { assertCanWrite: vi.fn() }, fetchImpl)).resolves.toMatchObject({
      assetId: 'asset-video',
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      '/api/generation/media/media-01234567-89ab-cdef-0123-456789abcdef',
      { method: 'DELETE', credentials: 'same-origin' },
    );
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(fetchImpl.mock.invocationCallOrder[1]);
  });

  it('keeps the Gateway media grant when the Runtime asset write fails', async () => {
    vi.stubGlobal('location', { origin: 'https://lumina.test' });
    const write = vi.fn().mockRejectedValue(new Error('Runtime write failed'));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Blob(['preview'], { type: 'image/jpeg' }), { status: 200 }),
    );
    const source = '/api/generation/media/media-11111111-2222-3333-4444-555555555555'
      + '?grant=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&provider=volcengine-seedance-result';

    await expect(writeBrowserGeneratedAsset({
      source,
      projectId: 'project-1',
      providerId: 'volcvideo',
      model: 'doubao-seedance-2-0-260128',
      kind: 'image',
    }, repository(write), { assertCanWrite: vi.fn() }, fetchImpl)).rejects.toThrow('Runtime write failed');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(source);
  });

  it('does not roll back a Runtime asset when Gateway media release fails', async () => {
    vi.stubGlobal('location', { origin: 'https://lumina.test' });
    const write = vi.fn().mockResolvedValue({
      assetId: 'asset-last-frame',
      mimeType: 'image/png',
      byteCount: 5,
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(new Blob(['frame'], { type: 'image/png' }), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('Gateway unavailable'));
    const source = '/api/generation/media/media-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      + '?grant=11111111-2222-3333-4444-555555555555&provider=volcengine-seedance-result';

    await expect(writeBrowserGeneratedAsset({
      source,
      projectId: 'project-1',
      providerId: 'volcvideo',
      model: 'doubao-seedance-2-0-260128',
      kind: 'image',
    }, repository(write), { assertCanWrite: vi.fn() }, fetchImpl)).resolves.toEqual({
      assetId: 'asset-last-frame',
      mimeType: 'image/png',
      byteCount: 5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
