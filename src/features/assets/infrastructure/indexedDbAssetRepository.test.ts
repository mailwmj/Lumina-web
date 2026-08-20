import { describe, expect, it, vi } from 'vitest';

import type {
  WebDatabase,
  WebDatabaseStoreName,
  WebDatabaseTransaction,
} from '@/runtime/webDatabase';
import { createIndexedDbAssetRepository } from './indexedDbAssetRepository';

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
    const transaction: WebDatabaseTransaction = {
      get: async <TValue>(storeName: WebDatabaseStoreName, key: IDBValidKey) =>
        this.stores[storeName].get(String(key)) as TValue | undefined,
      getAll: async <TValue>(storeName: WebDatabaseStoreName) =>
        [...this.stores[storeName].values()] as TValue[],
      put: async <TValue>(storeName: WebDatabaseStoreName, value: TValue) => {
        const record = value as StoredValue;
        const key = storeName === 'assets' ? record.assetId : record.id ?? record.key;
        this.stores[storeName].set(String(key), record);
      },
      delete: async (storeName: WebDatabaseStoreName, key: IDBValidKey) => {
        this.stores[storeName].delete(String(key));
      },
    };
    return operation(transaction);
  }
}

describe('IndexedDbAssetRepository adapter', () => {
  it('persists Blob metadata and bytes without putting a display URL in the record', async () => {
    const database = new MemoryWebDatabase();
    const repository = createIndexedDbAssetRepository(database, {
      createAssetId: () => 'asset-1',
      objectUrlApi: {
        createObjectURL: vi.fn(() => 'blob:asset-1'),
        revokeObjectURL: vi.fn(),
      },
    });

    const written = await repository.write({
      projectId: 'project-1',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob(['pixels'], { type: 'image/png' }),
      width: 3,
      height: 2,
      sourceMetadata: { fileName: 'source.png' },
    });

    expect(written).toMatchObject({
      assetId: 'asset-1',
      mimeType: 'image/png',
      byteCount: 6,
      width: 3,
      height: 2,
      sourceMetadata: { fileName: 'source.png' },
      lifecycleState: 'active',
    });
    expect(await (await repository.read('asset-1'))?.text()).toBe('pixels');
    expect(database.stores.assets.get('asset-1')).not.toHaveProperty('url');
  });

  it('shares and revokes Object URLs according to consumer leases', async () => {
    const database = new MemoryWebDatabase();
    const revokeObjectURL = vi.fn();
    const repository = createIndexedDbAssetRepository(database, {
      createAssetId: () => 'asset-1',
      objectUrlApi: {
        createObjectURL: vi.fn(() => 'blob:asset-1'),
        revokeObjectURL,
      },
    });
    await repository.write({
      projectId: 'project-1',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob(['pixels'], { type: 'image/png' }),
    });

    const first = await repository.hydrateObjectUrl('asset-1');
    const second = await repository.hydrateObjectUrl('asset-1');
    expect(second).toBe(first);
    repository.releaseObjectUrl('asset-1');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    repository.releaseObjectUrl('asset-1');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:asset-1');

    const next = await repository.hydrateObjectUrl('asset-1');
    expect(next).toBe('blob:asset-1');
    repository.releaseObjectUrl('asset-1');
    await repository.delete('asset-1');
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('keeps a deleted asset URL alive until every consumer releases it', async () => {
    const database = new MemoryWebDatabase();
    const revokeObjectURL = vi.fn();
    const repository = createIndexedDbAssetRepository(database, {
      createAssetId: () => 'asset-1',
      objectUrlApi: {
        createObjectURL: vi.fn(() => 'blob:asset-1'),
        revokeObjectURL,
      },
    });
    await repository.write({
      projectId: 'project-1',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob(['pixels'], { type: 'image/png' }),
    });

    await repository.hydrateObjectUrl('asset-1');
    await repository.hydrateObjectUrl('asset-1');
    await repository.delete('asset-1');

    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(await repository.hydrateObjectUrl('asset-1')).toBeNull();
    repository.releaseObjectUrl('asset-1');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    repository.releaseObjectUrl('asset-1');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:asset-1');
  });
});
