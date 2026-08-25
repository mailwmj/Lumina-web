import type {
  ProjectRecord,
  ProjectRepository,
  ProjectSummaryRecord,
} from '@/features/project/domain/projectRepository';
import type { RuntimeProjectClient } from '@/runtime/runtimeProjectClient';

export function createRuntimeProjectRepository(
  client: RuntimeProjectClient,
): ProjectRepository {
  return {
    listSummaries(): Promise<ProjectSummaryRecord[]> {
      return client.listProjects<ProjectSummaryRecord>();
    },

    get(projectId: string): Promise<ProjectRecord | null> {
      return client.openProject<ProjectRecord>(projectId);
    },

    async saveSnapshot(record: ProjectRecord): Promise<void> {
      await client.saveProject(record);
    },

    async updateViewport(projectId: string, viewportJson: string): Promise<void> {
      await client.updateViewport(projectId, viewportJson);
    },

    async rename(projectId: string, name: string, updatedAt: number): Promise<void> {
      await client.renameProject(projectId, name, updatedAt);
    },

    async delete(projectId: string): Promise<void> {
      await client.deleteProject(projectId);
    },
  };
}
