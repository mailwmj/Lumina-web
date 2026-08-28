import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type {
  ProjectRecord,
  ProjectRepository,
  ProjectSummaryRecord,
} from '@/features/project/domain/projectRepository';
import type { RuntimeEditorState } from '@/runtime/runtimeProjectClient';
import {
  createProjectStore,
  sanitizeProjectNodesForPersistence,
  type ProjectEditorAuthority,
} from './projectStoreCore';

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

describe('React Flow project persistence', () => {
  it('removes runtime layout fields from current and history snapshots', async () => {
    const repository = createRepositoryMock();
    const store = createProjectStore(repository);
    store.getState().createProject('Project');
    await flushPromises();
    vi.mocked(repository.saveSnapshot).mockClear();

    const measuredNode = {
      ...canvasNodeFactory.createNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }),
      measured: { width: 320, height: 240 },
      style: { width: 320, height: 240 },
    };
    await store.getState().saveCurrentProject(
      [measuredNode],
      [],
      { x: 0, y: 0, zoom: 1 },
      { past: [{ nodes: [measuredNode], edges: [] }], future: [] },
      { immediate: true },
    );

    const [record] = vi.mocked(repository.saveSnapshot).mock.calls[0] ?? [];
    const persistedNodes = JSON.parse(record?.nodesJson ?? '{}') as {
      nodes?: Array<Record<string, unknown>>;
    };
    const persistedHistory = JSON.parse(record?.historyJson ?? '{}') as {
      past?: Array<{ nodes: Array<Record<string, unknown>> }>;
    };
    expect(persistedNodes.nodes?.[0]).not.toHaveProperty('measured');
    expect(persistedNodes.nodes?.[0]).not.toHaveProperty('style');
    expect(persistedHistory.past?.[0]?.nodes[0]).not.toHaveProperty('measured');
    expect(persistedHistory.past?.[0]?.nodes[0]).not.toHaveProperty('style');
  });
});

describe('Runtime compatibility errors', () => {
  it('preserves the Runtime API mismatch code for the update-specific UI state', async () => {
    const repository = createRepositoryMock();
    vi.mocked(repository.listSummaries).mockRejectedValueOnce(Object.assign(
      new Error('This Lumina page is out of date. Reload to update.'),
      { code: 'runtime_api_incompatible' },
    ));
    const store = createProjectStore(repository);

    await store.getState().hydrate();

    expect(store.getState().hydrationErrorCode).toBe('runtime_api_incompatible');
    expect(store.getState().hydrationError).toContain('out of date');
  });

  it('preserves the Runtime API mismatch code for a failed project mutation', async () => {
    const repository = createRepositoryMock();
    vi.mocked(repository.rename).mockRejectedValueOnce(Object.assign(
      new Error('The Runtime project request is invalid.'),
      { code: 'runtime_api_incompatible' },
    ));
    const store = createProjectStore(repository);

    store.getState().renameProject('project-1', 'Renamed project');
    await flushPromises();
    await flushPromises();

    expect(store.getState().persistenceErrorCode).toBe('runtime_api_incompatible');
    expect(store.getState().persistenceError).toContain('Runtime project request');
  });
});

