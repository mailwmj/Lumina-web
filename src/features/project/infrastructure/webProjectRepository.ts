import {
  getWebDatabase,
  type WebDatabase,
  type WebDatabaseTransaction,
} from '@/runtime/webDatabase';
import {
  type StoredHistoryRecord,
  type StoredProjectRecord,
  toStoredProjectRecord,
} from '@/runtime/webProjectStorageRecords';
import {
  type ProjectRecord,
  type ProjectRepository,
  type ProjectSummaryRecord,
  type ProjectWriteAccess,
} from '@/features/project/domain/projectRepository';
import { withProjectMutationOrdering } from '@/features/project/application/withProjectMutationOrdering';
import {
  ProjectReadOnlyError,
  StaleProjectOwnershipError,
  StaleProjectRevisionError,
  type ProjectSnapshotWriteOptions,
} from '@/features/project/domain/projectRevision';
import {
  PROJECT_OWNERSHIP_META_PREFIX,
  type StoredProjectOwnership,
} from '@/runtime/webProjectOwnership';
import {
  createWebProjectOwnership,
  type WebProjectOwnership,
} from '@/runtime/webProjectOwnership';

const CURRENT_PROJECT_SCHEMA_VERSION = 1;

function projectNeedsRecovery(project: StoredProjectRecord | undefined): boolean {
  return Boolean(
    project
      && project.schemaVersion !== undefined
      && project.schemaVersion !== 0
      && project.schemaVersion !== CURRENT_PROJECT_SCHEMA_VERSION,
  );
}

function migratedProject(project: StoredProjectRecord): {
  record: StoredProjectRecord;
  needsPersistence: boolean;
} {
  if (project.schemaVersion === undefined || project.schemaVersion === 0) {
    return {
      record: { ...project, schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION },
      needsPersistence: true,
    };
  }
  return { record: project, needsPersistence: false };
}

function toProjectRecord(
  project: StoredProjectRecord,
  history: StoredHistoryRecord | undefined,
  recovery?: ProjectRecord['recovery'],
): ProjectRecord {
  return {
    ...project,
    historyJson: history?.historyJson ?? '{"past":[],"future":[]}',
    ...(recovery
      ? { recovery }
      : projectNeedsRecovery(project) ? { recovery: { reason: 'unsupported_schema' as const } } : {}),
  };
}

function toSummary(record: StoredProjectRecord): ProjectSummaryRecord {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
  };
}

export interface WebProjectRepositoryOptions {
  /** Enabled by default in browsers that expose Web Locks. */
  ownership?: boolean;
  createOwnership?: (projectId: string) => WebProjectOwnership;
}

async function assertCurrentOwnership(
  transaction: WebDatabaseTransaction,
  projectId: string,
  ownership: StoredProjectOwnership | undefined,
): Promise<void> {
  if (!ownership) {
    return;
  }
  const current = await transaction.get<StoredProjectOwnership>('meta', ownership.key);
  if (current?.ownerId !== ownership.ownerId || current.epoch !== ownership.epoch) {
    throw new StaleProjectOwnershipError(projectId);
  }
}

function assertWritableProject(
  project: StoredProjectRecord | undefined,
  migrationFailed: boolean,
): void {
  if (migrationFailed || projectNeedsRecovery(project)) {
    throw new ProjectReadOnlyError(project?.id ?? 'unknown');
  }
}

function toWriteAccess(state: ReturnType<WebProjectOwnership['getState']>): ProjectWriteAccess {
  return {
    role: state.role,
    ownerId: state.ownerId,
    epoch: state.epoch,
  };
}

