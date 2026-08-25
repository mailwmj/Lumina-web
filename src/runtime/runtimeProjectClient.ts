export type RuntimeEditorMode =
  | 'initializing'
  | 'available'
  | 'chrome'
  | 'busy'
  | 'codex'
  | 'lost'
  | 'unavailable';

export interface RuntimeEditorState {
  mode: RuntimeEditorMode;
  expiresAt?: number;
}

interface RuntimeSession {
  token: string;
  expiresAt: number;
}

interface RuntimeChromeLease {
  mode: 'chrome';
  token: string;
  expiresAt: number;
}

interface RuntimeApiErrorPayload {
  error?: unknown;
  message?: unknown;
}

export class RuntimeProjectClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'RuntimeProjectClientError';
    this.code = code;
    this.status = status;
  }
}

interface RuntimeDelegatedAuthority {
  actionId: string;
  token?: string;
  createToken?: () => Promise<string>;
}

export interface RuntimeProjectClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export class RuntimeProjectClient {
  private readonly fetchRequest: typeof fetch;
  private readonly now: () => number;
  private readonly scheduleTimeout: typeof globalThis.setTimeout;
  private readonly cancelTimeout: typeof globalThis.clearTimeout;
  private readonly listeners = new Set<(state: RuntimeEditorState) => void>();
  private session: RuntimeSession | null = null;
  private sessionStart: Promise<RuntimeSession> | null = null;
  private lease: RuntimeChromeLease | null = null;
  private editorState: RuntimeEditorState = { mode: 'initializing' };
  private heartbeat: ReturnType<typeof globalThis.setTimeout> | null = null;
  private delegatedAuthority: RuntimeDelegatedAuthority | null = null;
  private delegatedMutationTail: Promise<void> = Promise.resolve();

  constructor(options: RuntimeProjectClientOptions = {}) {
    this.fetchRequest = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.scheduleTimeout = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  }

  getEditorState(): RuntimeEditorState {
    return { ...this.editorState };
  }

