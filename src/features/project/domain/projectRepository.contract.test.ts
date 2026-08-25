import { describe, expect, it, vi } from 'vitest';

import { withProjectMutationOrdering } from '@/features/project/application/withProjectMutationOrdering';
import {
  type ProjectRecord,
  type ProjectRepository,
  type ProjectSummaryRecord,
} from './projectRepository';
import { defineProjectRepositoryContract } from './projectRepositoryContract';

const initialRecord: ProjectRecord = {
  id: 'project-1',
  name: 'First project',
  createdAt: 10,
  updatedAt: 20,
  nodeCount: 1,
  nodesJson: '[{"id":"node-1"}]',
  edgesJson: '[]',
  viewportJson: '{"x":0,"y":0,"zoom":1}',
  historyJson: '{"past":[],"future":[]}',
};

class InMemoryProjectRepository implements ProjectRepository {
  readonly records = new Map<string, ProjectRecord>();

  async listSummaries(): Promise<ProjectSummaryRecord[]> {
    return [...this.records.values()]
      .map(({ id, name, createdAt, updatedAt, nodeCount }) => ({
        id,
        name,
        createdAt,
        updatedAt,
        nodeCount,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async get(projectId: string): Promise<ProjectRecord | null> {
    return this.records.get(projectId) ?? null;
  }

  async saveSnapshot(record: ProjectRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async updateViewport(projectId: string, viewportJson: string): Promise<void> {
    const record = this.records.get(projectId);
    if (record) {
      this.records.set(projectId, { ...record, viewportJson });
    }
  }

  async rename(projectId: string, name: string, updatedAt: number): Promise<void> {
    const record = this.records.get(projectId);
    if (record) {
      this.records.set(projectId, { ...record, name, updatedAt });
    }
  }

  async delete(projectId: string): Promise<void> {
    this.records.delete(projectId);
  }
}

function createOrderedInMemoryRepository(): ProjectRepository {
  return withProjectMutationOrdering(new InMemoryProjectRepository());
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

defineProjectRepositoryContract('in-memory', createOrderedInMemoryRepository);

describe('ProjectRepository mutation ordering', () => {
  it('allows an explicit retry after a failed delete', async () => {
    const base = new InMemoryProjectRepository();
    const originalDelete = base.delete.bind(base);
    let attempts = 0;
    base.delete = async (projectId) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('temporary delete failure');
      }
      await originalDelete(projectId);
    };
    const repository = withProjectMutationOrdering(base);
    await repository.saveSnapshot(initialRecord);

    await expect(repository.delete(initialRecord.id)).rejects.toThrow('temporary delete failure');
    await repository.delete(initialRecord.id);
    expect(await repository.get(initialRecord.id)).toBeNull();
  });

  it('makes delete final when a full save is already in flight', async () => {
    const base = new InMemoryProjectRepository();
    const saveStarted = deferred();
    const releaseSave = deferred();
    const originalSave = base.saveSnapshot.bind(base);
    base.saveSnapshot = vi.fn(async (record: ProjectRecord) => {
      saveStarted.resolve();
      await releaseSave.promise;
      await originalSave(record);
    });
    const repository = withProjectMutationOrdering(base);

    const save = repository.saveSnapshot(initialRecord);
    await saveStarted.promise;
    const deletion = repository.delete(initialRecord.id);
    const staleSave = repository.saveSnapshot({ ...initialRecord, name: 'Late save' });

    releaseSave.resolve();
    await Promise.all([save, deletion, staleSave]);

    expect(await repository.get(initialRecord.id)).toBeNull();
    expect(await repository.listSummaries()).toEqual([]);
    expect(base.saveSnapshot).toHaveBeenCalledTimes(1);
  });
});
