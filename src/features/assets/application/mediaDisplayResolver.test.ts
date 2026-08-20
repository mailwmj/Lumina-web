import { describe, expect, it, vi } from 'vitest';

import {
  createMediaDisplayResolver,
  resolveMediaReferences,
  type AssetObjectUrlRepository,
} from './mediaDisplayResolver';

describe('MediaDisplayResolver', () => {
  it('keeps legacy node URLs displayable without asset hydration', async () => {
    const resolveLegacyUrl = vi.fn((_kind: 'image' | 'video' | 'audio', url: string) => (
      `display:${url}`
    ));
    const resolver = createMediaDisplayResolver(null, resolveLegacyUrl);

    const resolved = await resolver.resolve({
      kind: 'image',
      assetId: null,
      legacyUrl: 'C:\\projects\\legacy.png',
    });

    expect(resolved?.url).toBe('display:C:\\projects\\legacy.png');
    expect(resolved?.source).toBe('legacy');
    expect(resolveLegacyUrl).toHaveBeenCalledWith('image', 'C:\\projects\\legacy.png');
    expect(() => resolved?.release()).not.toThrow();
  });

  it('hydrates asset references and releases each display lease once', async () => {
    const assetRepository: AssetObjectUrlRepository = {
      hydrateObjectUrl: vi.fn(async () => 'blob:asset-1'),
      releaseObjectUrl: vi.fn(),
    };
    const resolveLegacyUrl = vi.fn((_kind: 'image' | 'video' | 'audio', url: string) => url);
    const resolver = createMediaDisplayResolver(assetRepository, resolveLegacyUrl);

    const resolved = await resolver.resolve({
      kind: 'video',
      assetId: 'asset-1',
      legacyUrl: 'https://legacy.example/video.mp4',
    });

    expect(resolved).toMatchObject({ url: 'blob:asset-1', source: 'asset' });
    expect(assetRepository.hydrateObjectUrl).toHaveBeenCalledWith('asset-1');
    expect(resolveLegacyUrl).not.toHaveBeenCalled();

    resolved?.release();
    resolved?.release();
    expect(assetRepository.releaseObjectUrl).toHaveBeenCalledTimes(1);
    expect(assetRepository.releaseObjectUrl).toHaveBeenCalledWith('asset-1');
  });

  it('falls back to the legacy URL when asset hydration fails', async () => {
    const assetRepository: AssetObjectUrlRepository = {
      hydrateObjectUrl: vi.fn(async () => {
        throw new Error('asset unavailable');
      }),
      releaseObjectUrl: vi.fn(),
    };
    const resolver = createMediaDisplayResolver(
      assetRepository,
      (_kind, url) => `legacy:${url}`,
    );

    await expect(resolver.resolve({
      kind: 'audio',
      assetId: 'missing-asset',
      legacyUrl: 'C:\\projects\\legacy.mp3',
    })).resolves.toMatchObject({
      url: 'legacy:C:\\projects\\legacy.mp3',
      source: 'legacy',
    });
  });

  it('resolves a media batch and releases every acquired Object URL lease', async () => {
    const releaseObjectUrl = vi.fn();
    const assetRepository: AssetObjectUrlRepository = {
      hydrateObjectUrl: vi.fn(async (assetId) => `blob:${assetId}`),
      releaseObjectUrl,
    };
    const resolver = createMediaDisplayResolver(assetRepository, (_kind, url) => `display:${url}`);

    const batch = await resolveMediaReferences(resolver, [
      { kind: 'image', assetId: 'asset-1' },
      { kind: 'video', legacyUrl: 'https://legacy.example/video.mp4' },
    ]);

    expect(batch.urls).toEqual([
      'blob:asset-1',
      'display:https://legacy.example/video.mp4',
    ]);
    batch.release();
    batch.release();
    expect(releaseObjectUrl).toHaveBeenCalledTimes(1);
    expect(releaseObjectUrl).toHaveBeenCalledWith('asset-1');
  });

  it('releases successful leases when another media reference fails to resolve', async () => {
    const releaseObjectUrl = vi.fn();
    const assetRepository: AssetObjectUrlRepository = {
      hydrateObjectUrl: vi.fn(async (assetId) => {
        if (assetId === 'asset-broken') {
          throw new Error('hydrate failed');
        }
        return `blob:${assetId}`;
      }),
      releaseObjectUrl,
    };
    const resolver = createMediaDisplayResolver(assetRepository, (_kind, url) => url);

    await expect(resolveMediaReferences(resolver, [
      { kind: 'image', assetId: 'asset-ok' },
      { kind: 'image', assetId: 'asset-broken' },
    ])).rejects.toThrow('hydrate failed');

    expect(releaseObjectUrl).toHaveBeenCalledTimes(1);
    expect(releaseObjectUrl).toHaveBeenCalledWith('asset-ok');
  });
});
