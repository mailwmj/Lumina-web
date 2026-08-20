// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaDisplayResolver } from '@/features/assets/application/mediaDisplayResolver';
import { useMediaDisplayUrl, useMediaDisplayUrls } from './useMediaDisplayUrl';

function DisplayUrlProbe({
  assetId,
  resolver,
}: {
  assetId: string;
  resolver: MediaDisplayResolver;
}) {
  const url = useMediaDisplayUrl({ kind: 'image', assetId }, resolver);
  return <span>{url}</span>;
}

describe('useMediaDisplayUrl', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('releases hydrated leases when the reference changes and when the consumer unmounts', async () => {
    const releases: string[] = [];
    const resolver: MediaDisplayResolver = {
      resolve: vi.fn(async ({ assetId }) => ({
        url: `blob:${assetId}`,
        source: 'asset' as const,
        release: () => {
          releases.push(String(assetId));
        },
      })),
    };

    await act(async () => {
      root.render(<DisplayUrlProbe assetId="asset-1" resolver={resolver} />);
    });
    expect(container.textContent).toBe('blob:asset-1');

    await act(async () => {
      root.render(<DisplayUrlProbe assetId="asset-2" resolver={resolver} />);
    });
    expect(container.textContent).toBe('blob:asset-2');
    expect(releases).toEqual(['asset-1']);

    await act(async () => root.unmount());
    expect(releases).toEqual(['asset-1', 'asset-2']);
    root = createRoot(container);
  });

  it('keeps the legacy display URL when asset hydration rejects', async () => {
    const resolver: MediaDisplayResolver = {
      resolve: vi.fn(async () => {
        throw new Error('asset unavailable');
      }),
    };

    function LegacyProbe() {
      const url = useMediaDisplayUrl({
        kind: 'image',
        assetId: 'missing-asset',
        legacyUrl: 'https://legacy.example/image.png',
      }, resolver);
      return <span>{url}</span>;
    }

    await act(async () => {
      root.render(<LegacyProbe />);
    });

    expect(container.textContent).toBe('https://legacy.example/image.png');
  });

  it('releases every hydrated lease when a media reference list changes', async () => {
    const releases: string[] = [];
    const resolver: MediaDisplayResolver = {
      resolve: vi.fn(async ({ assetId }) => ({
        url: `blob:${assetId}`,
        source: 'asset' as const,
        release: () => releases.push(String(assetId)),
      })),
    };

    function ListProbe({ assetIds }: { assetIds: string[] }) {
      const urls = useMediaDisplayUrls(
        assetIds.map((assetId) => ({ kind: 'image' as const, assetId })),
        resolver,
      );
      return <span>{urls.join(',')}</span>;
    }

    await act(async () => {
      root.render(<ListProbe assetIds={['asset-1', 'asset-2']} />);
    });
    expect(container.textContent).toBe('blob:asset-1,blob:asset-2');

    await act(async () => {
      root.render(<ListProbe assetIds={['asset-3']} />);
    });
    expect(container.textContent).toBe('blob:asset-3');
    expect(releases).toEqual(['asset-1', 'asset-2']);

    await act(async () => root.unmount());
    expect(releases).toEqual(['asset-1', 'asset-2', 'asset-3']);
    root = createRoot(container);
  });
});