export function createWebProjectRepository(
  database: WebDatabase = getWebDatabase(),
  options: WebProjectRepositoryOptions = {},
): ProjectRepository {
  const ownershipEnabled = options.ownership
    ?? (typeof navigator !== 'undefined' && 'locks' in navigator);
  const coordinators = new Map<string, WebProjectOwnership>();
  const migrationFailures = new Set<string>();
  const ownershipFor = (projectId: string): WebProjectOwnership => {
    const existing = coordinators.get(projectId);
    if (existing) {
      return existing;
    }
    const coordinator = options.createOwnership?.(projectId)
      ?? createWebProjectOwnership({ projectId, database });
    coordinators.set(projectId, coordinator);
    return coordinator;
  };
  const ownedWriteAccess = async (projectId: string): Promise<StoredProjectOwnership | null> => {
    if (!ownershipEnabled) {
      return null;
    }
    const coordinator = ownershipFor(projectId);
    const current = await coordinator.start();
    if (current.role !== 'writer' || !coordinator.canWrite(current.epoch)) {
      throw new ProjectReadOnlyError(projectId);
    }
    return {
      key: `${PROJECT_OWNERSHIP_META_PREFIX}${projectId}`,
      projectId,
      ownerId: current.ownerId,
      epoch: current.epoch,
    };
  };
  const isRecoveryProject = async (projectId: string): Promise<boolean> => {
    if (migrationFailures.has(projectId)) {
      return true;
    }
    return database.run(['projects'], 'readonly', async (transaction) => (
      projectNeedsRecovery(await transaction.get<StoredProjectRecord>('projects', projectId))
    ));
  };
  const writableOwnership = async (projectId: string): Promise<StoredProjectOwnership | null> => {
    if (!ownershipEnabled) {
      return null;
    }
    if (await isRecoveryProject(projectId)) {
      throw new ProjectReadOnlyError(projectId);
    }
    return ownedWriteAccess(projectId);
  };
  const recoveryAwareWriteAccess = async (
    projectId: string,
    acquire: () => Promise<ReturnType<WebProjectOwnership['getState']>>,
  ): Promise<ProjectWriteAccess> => {
    const access = toWriteAccess(await acquire());
    return await isRecoveryProject(projectId) ? { ...access, role: 'readonly' } : access;
  };

  const repository = withProjectMutationOrdering({
    async listSummaries(): Promise<ProjectSummaryRecord[]> {
      return database.run(['projects'], 'readonly', async (transaction) => {
        const records = await transaction.getAll<StoredProjectRecord>('projects');
        return records.map(toSummary).sort((left, right) => right.updatedAt - left.updatedAt);
      });
    },
    async get(projectId): Promise<ProjectRecord | null> {
      const loaded = await database.run(['projects', 'history'], 'readonly', async (transaction) => {
        const project = await transaction.get<StoredProjectRecord>('projects', projectId);
        if (!project) {
          return null;
        }
        const history = await transaction.get<StoredHistoryRecord>('history', projectId);
        return { project, history };
      });
      if (!loaded) {
        return null;
      }
      const migration = migratedProject(loaded.project);
      if (migration.needsPersistence) {
        try {
          await database.run(['projects'], 'readwrite', async (transaction) => {
            const current = await transaction.get<StoredProjectRecord>('projects', projectId);
            if (current && (current.schemaVersion === undefined || current.schemaVersion === 0)) {
              await transaction.put('projects', migration.record);
            }
          });
        } catch {
          migrationFailures.add(projectId);
          return toProjectRecord(loaded.project, loaded.history, { reason: 'migration_failed' });
        }
      }
      migrationFailures.delete(projectId);
      return toProjectRecord(migration.record, loaded.history);
    },
    async saveSnapshot(record, options?: ProjectSnapshotWriteOptions): Promise<void> {
      const ownership = options?.ownership ?? await writableOwnership(record.id);
      const effectiveOptions = ownership ? { ...options, ownership } : options;
      const storeNames = effectiveOptions?.ownership
        ? (['projects', 'history', 'meta'] as const)
        : (['projects', 'history'] as const);
      await database.run(storeNames, 'readwrite', async (transaction) => {
        const current = await transaction.get<StoredProjectRecord>('projects', record.id);
        assertWritableProject(current, migrationFailures.has(record.id));
        const actualRevision = current?.revision ?? 'r0';
        if (effectiveOptions?.expectedRevision !== undefined && actualRevision !== effectiveOptions.expectedRevision) {
          throw new StaleProjectRevisionError(record.id, effectiveOptions.expectedRevision, actualRevision);
        }
        await assertCurrentOwnership(transaction, record.id, effectiveOptions?.ownership && {
          key: `${PROJECT_OWNERSHIP_META_PREFIX}${record.id}`,
          projectId: record.id,
          ...effectiveOptions.ownership,
        });
        await transaction.put('projects', toStoredProjectRecord(record));
        await transaction.put<StoredHistoryRecord>('history', {
          projectId: record.id,
          historyJson: record.historyJson,
        });
      });
    },
    async updateViewport(projectId, viewportJson): Promise<void> {
      const ownership = await writableOwnership(projectId);
      await database.run(ownership ? ['projects', 'meta'] : ['projects'], 'readwrite', async (transaction) => {
        const project = await transaction.get<StoredProjectRecord>('projects', projectId);
        assertWritableProject(project, migrationFailures.has(projectId));
        await assertCurrentOwnership(transaction, projectId, ownership ?? undefined);
        if (project) {
          await transaction.put('projects', { ...project, viewportJson });
        }
      });
    },
    async rename(projectId, name, updatedAt): Promise<void> {
      const ownership = await writableOwnership(projectId);
      await database.run(ownership ? ['projects', 'meta'] : ['projects'], 'readwrite', async (transaction) => {
        const project = await transaction.get<StoredProjectRecord>('projects', projectId);
        assertWritableProject(project, migrationFailures.has(projectId));
        await assertCurrentOwnership(transaction, projectId, ownership ?? undefined);
        if (project) {
          await transaction.put('projects', { ...project, name, updatedAt });
        }
      });
    },
    async delete(projectId): Promise<void> {
      const ownership = await ownedWriteAccess(projectId);
      await database.run(ownership ? ['projects', 'history', 'meta'] : ['projects', 'history'], 'readwrite', async (transaction) => {
        await assertCurrentOwnership(transaction, projectId, ownership ?? undefined);
        await transaction.delete('projects', projectId);
        await transaction.delete('history', projectId);
        if (ownership) {
          await transaction.delete('meta', ownership.key);
        }
      });
      migrationFailures.delete(projectId);
    },
    async createProjectDirs(): Promise<void> {},
  });
  return {
    ...repository,
    getWriteAccess: (projectId) => recoveryAwareWriteAccess(projectId, () => ownershipFor(projectId).start()),
    takeOverWriteAccess: (projectId) => recoveryAwareWriteAccess(projectId, () => ownershipFor(projectId).takeover()),
    watchWriteAccess: (projectId, listener) => ownershipFor(projectId).subscribe((state) => {
      listener({ role: state.role, ownerId: state.ownerId, epoch: state.epoch });
    }),
  };
}

export const webProjectRepository = createWebProjectRepository();