  subscribeEditorState(listener: (state: RuntimeEditorState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getEditorState());
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<RuntimeEditorState> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await this.ensureSession();
        await this.acquireChromeEditor();
        return this.getEditorState();
      } catch (error) {
        if (error instanceof RuntimeProjectClientError && error.code === 'editor_busy') {
          return this.getEditorState();
        }
        if (
          error instanceof RuntimeProjectClientError
          && error.code === 'runtime_unavailable'
          && error.status === 503
          && attempt < 49
        ) {
          await new Promise<void>((resolve) => this.scheduleTimeout(resolve, 100));
          continue;
        }
        this.publish({ mode: 'unavailable' });
        throw error;
      }
    }
    return this.getEditorState();
  }

  async acquireChromeEditor(): Promise<RuntimeEditorState> {
    const session = await this.ensureSession();
    try {
      const lease = await this.json<RuntimeChromeLease>('/api/runtime/editor/acquire', {
        method: 'POST',
        session,
        body: {},
      });
      this.lease = lease;
      this.publish({ mode: 'chrome', expiresAt: lease.expiresAt });
      this.scheduleHeartbeat();
      return this.getEditorState();
    } catch (error) {
      this.lease = null;
      this.stopHeartbeat();
      if (error instanceof RuntimeProjectClientError && error.code === 'editor_busy') {
        await this.refreshEditorState().catch(() => this.publish({ mode: 'busy' }));
      }
      throw error;
    }
  }

  async refreshEditorState(): Promise<RuntimeEditorState> {
    const session = await this.ensureSession();
    const state = await this.json<{ mode: 'available' | 'chrome' | 'busy' | 'codex'; expiresAt?: number }>(
      '/api/runtime/editor',
      { method: 'GET', session },
    );
    if (state.mode !== 'chrome') {
      this.lease = null;
      this.stopHeartbeat();
    }
    this.publish(state);
    return this.getEditorState();
  }

  async handoffToCodex(codexSessionId: string): Promise<RuntimeEditorState> {
    const session = await this.ensureSession();
    const lease = await this.requireChromeLease();
    const state = await this.json<{ mode: 'codex'; expiresAt: number }>(
      '/api/runtime/editor/handoff',
      {
        method: 'POST',
        session,
        body: { leaseToken: lease.token, codexSessionId },
      },
    );
    this.lease = null;
    this.stopHeartbeat();
    this.publish(state);
    return this.getEditorState();
  }

  async abortCodexHandoff(codexSessionId: string): Promise<void> {
    const session = await this.ensureSession();
    await this.json<void>('/api/runtime/editor/handoff-abort', {
      method: 'POST',
      session,
      body: { codexSessionId },
      emptyResponse: true,
    });
    this.publish({ mode: 'available' });
  }

  async releaseChromeEditor(): Promise<void> {
    const session = this.session;
    const lease = this.lease;
    this.lease = null;
    this.stopHeartbeat();
    if (!session || !lease) {
      this.publish({ mode: 'available' });
      return;
    }
    await this.json<void>('/api/runtime/editor/release', {
      method: 'POST',
      session,
      body: { leaseToken: lease.token },
      emptyResponse: true,
    });
    this.publish({ mode: 'available' });
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    const session = this.session;
    this.session = null;
    this.lease = null;
    if (!session) return;
    const response = await this.fetchRequest('/api/runtime/session', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.token}` },
      keepalive: true,
    });
    if (!response.ok) await this.throwResponseError(response);
  }

  async listProjects<T>(): Promise<T[]> {
    const session = await this.ensureSession();
    return (await this.json<{ projects: T[] }>('/api/runtime/projects', {
      method: 'GET',
      session,
    })).projects;
  }

  async openProject<T>(projectId: string): Promise<T | null> {
    const session = await this.ensureSession();
    return (await this.json<{ project: T | null }>('/api/runtime/project/open', {
      method: 'POST',
      session,
      body: { projectId },
    })).project;
  }

  async saveProject<T>(record: T): Promise<T> {
    const response = await this.mutate<{ project: T }>('/api/runtime/project', 'PUT', record);
    return response.project;
  }

  async updateViewport<T>(projectId: string, viewportJson: string): Promise<T | null> {
    return (await this.mutate<{ project: T | null }>(
      '/api/runtime/project/viewport',
      'PATCH',
      { projectId, viewportJson },
    )).project;
  }

  async renameProject<T>(projectId: string, name: string, updatedAt: number): Promise<T | null> {
    return (await this.mutate<{ project: T | null }>(
      '/api/runtime/project/name',
      'PATCH',
      { projectId, name, updatedAt },
    )).project;
  }

  async deleteProject(projectId: string): Promise<boolean> {
    return (await this.mutate<{ deleted: boolean }>(
      '/api/runtime/project',
      'DELETE',
      { projectId },
    )).deleted;
  }

  async writeAsset<T>(metadata: Record<string, unknown>, blob: Blob): Promise<T> {
    const session = await this.ensureSession();
    const authority = await this.mutationAuthority();
    const response = await this.fetchRequest('/api/runtime/asset', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': blob.type,
        'X-Lumina-Asset-Metadata': encodeBase64Url(JSON.stringify(metadata)),
        ...authority,
      },
      body: blob,
    });
    return (await this.readJsonResponse<{ metadata: T }>(response)).metadata;
  }

  async readAsset(assetId: string): Promise<Blob | null> {
    const session = await this.ensureSession();
    const response = await this.fetchRequest(
      `/api/runtime/asset?assetId=${encodeURIComponent(assetId)}`,
      { headers: { Authorization: `Bearer ${session.token}` } },
    );
    if (response.status === 404) return null;
    if (!response.ok) await this.throwResponseError(response);
    return await response.blob();
  }

  async getAssetMetadata<T>(assetId: string): Promise<T | null> {
    const session = await this.ensureSession();
    return (await this.json<{ metadata: T | null }>(
      `/api/runtime/asset/metadata?assetId=${encodeURIComponent(assetId)}`,
      { method: 'GET', session },
    )).metadata;
  }

  async deleteAsset(assetId: string): Promise<boolean> {
    return (await this.mutate<{ deleted: boolean }>(
      '/api/runtime/asset',
      'DELETE',
      { assetId },
    )).deleted;
  }

  async withCodexDelegation<T>(
    delegation: RuntimeDelegatedAuthority,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.delegatedMutationTail;
    let release!: () => void;
    this.delegatedMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.delegatedAuthority = delegation;
    try {
      return await operation();
    } finally {
      this.delegatedAuthority = null;
      release();
    }
  }

  private async mutate<T>(
    path: string,
    method: 'PUT' | 'PATCH' | 'DELETE',
    body: unknown,
  ): Promise<T> {
    const session = await this.ensureSession();
    const authority = await this.mutationAuthority();
    return this.json<T>(path, { method, session, body, headers: authority });
  }

  private async mutationAuthority(): Promise<Record<string, string>> {
    if (this.delegatedAuthority) {
      const token = this.delegatedAuthority.createToken
        ? await this.delegatedAuthority.createToken()
        : this.delegatedAuthority.token;
      if (!token) {
        throw new RuntimeProjectClientError(
          'editor_lease_invalid',
          'The Codex mutation delegation is unavailable.',
          409,
        );
      }
      return {
        'X-Lumina-Codex-Delegation': token,
        'X-Lumina-Codex-Action': this.delegatedAuthority.actionId,
      };
    }
    const lease = await this.requireChromeLease();
    return { 'X-Lumina-Editor-Lease': lease.token };
  }

  private async requireChromeLease(): Promise<RuntimeChromeLease> {
    const lease = this.lease;
    if (!lease || this.now() >= lease.expiresAt) {
      return await this.acquireLeaseValue();
    }
    if (lease.expiresAt - this.now() <= 10_000) {
      return await this.renewLease();
    }
    return lease;
  }

  private async acquireLeaseValue(): Promise<RuntimeChromeLease> {
    await this.acquireChromeEditor();
    if (!this.lease) {
      throw new RuntimeProjectClientError(
        'editor_lease_invalid',
        'The Runtime editing lease is unavailable.',
        409,
      );
    }
    return this.lease;
  }

  private async renewLease(): Promise<RuntimeChromeLease> {
    const session = await this.ensureSession();
    const lease = this.lease;
    if (!lease) return this.acquireLeaseValue();
    try {
      const renewed = await this.json<RuntimeChromeLease>('/api/runtime/editor/renew', {
        method: 'POST',
        session,
        body: { leaseToken: lease.token },
      });
      this.lease = renewed;
      this.publish({ mode: 'chrome', expiresAt: renewed.expiresAt });
      this.scheduleHeartbeat();
      return renewed;
    } catch (error) {
      this.lease = null;
      this.stopHeartbeat();
      this.publish({ mode: 'lost' });
      throw error;
    }
  }

  private async ensureSession(): Promise<RuntimeSession> {
    if (this.session && this.now() < this.session.expiresAt) return this.session;
    if (this.sessionStart) return this.sessionStart;
    this.sessionStart = this.createSessionWithRetry().then((session) => {
      this.session = session;
      return session;
    }).finally(() => {
      this.sessionStart = null;
    });
    return this.sessionStart;
  }

  private async createSessionWithRetry(): Promise<RuntimeSession> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        return await this.json<RuntimeSession>('/api/runtime/session', {
          method: 'POST',
          body: {},
        });
      } catch (error) {
        if (!(error instanceof RuntimeProjectClientError)
          || error.code !== 'runtime_unavailable'
          || error.status !== 503
          || attempt >= 49) {
          throw error;
        }
        await new Promise<void>((resolve) => this.scheduleTimeout(resolve, 100));
      }
    }
    throw new RuntimeProjectClientError(
      'runtime_unavailable',
      'The Runtime project service is unavailable.',
      503,
    );
  }

  private scheduleHeartbeat(): void {
    this.stopHeartbeat();
    const lease = this.lease;
    if (!lease) return;
    const delay = Math.max(1_000, Math.floor((lease.expiresAt - this.now()) / 2));
    this.heartbeat = this.scheduleTimeout(() => {
      this.heartbeat = null;
      void this.renewLease().catch(() => undefined);
    }, delay);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      this.cancelTimeout(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private publish(state: RuntimeEditorState): void {
    this.editorState = { ...state };
    for (const listener of this.listeners) listener(this.getEditorState());
  }

  private async json<T>(
    path: string,
    options: {
      method: string;
      session?: RuntimeSession;
      body?: unknown;
      headers?: Record<string, string>;
      emptyResponse?: boolean;
    },
  ): Promise<T> {
    const response = await this.fetchRequest(path, {
      method: options.method,
      headers: {
        ...(options.session ? { Authorization: `Bearer ${options.session.token}` } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (options.emptyResponse && response.ok) return undefined as T;
    return this.readJsonResponse<T>(response);
  }

  private async readJsonResponse<T>(response: Response): Promise<T> {
    if (!response.ok) await this.throwResponseError(response);
    return await response.json() as T;
  }

  private async throwResponseError(response: Response): Promise<never> {
    let payload: RuntimeApiErrorPayload = {};
    try {
      payload = await response.json() as RuntimeApiErrorPayload;
    } catch {
      // The Runtime may be unavailable before it can produce a JSON error.
    }
    const code = typeof payload.error === 'string' ? payload.error : 'runtime_unavailable';
    const message = typeof payload.message === 'string'
      ? payload.message
      : 'The Runtime project request failed.';
    if (code === 'session_invalid') {
      this.session = null;
      this.lease = null;
      this.stopHeartbeat();
      this.publish({ mode: 'lost' });
    } else if (code === 'editor_lease_invalid') {
      this.lease = null;
      this.stopHeartbeat();
      this.publish({ mode: 'lost' });
    }
    throw new RuntimeProjectClientError(code, message, response.status);
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

export const runtimeProjectClient = new RuntimeProjectClient();
