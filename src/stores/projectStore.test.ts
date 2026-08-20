import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type {
  ProjectRecord,
  ProjectRepository,
  ProjectSummaryRecord,
  ProjectWriteAccess,
} from '@/features/project/domain/projectRepository';
import { createProjectStore, sanitizeProjectNodesForPersistence } from './projectStoreCore';

describe('text generation project persistence', () => {
  it('keeps durable text data and removes runtime run state', () => {
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.textGeneration, { x: 0, y: 0 }, {
      inputText: 'input',
      generatedText: 'result',
      textApiId: 'provider-a',
      textModelId: 'model-a',
      isGenerating: true,
      generationError: 'temporary error',
      generationErrorDetails: 'temporary details',
    });

    const [sanitized] = sanitizeProjectNodesForPersistence([node]);

    expect(sanitized.data).toMatchObject({
      inputText: 'input',
      generatedText: 'result',
      textApiId: 'provider-a',
      textModelId: 'model-a',
    });
    expect(sanitized.data).not.toHaveProperty('isGenerating');
    expect(sanitized.data).not.toHaveProperty('generationError');
    expect(sanitized.data).not.toHaveProperty('generationErrorDetails');
  });
});

describe('asset-backed project history persistence', () => {
  it('keeps asset IDs in retained history without serializing display URLs', async () => {
    vi.useFakeTimers();
    const repository = createRepositoryMock();
    const store = createProjectStore(repository);
    store.getState().createProject('Project');
    await flushPromises();
    vi.mocked(repository.saveSnapshot).mockClear();

    const image = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {
      assetId: 'asset-history-1',
      imageUrl: 'data:image/png;base64,do-not-persist-this-display-url',
    });
    store.getState().saveCurrentProject([image], [], undefined, {
      past: [{ nodes: [image], edges: [] }],
      future: [],
    });
    await vi.advanceTimersByTimeAsync(260);
    await vi.advanceTimersByTimeAsync(64);
    await flushPromises();

    const [record] = vi.mocked(repository.saveSnapshot).mock.calls[0] ?? [];
    expect(record?.historyJson).toContain('asset-history-1');
    expect(record?.historyJson).not.toContain('do-not-persist-this-display-url');
    expect(record?.revision).toBe('r1');
  });
});

function createRepositoryMock(): ProjectRepository {
  return {
    listSummaries: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    saveSnapshot: vi.fn().mockResolvedValue(undefined),
    updateViewport: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    createProjectDirs: vi.fn().mockResolvedValue(undefined),
  };
}

