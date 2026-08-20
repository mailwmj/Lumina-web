import { describe, expect, it, vi } from 'vitest';

import type {
  ProjectRecord,
  ProjectSummaryRecord,
} from '@/features/project/domain/projectRepository';
import { defineProjectRepositoryContract } from '@/features/project/domain/projectRepositoryContract';
import {
  createTauriProjectRepository,
  type RuntimeInvoker,
} from './tauriProjectRepository';

const record: ProjectRecord = {
  id: 'project-1',
  name: 'Desktop project',
  createdAt: 1,
  updatedAt: 2,
  nodeCount: 1,
  nodesJson: '[{"id":"node-1"}]',
  edgesJson: '[]',
  viewportJson: '{"x":0,"y":0,"zoom":1}',
  historyJson: '{"past":[],"future":[]}',
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

class StatefulTauriInvoker implements RuntimeInvoker {
  readonly records = new Map<string, ProjectRecord>();
  readonly directories: Array<{ projectId: string; projectName: string }> = [];
  beforeSave: (() => Promise<void>) | null = null;

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const projectId = String(args?.projectId);
    switch (command) {
      case 'list_project_summaries':
        return [...this.records.values()]
          .map(({ id, name, createdAt, updatedAt, nodeCount }): ProjectSummaryRecord => ({
            id,
            name,
            createdAt,
            updatedAt,
            nodeCount,
          }))
          .sort((left, right) => right.updatedAt - left.updatedAt) as T;
      case 'get_project_record':
        return (this.records.get(projectId) ?? null) as T;
      case 'upsert_project_record': {
        await this.beforeSave?.();
        const next = structuredClone(args?.record as ProjectRecord);
        this.records.set(next.id, next);
        return undefined as T;
      }
      case 'update_project_viewport_record': {
        const current = this.records.get(projectId);
        if (current) {
          this.records.set(projectId, {
            ...current,
            viewportJson: String(args?.viewportJson),
          });
        }
        return undefined as T;
      }
      case 'rename_project_record': {
        const current = this.records.get(projectId);
        if (current) {
          this.records.set(projectId, {
            ...current,
            name: String(args?.name),
            updatedAt: Number(args?.updatedAt),
          });
        }
        return undefined as T;
      }
      case 'delete_project_record':
        this.records.delete(projectId);
        return undefined as T;
      case 'create_project_dirs':
        this.directories.push({ projectId, projectName: String(args?.projectName) });
        return undefined as T;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  }
}

defineProjectRepositoryContract('Tauri adapter', () =>
  createTauriProjectRepository(new StatefulTauriInvoker())
);

describe('Tauri ProjectRepository adapter', () => {
  it('maps the repository contract to the existing Tauri commands', async () => {
    const invoke = vi.fn(async <T>(command: string): Promise<T> => {
      if (command === 'list_project_summaries') {
        return [{ id: record.id, name: record.name }] as T;
      }
      if (command === 'get_project_record') {
        return record as T;
      }
      return undefined as T;
    });
    const repository = createTauriProjectRepository({ invoke } as RuntimeInvoker);

    await expect(repository.listSummaries()).resolves.toEqual([
      { id: record.id, name: record.name },
    ]);
    await expect(repository.get(record.id)).resolves.toEqual(record);
    await repository.saveSnapshot(record);
    await repository.updateViewport(record.id, '{"x":1,"y":2,"zoom":1.1}');
    await repository.rename(record.id, 'Renamed', 3);
    await repository.createProjectDirs(record.id, 'Renamed');
    await repository.delete(record.id);

    expect(invoke.mock.calls).toEqual([
      ['list_project_summaries'],
      ['get_project_record', { projectId: record.id }],
      ['upsert_project_record', { record }],
      [
        'update_project_viewport_record',
        { projectId: record.id, viewportJson: '{"x":1,"y":2,"zoom":1.1}' },
      ],
      ['rename_project_record', { projectId: record.id, name: 'Renamed', updatedAt: 3 }],
      ['create_project_dirs', { projectId: record.id, projectName: 'Renamed' }],
      ['delete_project_record', { projectId: record.id }],
    ]);
  });

  it('preserves atomic snapshots, independent viewport updates, rename, and delete', async () => {
    const invoker = new StatefulTauriInvoker();
    const repository = createTauriProjectRepository(invoker);
    await repository.saveSnapshot(record);
    await repository.updateViewport(record.id, '{"x":4,"y":5,"zoom":1.2}');
    await repository.rename(record.id, 'Renamed', 10);
    await repository.createProjectDirs(record.id, 'Renamed');

    expect(await repository.get(record.id)).toEqual({
      ...record,
      name: 'Renamed',
      updatedAt: 10,
      viewportJson: '{"x":4,"y":5,"zoom":1.2}',
    });
    expect(await repository.listSummaries()).toEqual([
      { id: record.id, name: 'Renamed', createdAt: 1, updatedAt: 10, nodeCount: 1 },
    ]);
    expect(invoker.directories).toEqual([{ projectId: record.id, projectName: 'Renamed' }]);

    await repository.delete(record.id);
    expect(await repository.get(record.id)).toBeNull();
  });

  it('cannot resurrect a deleted project when a Tauri upsert completes late', async () => {
    const invoker = new StatefulTauriInvoker();
    const saveStarted = deferred();
    const releaseSave = deferred();
    invoker.beforeSave = async () => {
      saveStarted.resolve();
      await releaseSave.promise;
    };
    const repository = createTauriProjectRepository(invoker);

    const save = repository.saveSnapshot(record);
    await saveStarted.promise;
    const deletion = repository.delete(record.id);
    const staleSave = repository.saveSnapshot({ ...record, name: 'Late save' });
    releaseSave.resolve();
    await Promise.all([save, deletion, staleSave]);

    expect(await repository.get(record.id)).toBeNull();
    expect(await repository.listSummaries()).toEqual([]);
  });
});
