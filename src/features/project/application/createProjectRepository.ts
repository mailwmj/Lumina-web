import type { ProjectRepository } from '@/features/project/domain/projectRepository';
import { webProjectRepository } from '@/features/project/infrastructure/webProjectRepository';

export function createProjectRepository(): ProjectRepository {
  return webProjectRepository;
}
