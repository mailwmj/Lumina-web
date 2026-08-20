import { describe, expect, it, vi } from 'vitest';

import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import type { Project } from '@/stores/projectStore';
import {
  createBrowserProjectBackup,
  downloadBrowserProjectBackup,
} from './browserProjectBackup';

const project = {
  id: 'project-1',
  name: 'Offline project',
  revision: 'r2',
  createdAt: 1,
  updatedAt: 2,
  nodeCount: 1,
  nodes: [{ id: 'image-1', data: { assetId: 'asset-1' } }],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  history: { past: [], future: [] },
} as unknown as Project;

function createRepository(): AssetRepository {
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

describe('browser project backup', () => {
  it('includes the current project and referenced asset bytes without settings credentials', async () => {
    const backup = await createBrowserProjectBackup(project, createRepository(), 123);
    const payload = JSON.parse(await backup.text()) as {
      format: string;
      exportedAt: number;
      project: { id: string; revision: string };
      assets: Array<{ assetId: string; dataUrl: string }>;
    };

    expect(payload).toMatchObject({
      format: 'lumina-browser-project-backup',
      exportedAt: 123,
      project: { id: 'project-1', revision: 'r2' },
      assets: [{ assetId: 'asset-1', dataUrl: 'data:image/png;base64,cGl4ZWxz' }],
    });
    expect(JSON.stringify(payload)).not.toContain('apiKey');
  });

  it('starts a direct backup download and revokes its temporary URL', async () => {
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

    await downloadBrowserProjectBackup(project, createRepository(), {
      documentRef: {
        createElement: vi.fn(() => anchor),
        body: { appendChild: vi.fn() },
      },
      objectUrlApi,
      now: () => 123,
    });

    expect(anchor.download).toBe('Offline project.lumina-backup.json');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(objectUrlApi.revokeObjectURL).toHaveBeenCalledWith('blob:project-backup');
  });
});
