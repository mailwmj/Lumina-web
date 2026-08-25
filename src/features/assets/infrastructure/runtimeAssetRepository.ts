import { v4 as uuidv4 } from 'uuid';

import type {
  AssetId,
  AssetMetadata,
  AssetRepository,
  AssetWriteInput,
} from '@/features/assets/domain/assetRepository';
import type { RuntimeProjectClient } from '@/runtime/runtimeProjectClient';

export interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface RuntimeAssetRepositoryOptions {
  objectUrlApi?: ObjectUrlApi;
  createAssetId?: () => AssetId;
  now?: () => number;
}

type RuntimeAssetMetadata = AssetMetadata;

function defaultObjectUrlApi(): ObjectUrlApi {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('Browser Object URL APIs are unavailable.');
  }
  return URL;
}

export function createRuntimeAssetRepository(
  client: RuntimeProjectClient,
  options: RuntimeAssetRepositoryOptions = {},
): AssetRepository {
  const objectUrlApi = options.objectUrlApi ?? defaultObjectUrlApi();
  const createAssetId = options.createAssetId ?? uuidv4;
  const now = options.now ?? Date.now;
  const objectUrls = new Map<AssetId, { url: string; leases: number }>();
  const pendingHydrations = new Map<AssetId, Promise<string | null>>();
  const deletedAssetIds = new Set<AssetId>();

  const cloneMetadata = (metadata: RuntimeAssetMetadata): AssetMetadata => ({
    ...metadata,
    sourceMetadata: { ...metadata.sourceMetadata },
  });

  return {
    async write(input: AssetWriteInput): Promise<AssetMetadata> {
      const assetId = createAssetId();
      const metadata = await client.writeAsset<RuntimeAssetMetadata>({
        assetId,
        projectId: input.projectId,
        kind: input.kind,
        sourceKind: input.sourceKind,
        mimeType: input.blob.type,
        createdAt: now(),
        width: input.width ?? null,
        height: input.height ?? null,
        durationMs: input.durationMs ?? null,
        sourceMetadata: input.sourceMetadata ?? {},
      }, input.blob);
      return cloneMetadata(metadata);
    },

    read(assetId: AssetId): Promise<Blob | null> {
      return client.readAsset(assetId);
    },

    async getMetadata(assetId: AssetId): Promise<AssetMetadata | null> {
      const metadata = await client.getAssetMetadata<RuntimeAssetMetadata>(assetId);
      return metadata ? cloneMetadata(metadata) : null;
    },

    async delete(assetId: AssetId): Promise<void> {
      deletedAssetIds.add(assetId);
      try {
        const pending = pendingHydrations.get(assetId);
        if (pending) await pending.catch(() => undefined);
        await client.deleteAsset(assetId);
      } catch (error) {
        deletedAssetIds.delete(assetId);
        throw error;
      }
    },

    async hydrateObjectUrl(assetId: AssetId): Promise<string | null> {
      if (deletedAssetIds.has(assetId)) return null;
      const current = objectUrls.get(assetId);
      if (current) {
        current.leases += 1;
        return current.url;
      }

      let pending = pendingHydrations.get(assetId);
      if (!pending) {
        pending = (async () => {
          const blob = await client.readAsset(assetId);
          if (!blob || deletedAssetIds.has(assetId)) return null;
          const url = objectUrlApi.createObjectURL(blob);
          objectUrls.set(assetId, { url, leases: 0 });
          return url;
        })();
        pendingHydrations.set(assetId, pending);
      }

      try {
        const url = await pending;
        if (!url) return null;
        const hydrated = objectUrls.get(assetId);
        if (hydrated) hydrated.leases += 1;
        return url;
      } finally {
        if (pendingHydrations.get(assetId) === pending) {
          pendingHydrations.delete(assetId);
        }
      }
    },

    releaseObjectUrl(assetId: AssetId): void {
      const current = objectUrls.get(assetId);
      if (!current) return;
      current.leases -= 1;
      if (current.leases <= 0) {
        objectUrls.delete(assetId);
        objectUrlApi.revokeObjectURL(current.url);
      }
    },
  };
}
