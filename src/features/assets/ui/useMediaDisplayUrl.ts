import { useEffect, useMemo, useState } from 'react';

import {
  resolveLegacyMediaDisplayUrl,
  runtimeMediaDisplayResolver,
} from '@/features/assets/application/runtimeMediaDisplayResolver';
import type {
  MediaDisplayResolver,
  MediaReference,
  ResolvedMediaUrl,
} from '@/features/assets/application/mediaDisplayResolver';

export function useMediaDisplayUrl(
  reference: MediaReference,
  resolver: MediaDisplayResolver = runtimeMediaDisplayResolver,
): string | null {
  const legacyFallback = useMemo(() => {
    const legacyUrl = reference.legacyUrl?.trim();
    return legacyUrl ? resolveLegacyMediaDisplayUrl(reference.kind, legacyUrl) : null;
  }, [reference.kind, reference.legacyUrl]);
  const [displayUrl, setDisplayUrl] = useState<string | null>(legacyFallback);

  useEffect(() => {
    let active = true;
    let lease: ResolvedMediaUrl | null = null;
    setDisplayUrl(legacyFallback);

    void resolver.resolve(reference).then(
      (resolved) => {
        if (!active) {
          resolved?.release();
          return;
        }
        lease = resolved;
        setDisplayUrl(resolved?.url ?? null);
      },
      () => {
        if (active) {
          setDisplayUrl(legacyFallback);
        }
      },
    );

    return () => {
      active = false;
      lease?.release();
    };
  }, [legacyFallback, reference.assetId, reference.kind, reference.legacyUrl, resolver]);

  return displayUrl;
}
