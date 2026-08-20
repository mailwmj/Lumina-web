import {
  getWebDatabase,
  type WebDatabase,
} from '@/runtime/webDatabase';
import {
  type ProjectRecord,
  type ProjectRepository,
  type ProjectSummaryRecord,
} from '@/features/project/domain/projectRepository';
import { withProjectMutationOrdering } from '@/features/project/application/withProjectMutationOrdering';

type StoredProjectRecord = Omit<ProjectRecord, 'historyJson'>;

interface StoredHistoryRecord {
  projectId: string;
  historyJson: string;
}

function toStoredProject(record: ProjectRecord): StoredProjectRecord {
  const { historyJson: _historyJson, ...project } = record;
  return project;
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

export function createWebProjectRepository(database: WebDatabase = getWebDatabase()): ProjectRepository {
  return withProjectMutationOrdering({
    async listSummaries(): Promise<ProjectSummaryRecord[]> {
      return database.run(['projects'], 'readonly', async (transaction) => {
        const records = await transaction.getAll<StoredProjectRecord>('projects');
        return records.map(toSummary).sort((left, right) => right.updatedAt - left.updatedAt);
      });
    },
    async get(projectId): Promise<ProjectRecord | null> {
      return database.run(['projects', 'history'], 'readonly', async (transaction) => {
        const project = await transaction.get<StoredProjectRecord>('projects', projectId);
        if (!project) {
          return null;
        }
        const history = await transaction.get<StoredHistoryRecord>('history', projectId);
        return {
          ...project,
          historyJson: history?.historyJson ?? '{"past":[],"future":[]}',
        };
      });
    },
    async saveSnapshot(record): Promise<void> {
      await database.run(['projects', 'history'], 'readwrite', async (transaction) => {
        await transaction.put('projects', toStoredProject(record));
        await transaction.put<StoredHistoryRecord>('history', {
          projectId: record.id,
          historyJson: record.historyJson,
        });
      });
    },
    async updateViewport(projectId, viewportJson): Promise<void> {
      await database.run(['projects'], 'readwrite', async (transaction) => {
        const project = await transaction.get<StoredProjectRecord>('projects', projectId);
        if (project) {
          await transaction.put('projects', { ...project, viewportJson });
        }
      });
    },
    async rename(projectId, name, updatedAt): Promise<void> {
      await database.run(['projects'], 'readwrite', async (transaction) => {
        const project = await transaction.get<StoredProjectRecord>('projects', projectId);
        if (project) {
          await transaction.put('projects', { ...project, name, updatedAt });
        }
      });
    },
    async delete(projectId): Promise<void> {
      await database.run(['projects', 'history'], 'readwrite', async (transaction) => {
        await transaction.delete('projects', projectId);
        await transaction.delete('history', projectId);
      });
    },
    async createProjectDirs(): Promise<void> {},
  });
}

export const webProjectRepository = createWebProjectRepository();
