import { describe, expect, it } from 'vitest';

import type {
  ProjectRecord,
  ProjectSummaryRecord,
} from '@/features/project/domain/projectRepository';
import { defineProjectRepositoryContract } from '@/features/project/domain/projectRepositoryContract';
import type {
  WebDatabase,
  WebDatabaseStoreName,
  WebDatabaseTransaction,
} from '@/runtime/webDatabase';
import { createWebProjectRepository } from './webProjectRepository';
import { StaleProjectRevisionError } from '@/features/project/domain/projectRevision';

type StoreValue = Record<string, unknown>;

class MemoryWebDatabase implements WebDatabase {
  readonly stores: Record<WebDatabaseStoreName, Map<string, StoreValue>> = {
    projects: new Map(),
    history: new Map(),
    settings: new Map(),
    meta: new Map(),
    assets: new Map(),
  };
  readonly transactions: Array<{
    storeNames: readonly WebDatabaseStoreName[];
    mode: 'readonly' | 'readwrite';
  }> = [];

  async run<T>(
    storeNames: readonly WebDatabaseStoreName[],
    mode: 'readonly' | 'readwrite',
    operation: (transaction: WebDatabaseTransaction) => Promise<T>
  ): Promise<T> {
    this.transactions.push({ storeNames, mode });
    const keyFor = (storeName: WebDatabaseStoreName, value: StoreValue): string => {
      if (storeName === 'history') {
        return String(value.projectId);
      }
      return String(value.key ?? value.id);
    };
    const transaction: WebDatabaseTransaction = {
      get: async <TValue>(storeName: WebDatabaseStoreName, key: IDBValidKey) =>
        this.stores[storeName].get(String(key)) as TValue | undefined,
      getAll: async <TValue>(storeName: WebDatabaseStoreName) =>
        [...this.stores[storeName].values()] as TValue[],
      put: async <TValue>(storeName: WebDatabaseStoreName, value: TValue) => {
        this.stores[storeName].set(keyFor(storeName, value as StoreValue), value as StoreValue);
      },
      delete: async (storeName: WebDatabaseStoreName, key: IDBValidKey) => {
        this.stores[storeName].delete(String(key));
      },
    };
    return operation(transaction);
  }
}

const record: ProjectRecord = {
  id: 'project-1',
  name: 'Web project',
  createdAt: 1,
  updatedAt: 2,
  nodeCount: 1,
  nodesJson: '[{"id":"annotation-1","type":"textAnnotation","position":{"x":20,"y":40}}]',
  edgesJson: '[]',
  viewportJson: '{"x":0,"y":0,"zoom":1}',
  historyJson: '{"past":[],"future":[]}',
  revision: 'r1',
};

defineProjectRepositoryContract('Web IndexedDB adapter', () =>
  createWebProjectRepository(new MemoryWebDatabase(), { ownership: false })
);

describe('Web ProjectRepository adapter', () => {
  it('commits revision and history atomically and rejects a stale writer', async () => {
    const database = new MemoryWebDatabase();
    const repository = createWebProjectRepository(database, { ownership: false });

    await repository.saveSnapshot(record);
    const next = { ...record, revision: 'r2', nodesJson: '[{"id":"node-2"}]' };
    await repository.saveSnapshot(next, { expectedRevision: 'r1' });

    expect((await repository.get(record.id))?.revision).toBe('r2');
    await expect(repository.saveSnapshot({ ...next, revision: 'r3' }, {
      expectedRevision: 'r1',
    })).rejects.toBeInstanceOf(StaleProjectRevisionError);
    expect((await repository.get(record.id))?.nodesJson).toBe(next.nodesJson);
  });

  it('rejects a commit from an ownership epoch superseded by takeover', async () => {
    const database = new MemoryWebDatabase();
    const repository = createWebProjectRepository(database, { ownership: false });
    await repository.saveSnapshot(record);
    await database.run(['meta'], 'readwrite', (transaction) => transaction.put('meta', {
      key: 'project-ownership:project-1',
      projectId: 'project-1',
      ownerId: 'tab-b',
      epoch: 2,
    }));

    await expect(repository.saveSnapshot({ ...record, revision: 'r2' }, {
      expectedRevision: 'r1',
      ownership: { ownerId: 'tab-a', epoch: 1 },
    })).rejects.toMatchObject({ code: 'stale_ownership' });
    expect((await repository.get(record.id))?.revision).toBe('r1');
  });

  it('keeps project snapshots and history in one atomic write while viewport stays independent', async () => {
    const database = new MemoryWebDatabase();
    const repository = createWebProjectRepository(database, { ownership: false });

    await repository.saveSnapshot(record);
    await repository.updateViewport(record.id, '{"x":12,"y":8,"zoom":1.25}');

    expect(await repository.get(record.id)).toEqual({
      ...record,
      viewportJson: '{"x":12,"y":8,"zoom":1.25}',
    });
    expect(database.stores.projects.get(record.id)).toMatchObject({
      id: record.id,
      viewportJson: '{"x":12,"y":8,"zoom":1.25}',
    });
    expect(database.stores.history.get(record.id)).toEqual({
      projectId: record.id,
      historyJson: record.historyJson,
    });
    expect(database.transactions).toEqual([
      { storeNames: ['projects', 'history'], mode: 'readwrite' },
      { storeNames: ['projects'], mode: 'readwrite' },
      { storeNames: ['projects', 'history'], mode: 'readonly' },
    ]);
  });

  it('deletes the project and its history record', async () => {
    const database = new MemoryWebDatabase();
    const repository = createWebProjectRepository(database, { ownership: false });
    await repository.saveSnapshot(record);

    await repository.delete(record.id);

    expect(await repository.get(record.id)).toBeNull();
    expect(await repository.listSummaries()).toEqual([] as ProjectSummaryRecord[]);
    expect(database.stores.history.has(record.id)).toBe(false);
  });
});
