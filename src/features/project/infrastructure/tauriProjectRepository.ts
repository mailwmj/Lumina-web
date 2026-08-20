import {
  type ProjectRecord,
  type ProjectRepository,
} from '@/features/project/domain/projectRepository';
import { withProjectMutationOrdering } from '@/features/project/application/withProjectMutationOrdering';

export interface RuntimeInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export function createTauriProjectRepository(invoker: RuntimeInvoker): ProjectRepository {
  return withProjectMutationOrdering({
    listSummaries: () => invoker.invoke('list_project_summaries'),
    get: (projectId) => invoker.invoke('get_project_record', { projectId }),
    saveSnapshot: (record: ProjectRecord) => invoker.invoke('upsert_project_record', { record }),
    updateViewport: (projectId, viewportJson) =>
      invoker.invoke('update_project_viewport_record', { projectId, viewportJson }),
    rename: (projectId, name, updatedAt) =>
      invoker.invoke('rename_project_record', { projectId, name, updatedAt }),
    delete: (projectId) => invoker.invoke('delete_project_record', { projectId }),
    createProjectDirs: (projectId, projectName) =>
      invoker.invoke('create_project_dirs', { projectId, projectName }),
  });
}
