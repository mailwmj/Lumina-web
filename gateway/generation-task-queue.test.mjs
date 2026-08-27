import { describe, expect, it, vi } from 'vitest';

import {
  createGenerationTaskQueue,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MAX_PENDING_TASKS_PER_SOURCE,
} from './generation-task-queue.mjs';

function task(id) {
  return { id, sourceId: 'source-1', status: 'queued' };
}

describe('generation task queue', () => {
  it('defines the requested queue and execution defaults', () => {
    expect(DEFAULT_MAX_PENDING_TASKS_PER_SOURCE).toBe(400);
    expect(DEFAULT_MAX_CONCURRENT_TASKS).toBe(50);

    const tasks = new Map();
    const queue = createGenerationTaskQueue({
      tasks,
      execute: () => new Promise(() => {}),
    });
    const accepted = Array.from({ length: 400 }, (_, index) => (
      queue.enqueue(task(`task-${index + 1}`), null)
    ));

    expect(accepted.every(Boolean)).toBe(true);
    expect(queue.counts()).toEqual({ active: 50, waiting: 350 });
    expect(queue.enqueue(task('task-401'), null)).toBeNull();
  });

  it('queues work beyond the execution limit and replenishes a released slot', async () => {
    const tasks = new Map();
    let releaseFirst;
    const firstExecution = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const execute = vi.fn(async (queuedTask) => {
      if (queuedTask.id === 'task-1') await firstExecution;
      queuedTask.status = 'succeeded';
    });
    const queue = createGenerationTaskQueue({
      tasks,
      execute,
      maxPendingTasksPerSource: 3,
      maxConcurrentTasks: 1,
    });

    const first = queue.enqueue(task('task-1'), null);
    const second = queue.enqueue(task('task-2'), null);
    const third = queue.enqueue(task('task-3'), null);

    expect(first?.started).toBe(true);
    expect(second?.started).toBe(false);
    expect(third?.started).toBe(false);
    expect(queue.counts()).toEqual({ active: 1, waiting: 2 });
    expect(execute).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await first?.completion;
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    await Promise.all([second?.completion, third?.completion]);
    expect(queue.counts()).toEqual({ active: 0, waiting: 0 });
  });

  it('keeps a provider-running task in its execution slot until it becomes terminal', async () => {
    const tasks = new Map();
    const execute = vi.fn(async (queuedTask) => {
      queuedTask.status = 'running';
    });
    const queue = createGenerationTaskQueue({
      tasks,
      execute,
      maxPendingTasksPerSource: 2,
      maxConcurrentTasks: 1,
    });

    const first = queue.enqueue(task('task-1'), null);
    const second = queue.enqueue(task('task-2'), null);
    await first?.completion;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(queue.counts()).toEqual({ active: 1, waiting: 1 });

    tasks.get('task-1').status = 'succeeded';
    queue.taskUpdated();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await second?.completion;
  });

  it('rejects only when the pending-task capacity is exhausted', () => {
    const tasks = new Map();
    const queue = createGenerationTaskQueue({
      tasks,
      execute: () => new Promise(() => {}),
      maxPendingTasksPerSource: 2,
      maxConcurrentTasks: 1,
    });

    expect(queue.enqueue(task('task-1'), null)).not.toBeNull();
    expect(queue.enqueue(task('task-2'), null)).not.toBeNull();
    expect(queue.enqueue(task('task-3'), null)).toBeNull();
  });
});
