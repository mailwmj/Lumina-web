import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  getVersion: vi.fn(),
  openDialog: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  isTauri: tauri.isTauri,
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: tauri.getVersion }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: tauri.openDialog }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: tauri.openUrl }));

const webRecords = vi.hoisted(() => new Map<string, {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  nodesJson: string;
  edgesJson: string;
  viewportJson: string;
  historyJson: string;
}>());
vi.mock('@/features/project/infrastructure/webProjectRepository', () => ({
  webProjectRepository: {
    listSummaries: async () => [...webRecords.values()].map((item) => ({
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      nodeCount: item.nodeCount,
    })),
    get: async (projectId: string) => webRecords.get(projectId) ?? null,
    saveSnapshot: async (item: RuntimeProjectRecord) => {
      webRecords.set(item.id, item);
    },
    updateViewport: async (projectId: string, viewportJson: string) => {
      const item = webRecords.get(projectId);
      if (item) {
        webRecords.set(projectId, { ...item, viewportJson });
      }
    },
    rename: async (projectId: string, name: string, updatedAt: number) => {
      const item = webRecords.get(projectId);
      if (item) {
        webRecords.set(projectId, { ...item, name, updatedAt });
      }
    },
    delete: async (projectId: string) => {
      webRecords.delete(projectId);
    },
    createProjectDirs: async () => undefined,
  },
}));

import { runtime, type RuntimeProjectRecord } from './runtime';

const record: RuntimeProjectRecord = {
  id: 'project-1',
  name: 'Web project',
  createdAt: 1,
  updatedAt: 1,
  nodeCount: 0,
  nodesJson: '[]',
  edgesJson: '[]',
  viewportJson: JSON.stringify({ x: 0, y: 0, zoom: 1 }),
  historyJson: JSON.stringify({ past: [], future: [] }),
};

beforeEach(() => {
  webRecords.clear();
  tauri.invoke.mockReset();
  tauri.isTauri.mockReset();
  tauri.getVersion.mockReset();
  tauri.openDialog.mockReset();
  tauri.openUrl.mockReset();
});

describe('runtime composition', () => {
  it('serves project records from the browser runtime without invoking Tauri', async () => {
    tauri.isTauri.mockReturnValue(false);

    await runtime.invoke('upsert_project_record', { record });
    expect(await runtime.invoke('list_project_summaries')).toEqual([
      {
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        nodeCount: record.nodeCount,
      },
    ]);
    expect(await runtime.invoke('get_project_record', { projectId: record.id })).toEqual(record);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it('routes desktop commands through the existing Tauri command boundary', async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockResolvedValue([{ id: 'desktop-project' }]);

    await expect(runtime.invoke('list_project_summaries')).resolves.toEqual([
      { id: 'desktop-project' },
    ]);
    expect(tauri.invoke).toHaveBeenCalledWith('list_project_summaries');
  });

  it('makes native-only capabilities explicit in Web mode', async () => {
    tauri.isTauri.mockReturnValue(false);

    await expect(runtime.invoke('generate_image')).rejects.toThrow(
      'Web runtime does not support command "generate_image" yet'
    );
    await expect(runtime.openDirectory()).resolves.toBeNull();
    expect(tauri.openDialog).not.toHaveBeenCalled();
  });
});
