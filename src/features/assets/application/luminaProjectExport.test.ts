import { describe, expect, it, vi } from 'vitest';

import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import type { ProjectRecord, ProjectRepository } from '@/features/project/domain/projectRepository';
import { createLuminaProjectExport } from './luminaProjectExport';

interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;

  while (view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.push({
      path: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      bytes: bytes.slice(dataStart, dataStart + compressedSize),
    });
    offset = dataStart + compressedSize;
  }

  return entries;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function createProjectRecord(): ProjectRecord {
  return {
    id: 'project-1',
    name: 'Offline project',
    createdAt: 1,
    updatedAt: 2,
    nodeCount: 1,
    revision: 'r2',
    nodesJson: JSON.stringify({
      nodes: [{ id: 'image-1', data: { assetId: 'asset-current' } }],
      imagePool: [],
    }),
    edgesJson: '[]',
    viewportJson: '{"x":0,"y":0,"zoom":1}',
    historyJson: JSON.stringify({
      past: [{ nodes: [{ id: 'image-0', data: { previewAssetId: 'asset-history' } }], edges: [] }],
      future: [],
    }),
  };
}

function createAssetRepository(): AssetRepository {
  const blobs = new Map([
    ['asset-current', new Blob(['current-bytes'], { type: 'image/png' })],
    ['asset-history', new Blob(['history-bytes'], { type: 'image/png' })],
  ]);
  return {
    read: vi.fn(async (assetId: string) => blobs.get(assetId) ?? null),
    getMetadata: vi.fn(async (assetId: string) => {
      const blob = blobs.get(assetId);
      return blob ? {
        assetId,
        projectId: 'project-1',
        kind: 'image' as const,
        mimeType: blob.type,
        byteCount: blob.size,
        createdAt: 3,
        sourceKind: 'import' as const,
        width: null,
        height: null,
        durationMs: null,
        sourceMetadata: { fileName: `${assetId}.png` },
        lifecycleState: 'active' as const,
      } : null;
    }),
  } as unknown as AssetRepository;
}

