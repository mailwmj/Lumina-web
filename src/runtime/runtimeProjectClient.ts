export type RuntimeEditorMode =
  | 'initializing'
  | 'available'
  | 'chrome'
  | 'busy'
  | 'codex'
  | 'lost'
  | 'unavailable';

export const RUNTIME_PROJECT_API_VERSION = 2;
export const RUNTIME_PROJECT_API_VERSION_HEADER = 'X-Lumina-Runtime-Api-Version';

export interface RuntimeEditorState {
  mode: RuntimeEditorMode;
  projectId?: string;
  expiresAt?: number;
}

interface RuntimeSession {
  token: string;
  expiresAt: number;
  runtimeApiVersion: number;
}

interface RuntimeChromeLease {
  mode: 'chrome';
  projectId: string;
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
  projectId: string;
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
  private leaseStart: { projectId: string; force: boolean; promise: Promise<RuntimeEditorState> } | null = null;
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
        this.publish({ mode: 'available' });
        return this.getEditorState();
      } catch (error) {
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

  async acquireChromeEditor(
    projectId: string,
    options: { force?: boolean } = {},
  ): Promise<RuntimeEditorState> {
    const force = options.force === true;
    if (this.leaseStart?.projectId === projectId && (!force || this.leaseStart.force)) {
      return this.leaseStart.promise;
    }
    const previousLease = this.lease;
    if (previousLease && previousLease.projectId !== projectId) {
      await this.releaseChromeEditor();
    }
    const request = this.acquireChromeEditorValue(projectId, force);
    this.leaseStart = { projectId, force, promise: request };
    try {
      return await request;
    } finally {
      if (this.leaseStart?.promise === request) this.leaseStart = null;
    }
  }

  private async acquireChromeEditorValue(
    projectId: string,
    force: boolean,
    retryAfterSessionInvalid = true,
  ): Promise<RuntimeEditorState> {
    const session = await this.ensureSession();
    try {
      const lease = await this.json<RuntimeChromeLease>('/api/runtime/editor/acquire', {
        method: 'POST',
        session,
        body: { projectId, force },
      });
      this.lease = lease;
      this.publish({ mode: 'chrome', projectId: lease.projectId, expiresAt: lease.expiresAt });
      this.scheduleHeartbeat();
      return this.getEditorState();
    } catch (error) {
      if (this.lease?.projectId === projectId) {
        this.lease = null;
        this.stopHeartbeat();
      }
      if (
        retryAfterSessionInvalid
        && error instanceof RuntimeProjectClientError
        && error.code === 'session_invalid'
      ) {
        return this.acquireChromeEditorValue(projectId, force, false);
      }
      if (error instanceof RuntimeProjectClientError && error.code === 'editor_busy') {
        await this.refreshEditorState(projectId).catch(() => this.publish({ mode: 'busy', projectId }));
      }
      throw error;
    }
  }

  async refreshEditorState(projectId: string): Promise<RuntimeEditorState> {
    const session = await this.ensureSession();
    const state = await this.json<RuntimeEditorState>(
      `/api/runtime/editor?projectId=${encodeURIComponent(projectId)}`,
      { method: 'GET', session },
    );
    if (state.mode !== 'chrome' && this.lease?.projectId === projectId) {
      this.lease = null;
      this.stopHeartbeat();
    }
    this.publish(state);
    return this.getEditorState();
  }

  async handoffToCodex(projectId: string, codexSessionId: string): Promise<RuntimeEditorState> {
    const session = await this.ensureSession();
    const lease = await this.requireChromeLease(projectId);
    const state = await this.json<RuntimeEditorState>(
      '/api/runtime/editor/handoff',
      {
        method: 'POST',
        session,
        body: { projectId, leaseToken: lease.token, codexSessionId },
      },
    );
    this.lease = null;
    this.stopHeartbeat();
    this.publish(state);
    return this.getEditorState();
  }

  async abortCodexHandoff(projectId: string, codexSessionId: string): Promise<void> {
    const session = await this.ensureSession();
    await this.json<void>('/api/runtime/editor/handoff-abort', {
      method: 'POST',
      session,
      body: { projectId, codexSessionId },
      emptyResponse: true,
    });
    this.publish({ mode: 'available', projectId });
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
      body: { projectId: lease.projectId, leaseToken: lease.token },
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
      headers: {
        Authorization: `Bearer ${session.token}`,
        [RUNTIME_PROJECT_API_VERSION_HEADER]: String(RUNTIME_PROJECT_API_VERSION),
      },
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
    const response = await this.mutate<{ project: T }>(
      '/api/runtime/project',
      'PUT',
      record,
      projectIdFromRecord(record),
    );
    return response.project;
  }

  async updateViewport<T>(projectId: string, viewportJson: string): Promise<T | null> {
    return (await this.mutate<{ project: T | null }>(
      '/api/runtime/project/viewport',
      'PATCH',
      { projectId, viewportJson },
      projectId,
    )).project;
  }

  async renameProject<T>(projectId: string, name: string, updatedAt: number): Promise<T | null> {
    return (await this.mutate<{ project: T | null }>(
      '/api/runtime/project/name',
      'PATCH',
      { projectId, name, updatedAt },
      projectId,
    )).project;
  }

  async deleteProject(projectId: string): Promise<boolean> {
    return (await this.mutate<{ deleted: boolean }>(
      '/api/runtime/project',
      'DELETE',
      { projectId },
      projectId,
    )).deleted;
  }

  async writeAsset<T>(metadata: Record<string, unknown>, blob: Blob): Promise<T> {
    const session = await this.ensureSession();
    const authority = await this.mutationAuthority(projectIdFromAssetMetadata(metadata));
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
    const metadata = await this.getAssetMetadata<{ projectId?: unknown }>(assetId);
    const projectId = metadata && typeof metadata.projectId === 'string'
      ? metadata.projectId
      : null;
    if (!projectId) return false;
    return (await this.mutate<{ deleted: boolean }>(
      '/api/runtime/asset',
      'DELETE',
      { projectId, assetId },
      projectId,
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
    projectId: string,
    retryAfterSessionInvalid = true,
  ): Promise<T> {
    const session = await this.ensureSession();
    const authority = await this.mutationAuthority(projectId);
    try {
      return await this.json<T>(path, { method, session, body, headers: authority });
    } catch (error) {
      if (
        retryAfterSessionInvalid
        && !this.delegatedAuthority
        && error instanceof RuntimeProjectClientError
        && error.code === 'session_invalid'
      ) {
        return this.mutate(path, method, body, projectId, false);
      }
      throw error;
    }
  }

  private async mutationAuthority(projectId: string): Promise<Record<string, string>> {
    if (this.delegatedAuthority) {
      if (this.delegatedAuthority.projectId !== projectId) {
        throw new RuntimeProjectClientError(
          'editor_lease_invalid',
          'The Codex mutation delegation is not authorized for this project.',
          409,
        );
      }
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
    const lease = await this.requireChromeLease(projectId);
    return { 'X-Lumina-Editor-Lease': lease.token };
  }

  private async requireChromeLease(projectId: string): Promise<RuntimeChromeLease> {
    const lease = this.lease;
    if (!lease || lease.projectId !== projectId || this.now() >= lease.expiresAt) {
      return await this.acquireLeaseValue(projectId);
    }
    if (lease.expiresAt - this.now() <= 10_000) {
      return await this.renewLease(projectId);
    }
    return lease;
  }

  private async acquireLeaseValue(projectId: string): Promise<RuntimeChromeLease> {
    await this.acquireChromeEditor(projectId);
    if (!this.lease || this.lease.projectId !== projectId) {
      throw new RuntimeProjectClientError(
        'editor_lease_invalid',
        'The Runtime editing lease is unavailable.',
        409,
      );
    }
    return this.lease;
  }

  private async renewLease(projectId: string): Promise<RuntimeChromeLease> {
    const session = await this.ensureSession();
    const lease = this.lease;
    if (!lease || lease.projectId !== projectId) return this.acquireLeaseValue(projectId);
    try {
      const renewed = await this.json<RuntimeChromeLease>('/api/runtime/editor/renew', {
        method: 'POST',
        session,
        body: { projectId, leaseToken: lease.token },
      });
      this.lease = renewed;
      this.publish({ mode: 'chrome', projectId: renewed.projectId, expiresAt: renewed.expiresAt });
      this.scheduleHeartbeat();
      return renewed;
    } catch (error) {
      const lostProjectId = lease.projectId;
      this.lease = null;
      this.stopHeartbeat();
      this.publish({ mode: 'lost', projectId: lostProjectId });
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
        const session = await this.json<RuntimeSession>('/api/runtime/session', {
          method: 'POST',
          body: {},
        });
        if (session.runtimeApiVersion !== RUNTIME_PROJECT_API_VERSION) {
          throw new RuntimeProjectClientError(
            'runtime_api_incompatible',
            'This Lumina page is incompatible with the local Runtime. Reload to update.',
            426,
          );
        }
        return session;
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
      void this.renewLease(lease.projectId).catch(() => undefined);
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
        [RUNTIME_PROJECT_API_VERSION_HEADER]: String(RUNTIME_PROJECT_API_VERSION),
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
      const lostProjectId = this.lease?.projectId;
      this.session = null;
      this.lease = null;
      this.stopHeartbeat();
      this.publish({ mode: 'lost', projectId: lostProjectId });
    } else if (code === 'editor_lease_invalid') {
      const lostProjectId = this.lease?.projectId;
      this.lease = null;
      this.stopHeartbeat();
      this.publish({ mode: 'lost', projectId: lostProjectId });
    }
    throw new RuntimeProjectClientError(code, message, response.status);
  }
}

function projectIdFromRecord(value: unknown): string {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
    throw new RuntimeProjectClientError(
      'editor_lease_invalid',
      'The Runtime mutation project is unavailable.',
      409,
    );
  }
  return (value as { id: string }).id;
}

function projectIdFromAssetMetadata(value: Record<string, unknown>): string {
  if (typeof value.projectId !== 'string') {
    throw new RuntimeProjectClientError(
      'editor_lease_invalid',
      'The Runtime mutation project is unavailable.',
      409,
    );
  }
  return value.projectId;
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
