import {
  getWebDatabase,
  type WebDatabase,
} from '@/runtime/webDatabase';
import type {
  AssetId,
  AssetMetadata,
  AssetRepository,
  AssetWriteInput,
} from '@/features/assets/domain/assetRepository';

interface StoredAssetRecord extends AssetMetadata {
  blob: Blob;
}

export interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface AssetRepositoryOptions {
  objectUrlApi?: ObjectUrlApi;
  createAssetId?: () => AssetId;
}

function cloneMetadata(record: StoredAssetRecord): AssetMetadata {
  return {
    assetId: record.assetId,
    projectId: record.projectId,
    kind: record.kind,
    mimeType: record.mimeType,
    byteCount: record.byteCount,
    createdAt: record.createdAt,
    sourceKind: record.sourceKind,
    width: record.width,
    height: record.height,
    durationMs: record.durationMs,
    sourceMetadata: { ...record.sourceMetadata },
    lifecycleState: record.lifecycleState,
  };
}

function defaultAssetId(): AssetId {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function defaultObjectUrlApi(): ObjectUrlApi {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('Browser Object URL APIs are unavailable.');
  }
  return URL;
}

export function createIndexedDbAssetRepository(
  database: WebDatabase = getWebDatabase(),
  options: AssetRepositoryOptions = {},
): AssetRepository {
  const objectUrlApi = options.objectUrlApi ?? defaultObjectUrlApi();
  const createAssetId = options.createAssetId ?? defaultAssetId;
  const objectUrls = new Map<AssetId, { url: string; leases: number }>();
  const pendingHydrations = new Map<AssetId, Promise<string | null>>();
  const deletedAssetIds = new Set<AssetId>();

  const readStored = async (assetId: AssetId): Promise<StoredAssetRecord | undefined> => {
    const record = await database.run(['assets'], 'readonly', (transaction) =>
      transaction.get<StoredAssetRecord>('assets', assetId)
    );
    return record?.lifecycleState === 'staging' ? undefined : record;
  };

  const releaseHydratedUrl = (assetId: AssetId): void => {
    const current = objectUrls.get(assetId);
    if (!current) {
      return;
    }
    current.leases -= 1;
    if (current.leases <= 0) {
      objectUrls.delete(assetId);
      deletedAssetIds.delete(assetId);
      objectUrlApi.revokeObjectURL(current.url);
    }
  };

  return {
    async write(input: AssetWriteInput): Promise<AssetMetadata> {
      const assetId = createAssetId();
      const metadata: AssetMetadata = {
        assetId,
        projectId: input.projectId,
        kind: input.kind,
        mimeType: input.blob.type || 'application/octet-stream',
        byteCount: input.blob.size,
        createdAt: Date.now(),
        sourceKind: input.sourceKind,
        width: input.width ?? null,
        height: input.height ?? null,
        durationMs: input.durationMs ?? null,
        sourceMetadata: input.sourceMetadata ?? {},
        lifecycleState: 'active',
      };
      await database.run(['assets'], 'readwrite', (transaction) =>
        transaction.put<StoredAssetRecord>('assets', { ...metadata, blob: input.blob })
      );
      return metadata;
    },

    async read(assetId: AssetId): Promise<Blob | null> {
      return (await readStored(assetId))?.blob ?? null;
    },

    async getMetadata(assetId: AssetId): Promise<AssetMetadata | null> {
      const record = await readStored(assetId);
      return record ? cloneMetadata(record) : null;
    },

    async setDeletionCandidates(projectId: string, assetIds: readonly AssetId[]): Promise<void> {
      const candidates = new Set(assetIds);
      await database.run(['assets'], 'readwrite', async (transaction) => {
        const records = await transaction.getAll<StoredAssetRecord>('assets');
        for (const record of records) {
          if (record.projectId !== projectId) {
            continue;
          }
          if (record.lifecycleState === 'staging') {
            continue;
          }
          const lifecycleState = candidates.has(record.assetId)
            ? 'deletion-candidate'
            : 'active';
          if (record.lifecycleState !== lifecycleState) {
            await transaction.put('assets', { ...record, lifecycleState });
          }
        }
      });
    },

    async listDeletionCandidates(projectId: string): Promise<AssetMetadata[]> {
      const records = await database.run(['assets'], 'readonly', (transaction) =>
        transaction.getAll<StoredAssetRecord>('assets')
      );
      return records
        .filter((record) => (
          record.projectId === projectId && record.lifecycleState === 'deletion-candidate'
        ))
        .map(cloneMetadata);
    },

    async delete(assetId: AssetId): Promise<void> {
      deletedAssetIds.add(assetId);
      const pending = pendingHydrations.get(assetId);
      if (pending) {
        await pending.catch(() => undefined);
      }
      const current = objectUrls.get(assetId);
      if (current && current.leases <= 0) {
        objectUrls.delete(assetId);
        objectUrlApi.revokeObjectURL(current.url);
      }
      await database.run(['assets'], 'readwrite', (transaction) =>
        transaction.delete('assets', assetId)
      );
    },

    async hydrateObjectUrl(assetId: AssetId): Promise<string | null> {
      if (deletedAssetIds.has(assetId)) {
        return null;
      }

      const current = objectUrls.get(assetId);
      if (current) {
        current.leases += 1;
        return current.url;
      }

      let pending = pendingHydrations.get(assetId);
      if (!pending) {
        pending = (async () => {
          const record = await readStored(assetId);
          if (!record) {
            return null;
          }
          const url = objectUrlApi.createObjectURL(record.blob);
          objectUrls.set(assetId, { url, leases: 0 });
          return url;
        })();
        pendingHydrations.set(assetId, pending);
      }

      try {
        const url = await pending;
        if (!url) {
          return null;
        }
        const hydrated = objectUrls.get(assetId);
        if (hydrated) {
          hydrated.leases += 1;
        }
        return url;
      } finally {
        if (pendingHydrations.get(assetId) === pending) {
          pendingHydrations.delete(assetId);
        }
      }
    },

    releaseObjectUrl(assetId: AssetId): void {
      releaseHydratedUrl(assetId);
    },
  };
}
