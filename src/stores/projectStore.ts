import { createProjectRepository } from '@/features/project/application/createProjectRepository';
import { createProjectStore } from './projectStoreCore';

export type { Project, ProjectSaveOptions, ProjectState, ProjectSummary } from './projectStoreCore';
export { sanitizeProjectNodesForPersistence } from './projectStoreCore';

export const useProjectStore = createProjectStore(createProjectRepository());
