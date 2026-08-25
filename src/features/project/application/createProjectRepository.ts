import type { ProjectRepository } from '@/features/project/domain/projectRepository';
import { createRuntimeProjectRepository } from '@/features/project/infrastructure/runtimeProjectRepository';
import { runtimeProjectClient } from '@/runtime/runtimeProjectClient';

export function createProjectRepository(): ProjectRepository {
  return createRuntimeProjectRepository(runtimeProjectClient);
}
