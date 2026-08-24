import { describe, expect, it } from 'vitest';

import { createLuminaProjectExport } from '@/features/assets/application/luminaProjectExport';
import type {
  AssetMetadata,
  AssetRepository,
  AssetSourceMetadata,
} from '@/features/assets/domain/assetRepository';
import type { ProjectRecord, ProjectRepository } from '@/features/project/domain/projectRepository';
import assetBackedFixture from '@/features/project/infrastructure/fixtures/web-project-schema-v1-asset-backed.json';
import type {
  WebDatabase,
  WebDatabaseStoreName,
  WebDatabaseTransaction,
} from '@/runtime/webDatabase';
import {
  cleanupLuminaImportStaging,
  importLuminaProjectArchive,
  LuminaProjectImportError,
} from './indexedDbLuminaProjectImport';

type StoredValue = Record<string, unknown>;

class MemoryWebDatabase implements WebDatabase {
  readonly stores: Record<WebDatabaseStoreName, Map<string, StoredValue>> = {
    projects: new Map(),
    history: new Map(),
    settings: new Map(),
    meta: new Map(),
    assets: new Map(),
  };

  async run<T>(
    _storeNames: readonly WebDatabaseStoreName[],
    _mode: 'readonly' | 'readwrite',
    operation: (transaction: WebDatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const keyFor = (storeName: WebDatabaseStoreName, value: StoredValue): string => (
      storeName === 'history' ? String(value.projectId) : String(value.assetId ?? value.id ?? value.key)
    );
    const transaction: WebDatabaseTransaction = {
      get: async <TValue>(storeName: WebDatabaseStoreName, key: IDBValidKey) =>
        this.stores[storeName].get(String(key)) as TValue | undefined,
      getAll: async <TValue>(storeName: WebDatabaseStoreName) =>
        [...this.stores[storeName].values()] as TValue[],
      put: async <TValue>(storeName: WebDatabaseStoreName, value: TValue) => {
        this.stores[storeName].set(keyFor(storeName, value as StoredValue), value as StoredValue);
      },
      delete: async (storeName: WebDatabaseStoreName, key: IDBValidKey) => {
        this.stores[storeName].delete(String(key));
      },
    };
    return operation(transaction);
  }
}

class PublishFailingWebDatabase extends MemoryWebDatabase {
  override async run<T>(
    storeNames: readonly WebDatabaseStoreName[],
    mode: 'readonly' | 'readwrite',
    operation: (transaction: WebDatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    if (
      mode === 'readwrite'
      && storeNames.includes('projects')
      && storeNames.includes('history')
      && storeNames.includes('assets')
    ) {
      throw new Error('publish failed');
    }
    return super.run(storeNames, mode, operation);
  }
}

class ConcurrentConflictWebDatabase extends MemoryWebDatabase {
  override async run<T>(
    storeNames: readonly WebDatabaseStoreName[],
    mode: 'readonly' | 'readwrite',
    operation: (transaction: WebDatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    if (
      mode === 'readwrite'
      && storeNames.includes('projects')
      && storeNames.includes('history')
      && storeNames.includes('assets')
    ) {
      this.stores.projects.set('project-1', { id: 'project-1' });
      this.stores.assets.set('asset-1', { assetId: 'asset-1', lifecycleState: 'active' });
    }
    return super.run(storeNames, mode, operation);
  }
}

function createProject(): ProjectRecord {
  return {
    id: 'project-1',
    name: 'Imported project',
    createdAt: 1,
    updatedAt: 2,
    nodeCount: 1,
    revision: 'r2',
    nodesJson: JSON.stringify({
      nodes: [{ id: 'image-1', data: { assetId: 'asset-1' } }],
      imagePool: [],
    }),
    edgesJson: '[]',
    viewportJson: '{"x":0,"y":0,"zoom":1}',
    historyJson: '{"past":[],"future":[]}',
  };
}

function createAssetRepository({
  assetId = 'asset-1',
  projectId = 'project-1',
  sourceMetadata = { fileName: 'source.png' },
}: {
  assetId?: string;
  projectId?: string;
  sourceMetadata?: AssetSourceMetadata;
} = {}): AssetRepository {
  const blob = new Blob(['pixels'], { type: 'image/png' });
  return {
    read: async () => blob,
    getMetadata: async (requestedAssetId: string) => requestedAssetId === assetId ? {
      assetId,
      projectId,
      kind: 'image' as const,
      mimeType: blob.type,
      byteCount: blob.size,
      createdAt: 3,
      sourceKind: 'import' as const,
      width: 2,
      height: 3,
      durationMs: null,
      sourceMetadata,
      lifecycleState: 'active' as const,
    } : null,
  } as unknown as AssetRepository;
}

async function corruptAssetManifestChecksum(archive: Blob): Promise<Blob> {
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const assetOffset = text.indexOf('"assets":[{"assetId":"asset-1"');
  const checksumOffset = text.indexOf('"sha256":"', assetOffset) + '"sha256":"'.length;
  bytes.fill('0'.charCodeAt(0), checksumOffset, checksumOffset + 64);
  return new Blob([bytes], { type: 'application/zip' });
}

async function corruptManifestProjectRevision(archive: Blob): Promise<Blob> {
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const projectsOffset = text.indexOf('"projects":[{"id":"project-1"');
  const revisionOffset = text.indexOf('"revision":"r2"', projectsOffset) + '"revision":"'.length;
  bytes[revisionOffset + 1] = '9'.charCodeAt(0);
  return new Blob([bytes], { type: 'application/zip' });
}

describe('IndexedDB Lumina project import', () => {
  it('imports a versioned archive through staging before publishing the project and its assets', async () => {
    const project = createProject();
    const archive = await createLuminaProjectExport({
      projectIds: [project.id],
      projectRepository: { get: async () => project } as Pick<ProjectRepository, 'get'>,
      assetRepository: createAssetRepository(),
      exportedAt: 123,
    });
    const database = new MemoryWebDatabase();

    const result = await importLuminaProjectArchive({ archive, database });

    expect(result.projectIds).toEqual(['project-1']);
    expect(database.stores.projects.get('project-1')).toMatchObject({
      id: 'project-1',
      schemaVersion: 1,
    });
    expect(database.stores.history.get('project-1')).toMatchObject({ projectId: 'project-1' });
    expect(database.stores.assets.get('asset-1')).toMatchObject({
      assetId: 'asset-1',
      projectId: 'project-1',
      lifecycleState: 'active',
    });
    expect(database.stores.assets.get('asset-1')?.blob).toBeInstanceOf(Blob);
  });

  it('round trips the asset-backed persisted fixture with omitted display URLs and scalar metadata', async () => {
    const fixtureProject = assetBackedFixture.project as ProjectRecord;
    const fixtureAsset = assetBackedFixture.asset as unknown as AssetMetadata;
    const archive = await createLuminaProjectExport({
      projectIds: [fixtureProject.id],
      projectRepository: { get: async () => fixtureProject } as Pick<ProjectRepository, 'get'>,
      assetRepository: createAssetRepository({
        assetId: fixtureAsset.assetId,
        projectId: fixtureAsset.projectId,
        sourceMetadata: fixtureAsset.sourceMetadata,
      }),
      exportedAt: 123,
    });
    const database = new MemoryWebDatabase();

    await expect(importLuminaProjectArchive({ archive, database })).resolves.toEqual({
      projectIds: [fixtureProject.id],
      assetIds: [fixtureAsset.assetId],
    });

    const importedProject = database.stores.projects.get(fixtureProject.id)!;
    const importedHistory = database.stores.history.get(fixtureProject.id)!;
    const currentNode = (JSON.parse(String(importedProject.nodesJson)) as {
      nodes: Array<{ data: Record<string, unknown> }>;
    }).nodes[0]?.data;
    const historyNode = (JSON.parse(String(importedHistory.historyJson)) as {
      past: Array<{ nodes: Array<{ data: Record<string, unknown> }> }>;
    }).past[0]?.nodes[0]?.data;

    expect(currentNode).toMatchObject({
      assetId: fixtureAsset.assetId,
      extraParams: { thinking_level: 'off' },
    });
    expect(historyNode).toMatchObject({
      assetId: fixtureAsset.assetId,
      extraParams: { thinking_level: 'off' },
    });
    for (const displayUrl of [
      'imageUrl',
      'videoUrl',
      'audioUrl',
      'previewImageUrl',
      'previewVideoUrl',
      'lastFrameImageUrl',
    ]) {
      expect(currentNode).not.toHaveProperty(displayUrl);
      expect(historyNode).not.toHaveProperty(displayUrl);
    }
    expect(database.stores.assets.get(fixtureAsset.assetId)?.sourceMetadata)
      .toEqual(fixtureAsset.sourceMetadata);
  });

  it('rejects an asset declaration whose checksum differs from the verified archive entry before staging', async () => {
    const project = createProject();
    const archive = await createLuminaProjectExport({
      projectIds: [project.id],
      projectRepository: { get: async () => project } as Pick<ProjectRepository, 'get'>,
      assetRepository: createAssetRepository(),
      exportedAt: 123,
    });
    const database = new MemoryWebDatabase();
    database.stores.projects.set('preserved', { id: 'preserved', name: 'Existing project' });

    await expect(importLuminaProjectArchive({
      archive: await corruptAssetManifestChecksum(archive),
      database,
    })).rejects.toMatchObject({ code: 'checksum_mismatch' } satisfies Partial<LuminaProjectImportError>);

    expect(database.stores.projects.has('project-1')).toBe(false);
    expect(database.stores.projects.get('preserved')).toMatchObject({ id: 'preserved' });
    expect(database.stores.assets).toEqual(new Map());
  });

  it('rejects a manifest project revision that differs from its project document', async () => {
    const project = createProject();
    const archive = await createLuminaProjectExport({
      projectIds: [project.id],
      projectRepository: { get: async () => project } as Pick<ProjectRepository, 'get'>,
      assetRepository: createAssetRepository(),
      exportedAt: 123,
    });
    const database = new MemoryWebDatabase();

    await expect(importLuminaProjectArchive({
      archive: await corruptManifestProjectRevision(archive),
      database,
    })).rejects.toMatchObject({ code: 'invalid_manifest' } satisfies Partial<LuminaProjectImportError>);

    expect(database.stores.projects).toEqual(new Map());
    expect(database.stores.assets).toEqual(new Map());
  });

  it('deterministically remaps conflicting project and asset ids in current and retained references', async () => {
    const project = createProject();
    project.historyJson = JSON.stringify({
      past: [{ nodes: [{ data: { previewAssetId: 'asset-1' } }], edges: [] }],
      future: [],
    });
    const archive = await createLuminaProjectExport({
      projectIds: [project.id],
      projectRepository: { get: async () => project } as Pick<ProjectRepository, 'get'>,
      assetRepository: createAssetRepository(),
      exportedAt: 123,
    });
    const database = new MemoryWebDatabase();
    database.stores.projects.set('project-1', { id: 'project-1' });
    database.stores.assets.set('asset-1', { assetId: 'asset-1', lifecycleState: 'active' });

    const result = await importLuminaProjectArchive({ archive, database });

    expect(result).toEqual({
      projectIds: ['project-1~import-1'],
      assetIds: ['asset-1~import-1'],
    });
    const importedProject = database.stores.projects.get('project-1~import-1')!;
    expect(importedProject.nodesJson).toContain('asset-1~import-1');
    expect(database.stores.history.get('project-1~import-1')?.historyJson).toContain('asset-1~import-1');
    expect(database.stores.projects.get('project-1')).toEqual({ id: 'project-1' });
    expect(database.stores.assets.get('asset-1')).toEqual({ assetId: 'asset-1', lifecycleState: 'active' });
  });

  it('remaps conflicts introduced after asset staging instead of failing publication', async () => {
    const project = createProject();
    const archive = await createLuminaProjectExport({
      projectIds: [project.id],
      projectRepository: { get: async () => project } as Pick<ProjectRepository, 'get'>,
      assetRepository: createAssetRepository(),
      exportedAt: 123,
    });
    const database = new ConcurrentConflictWebDatabase();

    await expect(importLuminaProjectArchive({ archive, database })).resolves.toEqual({
      projectIds: ['project-1~import-1'],
      assetIds: ['asset-1~import-1'],
    });
    expect(database.stores.projects.get('project-1')).toEqual({ id: 'project-1' });
    expect(database.stores.assets.get('asset-1')).toEqual({
      assetId: 'asset-1',
      lifecycleState: 'active',
    });
  });

  it('cleans only unreachable staging assets left by an interrupted import', async () => {
    const database = new MemoryWebDatabase();
    database.stores.assets.set('staged', { assetId: 'staged', lifecycleState: 'staging' });
    database.stores.assets.set('active', { assetId: 'active', lifecycleState: 'active' });

    await expect(cleanupLuminaImportStaging(database)).resolves.toBe(1);

    expect(database.stores.assets.has('staged')).toBe(false);
    expect(database.stores.assets.get('active')).toEqual({ assetId: 'active', lifecycleState: 'active' });
  });

  it('cleans staged assets and leaves project records untouched when final publishing fails', async () => {
    const project = createProject();
    const archive = await createLuminaProjectExport({
      projectIds: [project.id],
      projectRepository: { get: async () => project } as Pick<ProjectRepository, 'get'>,
      assetRepository: createAssetRepository(),
      exportedAt: 123,
    });
    const database = new PublishFailingWebDatabase();
    database.stores.projects.set('preserved', { id: 'preserved' });

    await expect(importLuminaProjectArchive({ archive, database })).rejects.toThrow('publish failed');

    expect(database.stores.projects.get('preserved')).toEqual({ id: 'preserved' });
    expect(database.stores.projects.has(project.id)).toBe(false);
    expect(database.stores.assets).toEqual(new Map());
  });
});
