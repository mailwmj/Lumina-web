import type {
  AssetId,
  AssetKind,
  AssetRepository,
} from '@/features/assets/domain/assetRepository';

export interface MediaReference {
  kind: AssetKind;
  assetId?: AssetId | null;
  legacyUrl?: string | null;
}

export interface ResolvedMediaUrl {
  url: string;
  source: 'asset' | 'legacy';
  release(): void;
}

export interface MediaDisplayResolver {
  resolve(reference: MediaReference): Promise<ResolvedMediaUrl | null>;
}

export type LegacyDisplayUrlResolver = (kind: AssetKind, url: string) => string;
export type AssetObjectUrlRepository = Pick<
  AssetRepository,
  'hydrateObjectUrl' | 'releaseObjectUrl'
>;

export function createMediaDisplayResolver(
  assetRepository: AssetObjectUrlRepository | null,
  resolveLegacyUrl: LegacyDisplayUrlResolver,
): MediaDisplayResolver {
  return {
    async resolve(reference) {
      const legacyUrl = reference.legacyUrl?.trim();
      const assetId = reference.assetId?.trim();
      if (assetRepository && assetId) {
        try {
          const objectUrl = await assetRepository.hydrateObjectUrl(assetId);
          if (objectUrl) {
            let released = false;
            return {
              url: objectUrl,
              source: 'asset',
              release: () => {
                if (!released) {
                  released = true;
                  assetRepository.releaseObjectUrl(assetId);
                }
              },
            };
          }
        } catch (error) {
          if (!legacyUrl) {
            throw error;
          }
        }
      }

      if (!legacyUrl) {
        return null;
      }

      return {
        url: resolveLegacyUrl(reference.kind, legacyUrl),
        source: 'legacy',
        release: () => undefined,
      };
    },
  };
}
