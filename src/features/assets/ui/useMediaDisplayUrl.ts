import { useEffect, useMemo, useState } from 'react';

import {
  resolveLegacyMediaDisplayUrl,
  runtimeMediaDisplayResolver,
} from '@/runtime/mediaRuntime';
import type {
  MediaDisplayResolver,
  MediaReference,
} from '@/features/assets/application/mediaDisplayResolver';
import { resolveMediaReferences } from '@/features/assets/application/mediaDisplayResolver';

export function useMediaDisplayUrl(
  reference: MediaReference,
  resolver: MediaDisplayResolver = runtimeMediaDisplayResolver,
): string | null {
  return useMediaDisplayUrls([reference], resolver)[0] ?? null;
}

export function useMediaDisplayUrls(
  references: readonly MediaReference[],
  resolver: MediaDisplayResolver = runtimeMediaDisplayResolver,
): Array<string | null> {
  const referenceKey = JSON.stringify(references.map((reference) => [
    reference.kind,
    reference.assetId ?? null,
    reference.legacyUrl ?? null,
  ]));
  const stableReferences = useMemo(
    () => references.map((reference) => ({ ...reference })),
    // The serialized identity avoids a resolve/release loop for inline arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [referenceKey],
  );
  const legacyFallbacks = useMemo(
    () => stableReferences.map((reference) => {
      const legacyUrl = reference.legacyUrl?.trim();
      return legacyUrl ? resolveLegacyMediaDisplayUrl(reference.kind, legacyUrl) : null;
    }),
    [stableReferences],
  );
  const [displayUrls, setDisplayUrls] = useState<Array<string | null>>(legacyFallbacks);

  useEffect(() => {
    let active = true;
    let release: () => void = () => undefined;
    setDisplayUrls(legacyFallbacks);

    void resolveMediaReferences(resolver, stableReferences).then(
      (resolved) => {
        if (!active) {
          resolved.release();
          return;
        }
        release = resolved.release;
        setDisplayUrls(resolved.urls);
      },
      () => {
        if (active) {
          setDisplayUrls(legacyFallbacks);
        }
      },
    );

    return () => {
      active = false;
      release();
    };
  }, [legacyFallbacks, resolver, stableReferences]);

  return displayUrls;
}
