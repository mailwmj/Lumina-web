import { describe, expect, it } from 'vitest';

import type { ProjectRecord, ProjectRepository } from './projectRepository';

const contractRecord: ProjectRecord = {
  id: 'contract-project',
  name: 'Contract project',
  createdAt: 10,
  updatedAt: 20,
  nodeCount: 1,
  schemaVersion: 1,
  nodesJson: '[{"id":"node-1"}]',
  edgesJson: '[]',
  viewportJson: '{"x":0,"y":0,"zoom":1}',
  historyJson: '{"past":[],"future":[]}',
};

export function defineProjectRepositoryContract(
  implementationName: string,
  createRepository: () => ProjectRepository
): void {
  describe(`${implementationName} ProjectRepository contract`, () => {
    it('round-trips complete snapshots and keeps viewport updates independent', async () => {
      const repository = createRepository();
      await repository.saveSnapshot(contractRecord);

      const replacement: ProjectRecord = {
        ...contractRecord,
        updatedAt: 30,
        nodeCount: 2,
        nodesJson: '[{"id":"node-2"}]',
        edgesJson: '[{"id":"edge-1"}]',
        historyJson: '{"past":[{"nodes":[]}],"future":[]}',
      };
      await repository.saveSnapshot(replacement);
      await repository.updateViewport(contractRecord.id, '{"x":4,"y":5,"zoom":1.2}');

      expect(await repository.get(contractRecord.id)).toEqual({
        ...replacement,
        viewportJson: '{"x":4,"y":5,"zoom":1.2}',
      });
      expect(await repository.listSummaries()).toEqual([
        {
          id: replacement.id,
          name: replacement.name,
          createdAt: replacement.createdAt,
          updatedAt: replacement.updatedAt,
          nodeCount: replacement.nodeCount,
        },
      ]);
    });

    it('supports missing-record no-ops, rename, and delete', async () => {
      const repository = createRepository();
      await repository.updateViewport('missing', '{}');
      await repository.rename('missing', 'Ignored', 1);
      await repository.saveSnapshot(contractRecord);
      await repository.rename(contractRecord.id, 'Renamed', 40);

      expect(await repository.get(contractRecord.id)).toEqual({
        ...contractRecord,
        name: 'Renamed',
        updatedAt: 40,
      });

      await repository.delete(contractRecord.id);
      expect(await repository.get(contractRecord.id)).toBeNull();
      expect(await repository.listSummaries()).toEqual([]);
    });
  });
}
