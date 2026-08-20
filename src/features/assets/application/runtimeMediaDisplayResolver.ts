import {
  resolveAudioDisplayUrl,
  resolveImageDisplayUrl,
  resolveVideoDisplayUrl,
} from '@/features/canvas/application/imageData';
import type { AssetKind } from '@/features/assets/domain/assetRepository';
import {
  createMediaDisplayResolver,
  type AssetObjectUrlRepository,
} from './mediaDisplayResolver';

export function resolveLegacyMediaDisplayUrl(kind: AssetKind, url: string): string {
  switch (kind) {
    case 'image':
      return resolveImageDisplayUrl(url);
    case 'video':
      return resolveVideoDisplayUrl(url);
    case 'audio':
      return resolveAudioDisplayUrl(url);
  }
}

export function createRuntimeMediaDisplayResolver(
  assetRepository: AssetObjectUrlRepository | null,
) {
  return createMediaDisplayResolver(assetRepository, resolveLegacyMediaDisplayUrl);
}

// Browser asset storage is introduced in T06. Until then, the expand phase
// keeps every persisted legacy URL readable through the same resolver.
export const runtimeMediaDisplayResolver = createRuntimeMediaDisplayResolver(null);
