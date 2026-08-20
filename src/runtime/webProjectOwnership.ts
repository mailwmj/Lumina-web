import type { WebDatabase } from './webDatabase';

export const PROJECT_OWNERSHIP_META_PREFIX = 'project-ownership:';

export interface StoredProjectOwnership {
  key: string;
  projectId: string;
  ownerId: string;
  epoch: number;
}

export type ProjectOwnershipMessage =
  | {
      type: 'writer-acquired' | 'writer-released' | 'takeover-requested';
      projectId: string;
      ownerId: string;
      epoch: number;
    };

export type ProjectOwnershipRole = 'writer' | 'readonly' | 'released';

export interface ProjectOwnershipState {
  projectId: string;
  ownerId: string;
  epoch: number;
  role: ProjectOwnershipRole;
}

interface LockHandle {
  readonly name?: string;
}

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; mode?: 'exclusive' },
    callback: (lock: LockHandle | null) => Promise<void>,
  ): Promise<void>;
}

interface ChannelLike {
  postMessage(message: ProjectOwnershipMessage): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<ProjectOwnershipMessage>) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<ProjectOwnershipMessage>) => void,
  ): void;
  close(): void;
}

export interface WebProjectOwnershipOptions {
  projectId: string;
  ownerId?: string;
  database?: WebDatabase;
  locks?: LockManagerLike | null;
  createChannel?: (name: string) => ChannelLike | null;
}

export interface WebProjectOwnership {
  start(): Promise<ProjectOwnershipState>;
  takeover(): Promise<ProjectOwnershipState>;
  release(): Promise<void>;
  getState(): ProjectOwnershipState;
  canWrite(epoch?: number): boolean;
  subscribe(listener: (state: ProjectOwnershipState) => void): () => void;
}

const LOCK_PREFIX = 'lumina-project-writer:';
const CHANNEL_PREFIX = 'lumina-project-ownership:';

type OwnershipClaimMode = 'initial' | 'replace-inactive' | 'takeover';

function defaultOwnerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function defaultLocks(): LockManagerLike | null {
  const candidate = (globalThis as typeof globalThis & { navigator?: Navigator }).navigator?.locks;
  return candidate ? candidate : null;
}

function defaultChannel(name: string): ChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') {
    return null;
  }
  return new BroadcastChannel(name);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function createWebProjectOwnership({
  projectId,
  ownerId = defaultOwnerId(),
  database,
  locks = defaultLocks(),
  createChannel = defaultChannel,
}: WebProjectOwnershipOptions): WebProjectOwnership {
  if (!projectId.trim()) {
    throw new Error('A project ID is required for ownership coordination.');
  }

  const channel = createChannel(`${CHANNEL_PREFIX}${projectId}`);
  const listeners = new Set<(state: ProjectOwnershipState) => void>();
  let state: ProjectOwnershipState = {
    projectId,
    ownerId,
    epoch: 0,
    role: 'readonly',
  };
  let acquisition: Promise<ProjectOwnershipState> | null = null;
  let lockRequest: Promise<void> | null = null;
  let releaseLock: (() => void) | null = null;
  let released = false;

  const notify = (): void => {
    for (const listener of listeners) {
      listener(state);
    }
  };

  const setState = (next: ProjectOwnershipState): void => {
    state = next;
    notify();
  };

  const onMessage = (event: MessageEvent<ProjectOwnershipMessage>): void => {
    const message = event.data;
    if (!message || message.projectId !== projectId || message.ownerId === ownerId) {
      return;
    }
    if (message.type === 'takeover-requested' && message.epoch >= state.epoch) {
      setState({ ...state, epoch: message.epoch, role: 'readonly' });
      releaseLock?.();
      releaseLock = null;
    }
  };
  channel?.addEventListener('message', onMessage);

  const claim = async (mode: OwnershipClaimMode): Promise<number | null> => {
    if (!database) {
      return mode === 'takeover' ? state.epoch + 1 : state.epoch;
    }
    return database.run(['meta'], 'readwrite', async (transaction) => {
      const key = `${PROJECT_OWNERSHIP_META_PREFIX}${projectId}`;
      const current = await transaction.get<StoredProjectOwnership>('meta', key);
      if (mode !== 'takeover' && current?.ownerId === ownerId) {
        return current.epoch;
      }
      if (mode === 'initial' && current) {
        return null;
      }
      const epoch = mode === 'takeover' || current ? (current?.epoch ?? state.epoch) + 1 : 0;
      await transaction.put<StoredProjectOwnership>('meta', {
        key,
        projectId,
        ownerId,
        epoch,
      });
      return epoch;
    });
  };

  const acquire = (waitForLock: boolean): Promise<ProjectOwnershipState> => {
    if (state.role === 'writer') {
      return Promise.resolve(state);
    }
    if (acquisition) {
      return acquisition;
    }
    const started = deferred();
    acquisition = started.promise.then(() => state);
    lockRequest = (async () => {
      if (released) {
        setState({ ...state, role: 'released' });
        started.resolve();
        return;
      }

      const acquireLock = async (lock: LockHandle | null): Promise<void> => {
        if (!lock) {
          setState({ ...state, role: 'readonly' });
          started.resolve();
          return;
        }
        const epoch = await claim(locks ? 'replace-inactive' : 'initial');
        if (epoch === null) {
          setState({ ...state, role: 'readonly' });
          started.resolve();
          return;
        }
        const hold = deferred();
        releaseLock = hold.resolve;
        setState({ ...state, epoch, role: 'writer' });
        channel?.postMessage({
          type: 'writer-acquired',
          projectId,
          ownerId,
          epoch,
        });
        started.resolve();
        await hold.promise;
      };

      if (!locks) {
        await acquireLock({});
        return;
      }
      await locks.request(
        `${LOCK_PREFIX}${projectId}`,
        { mode: 'exclusive', ...(waitForLock ? {} : { ifAvailable: true }) },
        acquireLock,
      );
    })();
    return acquisition;
  };

  return {
    start: () => acquire(false),
    takeover: async () => {
      if (state.role === 'writer') {
        return state;
      }
      releaseLock?.();
      releaseLock = null;
      const epoch = await claim('takeover');
      if (epoch === null) {
        throw new Error('Project ownership takeover did not produce an epoch.');
      }
      setState({ ...state, epoch, role: 'readonly' });
      channel?.postMessage({
        type: 'takeover-requested',
        projectId,
        ownerId,
        epoch,
      });
      acquisition = null;
      return acquire(true);
    },
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      releaseLock?.();
      releaseLock = null;
      if (state.role === 'writer') {
        channel?.postMessage({
          type: 'writer-released',
          projectId,
          ownerId,
          epoch: state.epoch,
        });
      }
      setState({ ...state, role: 'released' });
      channel?.removeEventListener('message', onMessage);
      channel?.close();
      await lockRequest?.catch(() => undefined);
    },
    getState: () => state,
    canWrite: (epoch = state.epoch) => (
      state.role === 'writer' && epoch === state.epoch && !released
    ),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type { LockManagerLike, ChannelLike };
