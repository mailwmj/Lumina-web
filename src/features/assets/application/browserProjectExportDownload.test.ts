import { describe, expect, it, vi } from 'vitest';

import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import type { ProjectRecord, ProjectRepository } from '@/features/project/domain/projectRepository';
import { downloadLuminaProjectExport } from './browserProjectBackup';

const project: ProjectRecord = {
  id: 'project-1',
  name: 'Offline project',
  revision: 'r2',
  createdAt: 1,
  updatedAt: 2,
  nodeCount: 1,
  nodesJson: JSON.stringify({
    nodes: [{ id: 'image-1', data: { assetId: 'asset-1' } }],
    imagePool: [],
  }),
  edgesJson: '[]',
  viewportJson: '{"x":0,"y":0,"zoom":1}',
  historyJson: '{"past":[],"future":[]}',
};

function createAssetRepository(): AssetRepository {
  const metadata = {
    assetId: 'asset-1',
    projectId: project.id,
    kind: 'image' as const,
    mimeType: 'image/png',
    byteCount: 6,
    createdAt: 3,
    sourceKind: 'import' as const,
    width: 2,
    height: 3,
    durationMs: null,
    sourceMetadata: { fileName: 'source.png' },
    lifecycleState: 'active' as const,
  };
  return {
    read: vi.fn().mockResolvedValue(new Blob(['pixels'], { type: 'image/png' })),
    getMetadata: vi.fn().mockResolvedValue(metadata),
  } as unknown as AssetRepository;
}

describe('browser project export download', () => {
  it('starts a versioned Lumina ZIP download, forwards progress, and revokes its temporary URL', async () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as CSSStyleDeclaration,
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement;
    const objectUrlApi = {
      createObjectURL: vi.fn(() => 'blob:project-backup'),
      revokeObjectURL: vi.fn(),
    };
    const onProgress = vi.fn();

    await downloadLuminaProjectExport({
      projectIds: [project.id],
      projectRepository: {
        get: vi.fn().mockResolvedValue(project),
      } as Pick<ProjectRepository, 'get'>,
      assetRepository: createAssetRepository(),
      onProgress,
    }, {
      documentRef: {
        createElement: vi.fn(() => anchor),
        body: { appendChild: vi.fn() },
      },
      objectUrlApi,
      now: () => 123,
    });

    expect(anchor.download).toBe('lumina-export-123.lumina');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(objectUrlApi.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(objectUrlApi.revokeObjectURL).toHaveBeenCalledWith('blob:project-backup');
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      completedEntries: 4,
      totalEntries: 4,
    }));
  });
});
