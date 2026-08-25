import { describe, expect, it, vi } from 'vitest';

import type { RuntimeProjectClient } from '@/runtime/runtimeProjectClient';
import type { ProjectRecord } from '@/features/project/domain/projectRepository';
import { createRuntimeProjectRepository } from './runtimeProjectRepository';

const record: ProjectRecord = {
  id: 'project-1',
  name: 'Project',
  createdAt: 10,
  updatedAt: 20,
  nodeCount: 1,
  schemaVersion: 1,
  nodesJson: '{"nodes":[]}',
  edgesJson: '[]',
  viewportJson: '{"x":0,"y":0,"zoom":1}',
  historyJson: '{"past":[],"future":[]}',
};

describe('RuntimeProjectRepository', () => {
  it('delegates logical project operations to the shared Runtime client', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue([{ id: record.id }]),
      openProject: vi.fn().mockResolvedValue(record),
      saveProject: vi.fn().mockResolvedValue(record),
      updateViewport: vi.fn().mockResolvedValue(record),
      renameProject: vi.fn().mockResolvedValue(record),
      deleteProject: vi.fn().mockResolvedValue(true),
    } as unknown as RuntimeProjectClient;
    const repository = createRuntimeProjectRepository(client);

    await expect(repository.listSummaries()).resolves.toEqual([{ id: record.id }]);
    await expect(repository.get(record.id)).resolves.toEqual(record);
    await repository.saveSnapshot(record);
    await repository.updateViewport(record.id, '{"x":1,"y":2,"zoom":1.1}');
    await repository.rename(record.id, 'Renamed', 30);
    await repository.delete(record.id);

    expect(client.listProjects).toHaveBeenCalledTimes(1);
    expect(client.openProject).toHaveBeenCalledWith(record.id);
    expect(client.saveProject).toHaveBeenCalledWith(record);
    expect(client.updateViewport).toHaveBeenCalledWith(
      record.id,
      '{"x":1,"y":2,"zoom":1.1}',
    );
    expect(client.renameProject).toHaveBeenCalledWith(record.id, 'Renamed', 30);
    expect(client.deleteProject).toHaveBeenCalledWith(record.id);
  });
});