describe('MCP project lifecycle persistence', () => {
  it('does not resolve a created project until its complete Runtime snapshot is durable', async () => {
    const repository = createRepositoryMock();
    let finishSave!: () => void;
    vi.mocked(repository.saveSnapshot).mockImplementation(() => new Promise<void>((resolve) => {
      finishSave = resolve;
    }));
    const store = createProjectStore(repository);
    let createdProjectId: string | undefined;

    const creation = store.getState().createProjectPersisted('Agent project').then((projectId) => {
      createdProjectId = projectId;
      return projectId;
    });
    await vi.waitFor(() => expect(repository.saveSnapshot).toHaveBeenCalledTimes(1));

    expect(createdProjectId).toBeUndefined();
    expect(store.getState().currentProject).toBeNull();
    finishSave();

    const projectId = await creation;
    expect(projectId).toBe(store.getState().currentProjectId);
    expect(store.getState().currentProject?.name).toBe('Agent project');
    expect(repository.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('restores the previous project when a new project snapshot cannot be persisted', async () => {
    const repository = createRepositoryMock();
    const store = createProjectStore(repository);
    const previousProjectId = await store.getState().createProjectPersisted('Existing project');
    vi.mocked(repository.saveSnapshot).mockRejectedValueOnce(new Error('runtime unavailable'));

    await expect(store.getState().createProjectPersisted('Failed project'))
      .rejects.toThrow('runtime unavailable');

    expect(store.getState().currentProjectId).toBe(previousProjectId);
    expect(store.getState().currentProject?.name).toBe('Existing project');
    expect(store.getState().projects.map((project) => project.name))
      .toEqual(['Existing project']);
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
  });
});

describe('project-scoped editor ownership', () => {
  it('does not persist a project opened read-only while another editor owns it', async () => {
    const repository = createStatefulRepository();
    const writerStore = createProjectStore(repository);
    const projectId = writerStore.getState().createProject('Project');
    await flushPromises();

    const saveSnapshot = vi.spyOn(repository, 'saveSnapshot').mockRejectedValue(
      Object.assign(new Error('Another editor owns the Runtime editing lease.'), {
        code: 'editor_busy',
      }),
    );
    const busyState: RuntimeEditorState = {
      mode: 'busy',
      projectId,
      expiresAt: 10_000,
    };
    const authority: ProjectEditorAuthority = {
      getEditorState: () => busyState,
      subscribeEditorState: (listener) => {
        listener(busyState);
        return () => undefined;
      },
      acquireChromeEditor: vi.fn().mockRejectedValue(
        Object.assign(new Error('Another editor owns the Runtime editing lease.'), {
          code: 'editor_busy',
        }),
      ),
      releaseChromeEditor: vi.fn().mockResolvedValue(undefined),
    };
    const readerStore = createProjectStore(repository, authority);

    await readerStore.getState().hydrate();
    readerStore.getState().openProject(projectId);
    await flushPromises();
    await flushPromises();

    expect(readerStore.getState().isCurrentProjectReadOnly).toBe(true);
    await expect(readerStore.getState().saveCurrentProject(
      [],
      [],
      { x: 1, y: 0, zoom: 1 },
      undefined,
      { immediate: true },
    )).resolves.toBeUndefined();
    expect(saveSnapshot).not.toHaveBeenCalled();
    expect(readerStore.getState().persistenceError).toBeNull();
  });

  it('forces takeover only for the current project and releases it after closing', async () => {
    const repository = createRepositoryMock();
    let state: RuntimeEditorState = { mode: 'available' };
    const listeners = new Set<(next: RuntimeEditorState) => void>();
    const authority: ProjectEditorAuthority = {
      getEditorState: () => state,
      subscribeEditorState: (listener) => {
        listeners.add(listener);
        listener(state);
        return () => listeners.delete(listener);
      },
      acquireChromeEditor: vi.fn(async (projectId, options) => {
        expect(options).toEqual({ force: true });
        const next = { mode: 'chrome' as const, projectId, expiresAt: 10_000 };
        state = next;
        listeners.forEach((listener) => listener(next));
        return next;
      }),
      releaseChromeEditor: vi.fn().mockResolvedValue(undefined),
    };
    const store = createProjectStore(repository, authority);
    const projectId = store.getState().createProject('Project');

    state = { mode: 'available' };
    listeners.forEach((listener) => listener({ mode: 'busy', projectId, expiresAt: 9_000 }));
    await store.getState().reacquireEditor();

    expect(authority.acquireChromeEditor).toHaveBeenCalledWith(projectId, { force: true });
    await store.getState().closeProject();
    expect(authority.releaseChromeEditor).toHaveBeenCalledTimes(1);
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

  it('awaits an immediate snapshot and propagates a project persistence failure', async () => {
    const repository = createRepositoryMock();
    const store = createProjectStore(repository);
    store.getState().createProject('Project');
    await flushPromises();
    vi.mocked(repository.saveSnapshot).mockClear();
    vi.mocked(repository.saveSnapshot).mockRejectedValue(new Error('PROJECT_SAVE_FAILED'));

    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.textAnnotation, { x: 8, y: 0 });
    await expect(store.getState().saveCurrentProject(
      [node],
      [],
      { x: 8, y: 0, zoom: 1 },
      undefined,
      { immediate: true },
    )).rejects.toThrow('PROJECT_SAVE_FAILED');
    expect(repository.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight snapshot before an immediate save', async () => {
    const repository = createRepositoryMock();
    const store = createProjectStore(repository);
    store.getState().createProject('Project');
    await flushPromises();
    vi.mocked(repository.saveSnapshot).mockClear();

    const firstSaveStarted = deferred();
    const releaseFirstSave = deferred();
    repository.saveSnapshot = vi.fn(async () => {
      firstSaveStarted.resolve();
      await releaseFirstSave.promise;
    });

    const firstNode = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.textAnnotation, { x: 8, y: 0 });
    store.getState().saveCurrentProject([firstNode], [], { x: 8, y: 0, zoom: 1 });
    await vi.advanceTimersByTimeAsync(260);
    await vi.advanceTimersByTimeAsync(64);
    await firstSaveStarted.promise;

    const secondNode = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.textAnnotation, { x: 16, y: 0 });
    const immediateSave = store.getState().saveCurrentProject(
      [firstNode, secondNode],
      [],
      { x: 16, y: 0, zoom: 1 },
      undefined,
      { immediate: true },
    );
    releaseFirstSave.resolve();
    await immediateSave;

    expect(repository.saveSnapshot).toHaveBeenCalledTimes(2);
    expect(vi.mocked(repository.saveSnapshot).mock.calls[0][0].nodeCount).toBe(1);
    expect(vi.mocked(repository.saveSnapshot).mock.calls[1][0].nodeCount).toBe(2);
  });

  it('does not restore an old project after an immediate save crosses a project switch', async () => {
    const repository = createRepositoryMock();
    const store = createProjectStore(repository);
    store.getState().createProject('First');
    await flushPromises();
    vi.mocked(repository.saveSnapshot).mockClear();

    const saveStarted = deferred();
    const releaseSave = deferred();
    repository.saveSnapshot = vi.fn(async (record) => {
      if (record.name === 'First') {
        saveStarted.resolve();
        await releaseSave.promise;
      }
    });

    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.textAnnotation, { x: 8, y: 0 });
    const pendingSave = store.getState().saveCurrentProject(
      [node],
      [],
      { x: 8, y: 0, zoom: 1 },
      undefined,
      { immediate: true },
    );
    await saveStarted.promise;

    store.getState().createProject('Second');
    releaseSave.resolve();
    await pendingSave;
    await flushPromises();

    expect(store.getState().currentProject?.name).toBe('Second');
    expect(store.getState().currentProject?.nodes).toEqual([]);
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

});
