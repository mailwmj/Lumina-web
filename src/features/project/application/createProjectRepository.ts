import { runtime } from '@/runtime/runtime';
import type { ProjectRepository } from '@/features/project/domain/projectRepository';
import { createTauriProjectRepository } from '@/features/project/infrastructure/tauriProjectRepository';
import { webProjectRepository } from '@/features/project/infrastructure/webProjectRepository';

export function createProjectRepository(): ProjectRepository {
  return runtime.isDesktop() ? createTauriProjectRepository(runtime) : webProjectRepository;
}
