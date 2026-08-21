import { describe, expect, it, vi } from 'vitest';

import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import type { BrowserMediaGateway } from '@/features/media/infrastructure/browserMediaGateway';
import { prepareBrowserAssetTemporaryMedia } from './browserTemporaryPublicMedia';

describe('browser temporary public media', () => {
  it('normalizes an assetId to a provider-scoped runtime grant without returning a node URL', async () => {
    const blob = new Blob(['video'], { type: 'video/mp4' });
    const repository = {
      getMetadata: vi.fn(async () => ({
        assetId: 'asset-video-1',
        projectId: 'project-1',
        kind: 'video' as const,
        mimeType: 'video/mp4',
        byteCount: blob.size,
        createdAt: 1,
        sourceKind: 'import' as const,
        width: 1_280,
        height: 720,
        durationMs: 2_000,
        sourceMetadata: { fileName: 'clip.mp4' },
        lifecycleState: 'active' as const,
      })),
      read: vi.fn(async () => blob),
    } as unknown as AssetRepository;
    const publish = vi.fn(async () => ({
      key: 'media-opaque-id',
      url: 'https://lumina.test/api/generation/media/media-opaque-id?grant=opaque',
      expiresAt: 2,
      contentType: 'video/mp4',
      sizeBytes: blob.size,
    }));

    const grant = await prepareBrowserAssetTemporaryMedia({
      assetId: 'asset-video-1',
      providerId: 'volcengine-seedance',
      repository,
      gateway: { publish } as unknown as BrowserMediaGateway,
    });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      name: 'clip.mp4',
      type: 'video/mp4',
    }), 'video', 'volcengine-seedance');
    expect(grant).toMatchObject({ key: 'media-opaque-id' });
    expect(grant).not.toHaveProperty('assetId');
  });
});
