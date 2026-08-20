import {
  type ProjectRecord,
  type ProjectRepository,
  type ProjectSummaryRecord,
} from '@/features/project/domain/projectRepository';
import { withProjectMutationOrdering } from '@/features/project/application/withProjectMutationOrdering';

const WEB_PROJECTS_STORAGE_KEY = 'lumina.web.projects.v1';
const webProjectMemory = new Map<string, ProjectRecord>();

function getWebStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readProjects(): Map<string, ProjectRecord> {
  const storage = getWebStorage();
  if (!storage) {
    return new Map(webProjectMemory);
  }

  try {
    const parsed = JSON.parse(storage.getItem(WEB_PROJECTS_STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Map();
    }
    return new Map(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, ProjectRecord] =>
          Boolean(entry[1]) && typeof entry[1] === 'object' && !Array.isArray(entry[1])
      )
    );
  } catch {
    return new Map(webProjectMemory);
  }
}

function writeProjects(projects: Map<string, ProjectRecord>): void {
  webProjectMemory.clear();
  for (const [id, record] of projects) {
    webProjectMemory.set(id, record);
  }

  const storage = getWebStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(WEB_PROJECTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(projects)));
  } catch {
    // Keep the session copy usable when browser storage rejects a write.
  }
}

export function createWebProjectRepository(): ProjectRepository {
  return withProjectMutationOrdering({
    async listSummaries(): Promise<ProjectSummaryRecord[]> {
      return [...readProjects().values()]
        .map(({ id, name, createdAt, updatedAt, nodeCount }) => ({
          id,
          name,
          createdAt,
          updatedAt,
          nodeCount,
        }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    },
    async get(projectId): Promise<ProjectRecord | null> {
      return readProjects().get(projectId) ?? null;
    },
    async saveSnapshot(record): Promise<void> {
      const projects = readProjects();
      projects.set(record.id, record);
      writeProjects(projects);
    },
    async updateViewport(projectId, viewportJson): Promise<void> {
      const projects = readProjects();
      const record = projects.get(projectId);
      if (record) {
        projects.set(projectId, { ...record, viewportJson });
        writeProjects(projects);
      }
    },
    async rename(projectId, name, updatedAt): Promise<void> {
      const projects = readProjects();
      const record = projects.get(projectId);
      if (record) {
        projects.set(projectId, { ...record, name, updatedAt });
        writeProjects(projects);
      }
    },
    async delete(projectId): Promise<void> {
      const projects = readProjects();
      projects.delete(projectId);
      writeProjects(projects);
    },
    async createProjectDirs(): Promise<void> {},
  });
}

export const webProjectRepository = createWebProjectRepository();
