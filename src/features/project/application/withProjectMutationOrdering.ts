import type { ProjectRepository } from '@/features/project/domain/projectRepository';
import type { ProjectSnapshotWriteOptions } from '@/features/project/domain/projectRevision';

type ProjectOperationStatus = 'active' | 'deleting' | 'deleted';

interface ProjectOperationState {
  tail: Promise<void>;
  status: ProjectOperationStatus;
  deletion: Promise<void> | null;
}

export function withProjectMutationOrdering(repository: ProjectRepository): ProjectRepository {
  const operations = new Map<string, ProjectOperationState>();

  const stateFor = (projectId: string): ProjectOperationState => {
    const current = operations.get(projectId);
    if (current) {
      return current;
    }
    const created: ProjectOperationState = {
      tail: Promise.resolve(),
      status: 'active',
      deletion: null,
    };
    operations.set(projectId, created);
    return created;
  };

  const enqueue = (projectId: string, operation: () => Promise<void>): Promise<void> => {
    const state = stateFor(projectId);
    if (state.status !== 'active') {
      return Promise.resolve();
    }

    const next = state.tail.catch(() => undefined).then(operation);
    state.tail = next.catch(() => undefined);
    return next;
  };

  return {
    listSummaries: () => repository.listSummaries(),
    get: (projectId) => repository.get(projectId),
    saveSnapshot: (record, options?: ProjectSnapshotWriteOptions) => enqueue(
      record.id,
      () => repository.saveSnapshot(record, options),
    ),
    updateViewport: (projectId, viewportJson) =>
      enqueue(projectId, () => repository.updateViewport(projectId, viewportJson)),
    rename: (projectId, name, updatedAt) =>
      enqueue(projectId, () => repository.rename(projectId, name, updatedAt)),
    delete: (projectId) => {
      const state = stateFor(projectId);
      if (state.status === 'deleting') {
        return state.deletion ?? state.tail;
      }
      if (state.status === 'deleted') {
        return Promise.resolve();
      }

      state.status = 'deleting';
      const deletion = state.tail
        .catch(() => undefined)
        .then(() => repository.delete(projectId))
        .then(
          () => {
            state.status = 'deleted';
          },
          (error: unknown) => {
            state.status = 'active';
            throw error;
          }
        );
      state.deletion = deletion;
      state.tail = deletion.catch(() => undefined);
      return deletion;
    },
    createProjectDirs: (projectId, projectName) =>
    enqueue(projectId, () => repository.createProjectDirs(projectId, projectName)),
    ...(repository.getWriteAccess
      ? { getWriteAccess: (projectId: string) => repository.getWriteAccess!(projectId) }
      : {}),
    ...(repository.takeOverWriteAccess
      ? {
          takeOverWriteAccess: (projectId: string) =>
            repository.takeOverWriteAccess!(projectId),
        }
      : {}),
    ...(repository.watchWriteAccess
      ? {
          watchWriteAccess: (
            projectId: string,
            listener: Parameters<NonNullable<ProjectRepository['watchWriteAccess']>>[1],
          ) => repository.watchWriteAccess!(projectId, listener),
        }
      : {}),
  };
}
