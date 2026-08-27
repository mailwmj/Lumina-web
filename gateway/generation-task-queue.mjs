export const DEFAULT_MAX_PENDING_TASKS_PER_SOURCE = 400;
export const DEFAULT_MAX_CONCURRENT_TASKS = 50;

function isPending(task) {
  return task.status === 'queued' || task.status === 'running';
}

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), DEFAULT_MAX_PENDING_TASKS_PER_SOURCE)
    : fallback;
}

export function createGenerationTaskQueue({
  tasks,
  execute,
  onExecutionError,
  maxPendingTasksPerSource = DEFAULT_MAX_PENDING_TASKS_PER_SOURCE,
  maxConcurrentTasks = DEFAULT_MAX_CONCURRENT_TASKS,
}) {
  const pendingLimit = positiveInteger(maxPendingTasksPerSource, DEFAULT_MAX_PENDING_TASKS_PER_SOURCE);
  const concurrencyLimit = positiveInteger(maxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS);
  const pendingWork = new Map();
  const executingTaskIds = new Set();

  const pendingTaskCount = (sourceId) => [...tasks.values()]
    .filter((task) => task.sourceId === sourceId && isPending(task)).length;

  const activeTaskCount = () => {
    const activeTaskIds = new Set(executingTaskIds);
    for (const task of tasks.values()) {
      if (task.status === 'running') activeTaskIds.add(task.id);
    }
    return activeTaskIds.size;
  };

  const nextQueuedEntry = () => {
    for (const entry of pendingWork.values()) {
      if (entry.task.status === 'queued' && !executingTaskIds.has(entry.task.id)) {
        return entry;
      }
    }
    return null;
  };

  const drain = () => {
    while (activeTaskCount() < concurrencyLimit) {
      const entry = nextQueuedEntry();
      if (!entry) return;
      executingTaskIds.add(entry.task.id);
      void run(entry);
    }
  };

  const run = async (entry) => {
    try {
      await execute(entry.task, entry.work);
    } catch (error) {
      onExecutionError?.(entry.task, error);
    } finally {
      executingTaskIds.delete(entry.task.id);
      pendingWork.delete(entry.task.id);
      entry.resolveCompletion();
      drain();
    }
  };

  return {
    canEnqueue(sourceId) {
      return pendingTaskCount(sourceId) < pendingLimit;
    },
    enqueue(task, work) {
      if (pendingTaskCount(task.sourceId) >= pendingLimit) return null;

      let resolveCompletion;
      const completion = new Promise((resolve) => {
        resolveCompletion = resolve;
      });
      const entry = { task, work, completion, resolveCompletion };
      tasks.set(task.id, task);
      pendingWork.set(task.id, entry);
      drain();
      return {
        started: executingTaskIds.has(task.id),
        completion,
      };
    },
    taskUpdated() {
      drain();
    },
    reconcile() {
      for (const [taskId, entry] of pendingWork) {
        const task = tasks.get(taskId);
        if (!task || !isPending(task)) {
          pendingWork.delete(taskId);
          if (!executingTaskIds.has(taskId)) entry.resolveCompletion();
        }
      }
      drain();
    },
    counts() {
      return {
        active: activeTaskCount(),
        waiting: [...pendingWork.values()]
          .filter(({ task }) => task.status === 'queued' && !executingTaskIds.has(task.id)).length,
      };
    },
  };
}
