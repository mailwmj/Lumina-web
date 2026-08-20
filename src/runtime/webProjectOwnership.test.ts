import { describe, expect, it, vi } from 'vitest';

import type {
  WebDatabase,
  WebDatabaseStoreName,
  WebDatabaseTransaction,
} from './webDatabase';
import {
  createWebProjectOwnership,
  type ProjectOwnershipMessage,
} from './webProjectOwnership';

type Value = Record<string, unknown>;

class MemoryDatabase implements WebDatabase {
  readonly stores: Record<WebDatabaseStoreName, Map<string, Value>> = {
    projects: new Map(),
    history: new Map(),
    settings: new Map(),
    meta: new Map(),
    assets: new Map(),
  };

  async run<T>(
    _storeNames: readonly WebDatabaseStoreName[],
    _mode: 'readonly' | 'readwrite',
    operation: (transaction: WebDatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction: WebDatabaseTransaction = {
      get: async <TValue>(storeName: WebDatabaseStoreName, key: IDBValidKey) =>
        this.stores[storeName].get(String(key)) as TValue | undefined,
      getAll: async <TValue>(storeName: WebDatabaseStoreName) =>
        [...this.stores[storeName].values()] as TValue[],
      put: async <TValue>(storeName: WebDatabaseStoreName, value: TValue) => {
        const record = value as Value;
        const key = record.key ?? record.id ?? record.projectId;
        this.stores[storeName].set(String(key), record);
      },
      delete: async (storeName: WebDatabaseStoreName, key: IDBValidKey) => {
        this.stores[storeName].delete(String(key));
      },
    };
    return operation(transaction);
  }
}

class FakeChannel {
  static readonly channels = new Map<string, Set<FakeChannel>>();
  readonly listeners = new Set<(event: MessageEvent<ProjectOwnershipMessage>) => void>();

  constructor(readonly name: string) {
    const channels = FakeChannel.channels.get(name) ?? new Set<FakeChannel>();
    channels.add(this);
    FakeChannel.channels.set(name, channels);
  }

  postMessage(message: ProjectOwnershipMessage): void {
    for (const channel of FakeChannel.channels.get(this.name) ?? []) {
      if (channel === this) {
        continue;
      }
      for (const listener of channel.listeners) {
        listener({ data: message } as MessageEvent<ProjectOwnershipMessage>);
      }
    }
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<ProjectOwnershipMessage>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<ProjectOwnershipMessage>) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    FakeChannel.channels.get(this.name)?.delete(this);
  }
}

function createLockManager() {
  let holder = false;
  const waiters: Array<() => void> = [];
  const request = vi.fn(async (
    _name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: object | null) => Promise<void>,
  ) => {
    if (holder && options.ifAvailable) {
      await callback(null);
      return;
    }
    while (holder) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    holder = true;
    try {
      await callback({});
    } finally {
      holder = false;
      waiters.shift()?.();
    }
  });
  return { request };
}

describe('Web project ownership', () => {
  it('makes the second tab read-only and lets explicit takeover revoke the old writer', async () => {
    const database = new MemoryDatabase();
    const locks = createLockManager();
    const first = createWebProjectOwnership({
      projectId: 'project-1',
      ownerId: 'tab-a',
      database,
      locks,
      createChannel: (name) => new FakeChannel(name),
    });
    const second = createWebProjectOwnership({
      projectId: 'project-1',
      ownerId: 'tab-b',
      database,
      locks,
      createChannel: (name) => new FakeChannel(name),
    });

    await first.start();
    await expect(first.start()).resolves.toMatchObject({ role: 'writer' });
    await second.start();
    expect(first.getState().role).toBe('writer');
    expect(second.getState().role).toBe('readonly');

    const oldEpoch = first.getState().epoch;
    await second.takeover();
    expect(first.canWrite()).toBe(false);
    expect(second.getState().epoch).toBe(oldEpoch + 1);
    expect(second.canWrite()).toBe(true);

    await first.release();
    await second.release();
  });

  it('replaces the stored owner after the previous tab releases its Web Lock', async () => {
    const database = new MemoryDatabase();
    const locks = createLockManager();
    const first = createWebProjectOwnership({
      projectId: 'project-1',
      ownerId: 'tab-a',
      database,
      locks,
      createChannel: (name) => new FakeChannel(name),
    });
    await first.start();
    await first.release();

    const reopened = createWebProjectOwnership({
      projectId: 'project-1',
      ownerId: 'tab-b',
      database,
      locks,
      createChannel: (name) => new FakeChannel(name),
    });
    await reopened.start();

    expect(reopened.getState()).toMatchObject({ role: 'writer', epoch: 1 });
    await reopened.release();
  });
});
