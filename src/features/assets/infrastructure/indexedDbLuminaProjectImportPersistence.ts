import {
  type StoredAssetRecord,
  type StoredHistoryRecord,
  toStoredProjectRecord,
} from '@/runtime/webProjectStorageRecords';
import type { WebDatabase } from '@/runtime/webDatabase';
import {
  remapPreparedLuminaProjects,
  type PreparedLuminaProjectImport,
} from './luminaProjectImportPreparation';
import { assertImport } from './luminaProjectImportTypes';

export interface LuminaProjectImportResult {
  projectIds: string[];
  assetIds: string[];
}

function resolveImportedIds(sourceIds: readonly string[], existingIds: ReadonlySet<string>): Map<string, string> {
  const allocated = new Set(existingIds);
  const mapping = new Map<string, string>();
  for (const sourceId of sourceIds) {
    let candidate = sourceId;
    let suffix = 1;
    while (allocated.has(candidate)) {
      candidate = `${sourceId}~import-${suffix}`;
      suffix += 1;
    }
    allocated.add(candidate);
    mapping.set(sourceId, candidate);
  }
  return mapping;
}

function createStagingId(now: () => number): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? Math.random().toString(36).slice(2);
  return `lumina-import-${now()}-${suffix}`;
}

async function discardStaging(database: WebDatabase, stagingId: string): Promise<void> {
  await database.run(['assets'], 'readwrite', async (transaction) => {
    const records = await transaction.getAll<StoredAssetRecord>('assets');
    await Promise.all(records
      .filter((record) => record.stagingId === stagingId)
      .map((record) => transaction.delete('assets', record.assetId)));
  });
}

function stagedAssetRecord(
  prepared: PreparedLuminaProjectImport['assets'][number],
  stagingId: string,
  index: number,
  now: () => number,
): StoredAssetRecord {
  return {
    assetId: `${stagingId}:${index}`,
    projectId: prepared.asset.projectId,
    kind: prepared.asset.kind,
    mimeType: prepared.asset.mimeType,
    byteCount: prepared.blob.size,
    createdAt: now(),
    sourceKind: prepared.asset.sourceKind,
    width: null,
    height: null,
    durationMs: null,
    sourceMetadata: prepared.asset.sourceMetadata,
    lifecycleState: 'staging',
    blob: prepared.blob,
    stagingId,
    stagingSourceId: prepared.sourceId,
  };
}

async function stageAssets(
  database: WebDatabase,
  prepared: PreparedLuminaProjectImport,
  stagingId: string,
  now: () => number,
): Promise<void> {
  for (const [index, asset] of prepared.assets.entries()) {
    const record = stagedAssetRecord(asset, stagingId, index, now);
    await database.run(['assets'], 'readwrite', async (transaction) => {
      assertImport(!(await transaction.get('assets', record.assetId)), 'id_conflict');
      await transaction.put('assets', record);
    });
  }
}

function activeAssetRecord(
  staged: StoredAssetRecord,
  projectIds: ReadonlyMap<string, string>,
  assetIds: ReadonlyMap<string, string>,
): StoredAssetRecord {
  const sourceId = staged.stagingSourceId;
  const projectId = projectIds.get(staged.projectId);
  const assetId = sourceId ? assetIds.get(sourceId) : undefined;
  assertImport(sourceId && projectId && assetId, 'id_conflict');
  return {
    ...staged,
    assetId,
    projectId,
    lifecycleState: 'active',
    stagingId: undefined,
    stagingSourceId: undefined,
  };
}

async function publishStaging(
  database: WebDatabase,
  prepared: PreparedLuminaProjectImport,
  stagingId: string,
): Promise<LuminaProjectImportResult> {
  return database.run(['projects', 'history', 'assets'], 'readwrite', async (transaction) => {
    const [storedProjects, storedAssets] = await Promise.all([
      transaction.getAll<{ id: string }>('projects'),
      transaction.getAll<StoredAssetRecord>('assets'),
    ]);
    const stagedAssets = storedAssets.filter((asset) => asset.stagingId === stagingId);
    assertImport(stagedAssets.length === prepared.assets.length, 'id_conflict');
    const projectIds = resolveImportedIds(
      prepared.projects.map((project) => project.sourceId),
      new Set(storedProjects.map((project) => project.id)),
    );
    const assetIds = resolveImportedIds(
      prepared.assets.map((asset) => asset.sourceId),
      new Set(storedAssets
        .filter((asset) => !asset.stagingId)
        .map((asset) => asset.assetId)),
    );
    const projects = remapPreparedLuminaProjects(prepared.projects, projectIds, assetIds);
    for (const project of projects) {
      await transaction.put('projects', toStoredProjectRecord(project));
      await transaction.put<StoredHistoryRecord>('history', {
        projectId: project.id,
        historyJson: project.historyJson,
      });
    }
    for (const stagedAsset of stagedAssets) {
      await transaction.put('assets', activeAssetRecord(stagedAsset, projectIds, assetIds));
      await transaction.delete('assets', stagedAsset.assetId);
    }
    return {
      projectIds: prepared.projects.map((project) => projectIds.get(project.sourceId)!),
      assetIds: prepared.assets.map((asset) => assetIds.get(asset.sourceId)!),
    };
  });
}

export interface IndexedDbLuminaProjectImportPersistence {
  stageAndPublish(
    prepared: PreparedLuminaProjectImport,
    now?: () => number,
  ): Promise<LuminaProjectImportResult>;
  cleanupStaging(): Promise<number>;
}

export function createIndexedDbLuminaProjectImportPersistence(
  database: WebDatabase,
): IndexedDbLuminaProjectImportPersistence {
  return {
    async stageAndPublish(prepared, now = Date.now): Promise<LuminaProjectImportResult> {
      const stagingId = createStagingId(now);
      try {
        await stageAssets(database, prepared, stagingId, now);
        return await publishStaging(database, prepared, stagingId);
      } catch (error) {
        await discardStaging(database, stagingId);
        throw error;
      }
    },
    async cleanupStaging(): Promise<number> {
      return database.run(['assets'], 'readwrite', async (transaction) => {
        const records = await transaction.getAll<StoredAssetRecord>('assets');
        const staleRecords = records.filter((record) => record.lifecycleState === 'staging');
        await Promise.all(staleRecords.map((record) => transaction.delete('assets', record.assetId)));
        return staleRecords.length;
      });
    },
  };
}