describe('Lumina project export', () => {
  it('writes a versioned project, retained history, and every reachable asset with declared hashes', async () => {
    const project = createProjectRecord();
    const projectRepository = {
      get: vi.fn(async (projectId: string) => projectId === project.id ? project : null),
    } as Pick<ProjectRepository, 'get'>;
    const assetRepository = createAssetRepository();

    const archive = await createLuminaProjectExport({
      projectIds: [project.id],
      projectRepository,
      assetRepository,
      exportedAt: 123,
    });
    const entries = readZipEntries(new Uint8Array(await archive.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(
      entries.find((entry) => entry.path === 'manifest.json')?.bytes,
    )) as {
      format: string;
      version: number;
      exportedAt: number;
      entries: Array<{ path: string; byteCount: number; sha256: string }>;
      assets: Array<{ assetId: string; path: string; byteCount: number; sha256: string }>;
    };

    expect(entries.map((entry) => entry.path)).toEqual([
      'projects/0001/project.json',
      'projects/0001/history.json',
      'assets/0001.bin',
      'assets/0002.bin',
      'manifest.json',
    ]);
    expect(manifest).toMatchObject({
      format: 'lumina-project-export',
      version: 1,
      exportedAt: 123,
    });

    for (const entry of manifest.entries) {
      const actual = entries.find((candidate) => candidate.path === entry.path);
      expect(actual?.bytes.byteLength).toBe(entry.byteCount);
      expect(actual && await sha256(actual.bytes)).toBe(entry.sha256);
    }
    const expectedAssetHashes = new Map([
      ['asset-current', await sha256(new TextEncoder().encode('current-bytes'))],
      ['asset-history', await sha256(new TextEncoder().encode('history-bytes'))],
    ]);
    for (const asset of manifest.assets) {
      const actual = entries.find((entry) => entry.path === asset.path);
      expect(actual?.bytes.byteLength).toBe(asset.byteCount);
      expect(await sha256(actual?.bytes ?? new Uint8Array())).toBe(asset.sha256);
      expect(asset.sha256).toBe(expectedAssetHashes.get(asset.assetId));
    }
  });

  it('exports multiple selected projects, including an empty project, without unrelated assets', async () => {
    const first = createProjectRecord();
    const empty: ProjectRecord = {
      ...createProjectRecord(),
      id: 'project-2',
      name: 'Empty project',
      nodeCount: 0,
      nodesJson: '{"nodes":[],"imagePool":[]}',
      historyJson: '{"past":[],"future":[]}',
    };
    const projectRepository = {
      get: vi.fn(async (projectId: string) => ({
        [first.id]: first,
        [empty.id]: empty,
      })[projectId] ?? null),
    } as Pick<ProjectRepository, 'get'>;

    const archive = await createLuminaProjectExport({
      projectIds: [first.id, empty.id, first.id],
      projectRepository,
      assetRepository: createAssetRepository(),
      exportedAt: 123,
    });
    const entries = readZipEntries(new Uint8Array(await archive.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(
      entries.find((entry) => entry.path === 'manifest.json')?.bytes,
    )) as { projects: Array<{ id: string }>; entries: Array<{ path: string }> };

    expect(manifest.projects.map((project) => project.id)).toEqual([first.id, empty.id]);
    expect(entries.map((entry) => entry.path)).toEqual([
      'projects/0001/project.json',
      'projects/0001/history.json',
      'projects/0002/project.json',
      'projects/0002/history.json',
      'assets/0001.bin',
      'assets/0002.bin',
      'manifest.json',
    ]);
    expect(manifest.entries.map((entry) => entry.path)).not.toContain('assets/unrelated.bin');
  });

  it('uses a supplied current project snapshot instead of a stale persisted record', async () => {
    const current = createProjectRecord();
    const stale: ProjectRecord = {
      ...current,
      nodesJson: '{"nodes":[],"imagePool":[]}',
      historyJson: '{"past":[],"future":[]}',
      nodeCount: 0,
    };
    const projectRepository = {
      get: vi.fn(async () => stale),
    } as Pick<ProjectRepository, 'get'>;

    const archive = await createLuminaProjectExport({
      projectIds: [current.id],
      projectRecords: [current],
      projectRepository,
      assetRepository: createAssetRepository(),
    });
    const entries = readZipEntries(new Uint8Array(await archive.arrayBuffer()));

    expect(entries.map((entry) => entry.path)).toContain('assets/0001.bin');
    expect(projectRepository.get).not.toHaveBeenCalled();
  });

  it('blocks export when a reachable asset is missing', async () => {
    const project = createProjectRecord();
    const repository = createAssetRepository();
    vi.mocked(repository.read).mockResolvedValueOnce(new Blob(['current-bytes'], { type: 'image/png' }));
    vi.mocked(repository.read).mockResolvedValueOnce(null);
    const projectRepository = {
      get: vi.fn(async () => project),
    } as Pick<ProjectRepository, 'get'>;

    await expect(createLuminaProjectExport({
      projectIds: [project.id],
      projectRepository,
      assetRepository: repository,
    })).rejects.toMatchObject({ code: 'asset_unavailable' });
  });

  it('reports preparation progress before a large asset finishes reading', async () => {
    const project = createProjectRecord();
    let resolveRead: (blob: Blob) => void = () => undefined;
    const repository = createAssetRepository();
    vi.mocked(repository.read).mockImplementationOnce(() => new Promise<Blob>((resolve) => {
      resolveRead = resolve;
    }));
    const progress: Array<{ completedBytes: number; totalBytes: number }> = [];
    const projectRepository = {
      get: vi.fn(async () => ({
        ...project,
        historyJson: '{"past":[],"future":[]}',
      })),
    } as Pick<ProjectRepository, 'get'>;

    const exportPromise = createLuminaProjectExport({
      projectIds: [project.id],
      projectRepository,
      assetRepository: repository,
      onProgress: (next) => progress.push(next),
    });
    await vi.waitFor(() => expect(repository.read).toHaveBeenCalledOnce());
    expect(progress).toContainEqual(expect.objectContaining({ completedBytes: 0 }));

    resolveRead(new Blob(['current-bytes'], { type: 'image/png' }));
    await exportPromise;
  });

  it('removes credentials and temporary gateway URLs from contents and entry names', async () => {
    const project = createProjectRecord();
    project.nodesJson = JSON.stringify({
      nodes: [{
        id: 'image-1',
        data: {
          assetId: 'asset-current',
          apiKey: 'api-key-value',
          bridgeToken: 'bridge-token-value',
          resultUrl: 'https://gateway.example.test/tasks/temporary-result',
        },
      }],
      imagePool: [],
    });
    const projectRepository = {
      get: vi.fn(async () => project),
    } as Pick<ProjectRepository, 'get'>;
    const archive = await createLuminaProjectExport({
      projectIds: [project.id],
      projectRepository,
      assetRepository: createAssetRepository(),
    });
    const bytes = new Uint8Array(await archive.arrayBuffer());
    const contents = new TextDecoder().decode(bytes);
    const entries = readZipEntries(bytes);

    expect(contents).not.toContain('api-key-value');
    expect(contents).not.toContain('bridge-token-value');
    expect(contents).not.toContain('gateway.example.test');
    expect(entries.map((entry) => entry.path).join('\n')).not.toMatch(/api|token|gateway/i);
  });
});