function createStatefulRepository(): ProjectRepository {
  const records = new Map<string, ProjectRecord>();
  return {
    listSummaries: async (): Promise<ProjectSummaryRecord[]> => [...records.values()].map((record) => ({
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      nodeCount: record.nodeCount,
    })),
    get: async (projectId) => records.get(projectId) ?? null,
    saveSnapshot: async (record) => {
      records.set(record.id, structuredClone(record));
    },
    updateViewport: async (projectId, viewportJson) => {
      const record = records.get(projectId);
      if (record) {
        records.set(projectId, { ...record, viewportJson });
      }
    },
    rename: async (projectId, name, updatedAt) => {
      const record = records.get(projectId);
      if (record) {
        records.set(projectId, { ...record, name, updatedAt });
      }
    },
    delete: async (projectId) => {
      records.delete(projectId);
    },
    createProjectDirs: async () => undefined,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

describe('project store persistence scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('debounces a full snapshot and dispatches it during idle time', async () => {
    const repository = createRepositoryMock();
    const idleCallbacks: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    const store = createProjectStore(repository);
    store.getState().createProject('Project');
    await flushPromises();
    vi.mocked(repository.saveSnapshot).mockClear();

    store.getState().saveCurrentProject([], [], { x: 1, y: 0, zoom: 1 });
    store.getState().saveCurrentProject([], [], { x: 2, y: 0, zoom: 1 });

    await vi.advanceTimersByTimeAsync(259);
    expect(repository.saveSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(idleCallbacks).toHaveLength(1);
    expect(repository.saveSnapshot).not.toHaveBeenCalled();

    idleCallbacks[0]();
    await flushPromises();
    expect(repository.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(repository.saveSnapshot).mock.calls[0][0].viewportJson)).toEqual({
      x: 2,
      y: 0,
      zoom: 1,
    });
  });

  it('flushes pending snapshots before page exit without waiting for debounce or idle time', async () => {
    const repository = createRepositoryMock();
    const idleCallbacks: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    const store = createProjectStore(repository);
    store.getState().createProject('Project');
    await flushPromises();
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    vi.mocked(repository.saveSnapshot).mockClear();

    store.getState().saveCurrentProject([], [], { x: 8, y: -4, zoom: 1.2 });
    store.getState().flushPendingPersistence();
    await flushPromises();

    expect(repository.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(idleCallbacks).toHaveLength(0);
    expect(JSON.parse(vi.mocked(repository.saveSnapshot).mock.calls[0][0].viewportJson)).toEqual({
      x: 8,
      y: -4,
      zoom: 1.2,
    });
  });

  it('persists move-end viewport independently and filters normalized jitter', async () => {
    const repository = createRepositoryMock();
    const store = createProjectStore(repository);
    store.getState().createProject('Project');
    await flushPromises();
    vi.mocked(repository.saveSnapshot).mockClear();

    store.getState().saveCurrentProjectViewport({ x: 0.0004, y: 0, zoom: 1 });
    await vi.advanceTimersByTimeAsync(280);
    expect(repository.updateViewport).not.toHaveBeenCalled();

    store.getState().saveCurrentProjectViewport({ x: 1.234, y: 2.346, zoom: 1.23456 });
    await vi.advanceTimersByTimeAsync(280);
    await flushPromises();

    expect(repository.saveSnapshot).not.toHaveBeenCalled();
    expect(repository.updateViewport).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repository.updateViewport).mock.calls[0][1]).toBe(
      '{"x":1.23,"y":2.35,"zoom":1.2346}'
    );
  });

  it('keeps delete final when the injected repository has a save in flight', async () => {
    const records = new Map<string, Parameters<ProjectRepository['saveSnapshot']>[0]>();
    const saveStarted = deferred();
    const releaseSave = deferred();
    const deleteStarted = deferred();
    const repository = createRepositoryMock();
    repository.saveSnapshot = vi.fn(async (record) => {
      saveStarted.resolve();
      await releaseSave.promise;
      records.set(record.id, record);
    });
    repository.delete = vi.fn(async (projectId) => {
      deleteStarted.resolve();
      records.delete(projectId);
    });
    const store = createProjectStore(repository);

    const projectId = store.getState().createProject('Project');
    await saveStarted.promise;
    store.getState().deleteProject(projectId);
    releaseSave.resolve();
    await deleteStarted.promise;
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }

    expect(records.has(projectId)).toBe(false);
    expect(repository.delete).toHaveBeenCalledWith(projectId);
  });


  it('cancels a queued viewport write when a full snapshot is queued', async () => {
    const repository = createRepositoryMock();
    const idleCallbacks: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    const store = createProjectStore(repository);
    store.getState().createProject('Project');
    await flushPromises();
    vi.mocked(repository.saveSnapshot).mockClear();

    store.getState().saveCurrentProjectViewport({ x: 5, y: 0, zoom: 1 });
    store.getState().saveCurrentProject([], [], { x: 5, y: 0, zoom: 1 });
    await vi.advanceTimersByTimeAsync(280);
    for (const callback of idleCallbacks) {
      callback();
    }
    await flushPromises();

    expect(repository.updateViewport).not.toHaveBeenCalled();
    expect(repository.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('restores a text annotation, edge, and viewport when a new store hydrates', async () => {
    vi.useFakeTimers();
    const repository = createStatefulRepository();
    const firstStore = createProjectStore(repository);
    const projectId = firstStore.getState().createProject('Project');
    await flushPromises();

    const annotation = canvasNodeFactory.createNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 120, y: 80 },
      { content: 'persisted note' }
    );
    const edge = {
      id: 'edge-1',
      source: annotation.id,
      target: 'another-node',
    };
    firstStore.getState().saveCurrentProject(
      [annotation],
      [edge],
      { x: 18, y: -24, zoom: 1.25 }
    );
    await vi.advanceTimersByTimeAsync(260);
    await vi.advanceTimersByTimeAsync(64);
    await flushPromises();

    const reloadedStore = createProjectStore(repository);
    await reloadedStore.getState().hydrate();
    reloadedStore.getState().openProject(projectId);
    await flushPromises();

    expect(reloadedStore.getState().currentProject).toMatchObject({
      id: projectId,
      nodes: [{
        id: annotation.id,
        position: { x: 120, y: 80 },
        data: { content: 'persisted note' },
      }],
      edges: [edge],
      viewport: { x: 18, y: -24, zoom: 1.25 },
    });
  });

  it('writes the revision read before a queued snapshot', async () => {
    const repository = createRepositoryMock();
    const store = createProjectStore(repository);
    store.getState().createProject('Project');
    await vi.runAllTimersAsync();
    await flushPromises();
    vi.mocked(repository.saveSnapshot).mockClear();

    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.textAnnotation, { x: 8, y: 0 });
    store.getState().saveCurrentProject([node], [], { x: 8, y: 0, zoom: 1 });
    store.getState().flushPendingPersistence();
    await flushPromises();

    expect(repository.saveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 'r1' }),
      { expectedRevision: 'r0' },
    );
  });

  it('exposes a read-only project until the user explicitly takes over ownership', async () => {
    const repository = createStatefulRepository();
    const writer = createProjectStore(repository);
    const projectId = writer.getState().createProject('Project');
    await flushPromises();
    repository.getWriteAccess = vi.fn().mockResolvedValue({
      role: 'readonly',
      ownerId: 'other-tab',
      epoch: 4,
    });
    repository.takeOverWriteAccess = vi.fn().mockResolvedValue({
      role: 'writer',
      ownerId: 'this-tab',
      epoch: 5,
    });

    const reader = createProjectStore(repository);
    await reader.getState().hydrate();
    reader.getState().openProject(projectId);
    await flushPromises();
    expect(reader.getState().isCurrentProjectReadOnly).toBe(true);

    reader.getState().takeOverCurrentProject();
    await flushPromises();
    expect(reader.getState().isCurrentProjectReadOnly).toBe(false);
  });

  it('keeps a migration recovery project read-only when ownership reports a writer', async () => {
    const repository = createRepositoryMock();
    const recoveryProject: ProjectRecord = {
      id: 'recovery-project',
      name: 'Recovery project',
      createdAt: 1,
      updatedAt: 2,
      nodeCount: 0,
      revision: 'r1',
      nodesJson: '{"nodes":[],"imagePool":[]}',
      edgesJson: '[]',
      viewportJson: '{"x":0,"y":0,"zoom":1}',
      historyJson: '{"past":[],"future":[]}',
      recovery: { reason: 'unsupported_schema' },
    };
    let notifyOwnership: (access: ProjectWriteAccess) => void = () => undefined;
    repository.get = vi.fn().mockResolvedValue(recoveryProject);
    repository.getWriteAccess = vi.fn().mockResolvedValue({
      role: 'writer',
      ownerId: 'this-tab',
      epoch: 1,
    });
    repository.watchWriteAccess = vi.fn((_projectId, listener) => {
      notifyOwnership = listener;
      return () => undefined;
    });
    const store = createProjectStore(repository);

    store.getState().openProject(recoveryProject.id);
    await flushPromises();
    expect(store.getState().isCurrentProjectReadOnly).toBe(true);

    notifyOwnership({ role: 'writer', ownerId: 'this-tab', epoch: 2 });
    expect(store.getState().isCurrentProjectReadOnly).toBe(true);
  });
});
