import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { ProjectRepository } from '@/features/project/domain/projectRepository';
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
});
