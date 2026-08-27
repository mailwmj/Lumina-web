import { describe, expect, it, vi } from 'vitest';

import {
  RuntimeProjectClient,
  RuntimeProjectClientError,
} from './runtimeProjectClient';

const SESSION_TOKEN = 'session-token-00000000000000000000';
const LEASE_TOKEN = 'lease-token-000000000000000000000';
const PROJECT_ID = 'project-1';

function jsonResponse(value: unknown, status = 200): Response {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { token?: unknown }).token === 'string'
    && !('runtimeApiVersion' in value)
    ? { ...value, runtimeApiVersion: 2 }
    : value;
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createClient(fetchRequest: typeof fetch): RuntimeProjectClient {
  return new RuntimeProjectClient({
    fetch: fetchRequest,
    now: () => 1_000,
    setTimeout: (() => 1) as typeof globalThis.setTimeout,
    clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
  });
}

describe('RuntimeProjectClient', () => {
  it('rejects a Runtime session whose API contract is incompatible', async () => {
    const fetchRequest = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input) === '/api/runtime/session') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000, runtimeApiVersion: 1 }, 201);
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);

    await expect(client.initialize()).rejects.toMatchObject({
      code: 'runtime_api_incompatible',
      status: 426,
    });
    expect(client.getEditorState()).toEqual({ mode: 'unavailable' });
  });

  it('holds a per-client Bearer session and attaches the Chrome lease to mutations', async () => {
    const requests: Array<{ path: string; options?: RequestInit }> = [];
    const fetchRequest = vi.fn(async (input: URL | RequestInfo, options?: RequestInit) => {
      const path = String(input);
      requests.push({ path, options });
      if (path === '/api/runtime/session' && options?.method === 'POST') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        return jsonResponse({ mode: 'chrome', projectId: PROJECT_ID, token: LEASE_TOKEN, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/project') {
        return jsonResponse({ project: JSON.parse(String(options?.body)) });
      }
      if (path === '/api/runtime/session' && options?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);

    await expect(client.initialize()).resolves.toEqual({ mode: 'available' });
    await client.saveProject({ id: PROJECT_ID });
    await client.close();

    expect(requests).toHaveLength(4);
    expect(requests[0].options?.headers).not.toHaveProperty('Authorization');
    expect(requests[1].options?.headers).toMatchObject({
      Authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(requests[1].options?.body).toBe(JSON.stringify({ projectId: PROJECT_ID, force: false }));
    expect(requests[2].options?.headers).toMatchObject({
      Authorization: `Bearer ${SESSION_TOKEN}`,
      'X-Lumina-Editor-Lease': LEASE_TOKEN,
    });
    expect(requests[3].options).toMatchObject({ keepalive: true });
  });

  it('attaches the Runtime API version to binary asset mutations', async () => {
    let assetOptions: RequestInit | undefined;
    const fetchRequest = vi.fn(async (input: URL | RequestInfo, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/runtime/session' && options?.method === 'POST') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        return jsonResponse({ mode: 'chrome', projectId: PROJECT_ID, token: LEASE_TOKEN, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/asset' && options?.method === 'PUT') {
        assetOptions = options;
        return jsonResponse({ metadata: { id: 'asset-1' } }, 201);
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);

    await client.initialize();
    await expect(client.writeAsset(
      { id: 'asset-1', projectId: PROJECT_ID, mimeType: 'image/png' },
      new Blob(['png'], { type: 'image/png' }),
    )).resolves.toEqual({ id: 'asset-1' });

    expect(assetOptions?.headers).toMatchObject({
      'X-Lumina-Runtime-Api-Version': '2',
    });
  });

  it('attaches the Runtime API version to binary asset reads', async () => {
    let assetOptions: RequestInit | undefined;
    const fetchRequest = vi.fn(async (input: URL | RequestInfo, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/runtime/session' && options?.method === 'POST') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/asset?assetId=asset-1') {
        assetOptions = options;
        return new Response('png', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);

    await client.initialize();
    await expect(client.readAsset('asset-1')).resolves.toBeInstanceOf(Blob);

    expect(assetOptions?.headers).toMatchObject({
      'X-Lumina-Runtime-Api-Version': '2',
    });
  });

  it('does not replay a mutation after an ambiguous transport failure', async () => {
    let mutationCount = 0;
    const fetchRequest = vi.fn(async (input: URL | RequestInfo) => {
      const path = String(input);
      if (path === '/api/runtime/session') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        return jsonResponse({ mode: 'chrome', projectId: PROJECT_ID, token: LEASE_TOKEN, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/project') {
        mutationCount += 1;
        throw new TypeError('connection closed');
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);
    await client.initialize();

    await expect(client.saveProject({ id: PROJECT_ID })).rejects.toThrow('connection closed');
    expect(mutationCount).toBe(1);
  });

  it('publishes busy ownership and marks a rejected lease as lost', async () => {
    let acquireCount = 0;
    const fetchRequest = vi.fn(async (input: URL | RequestInfo) => {
      const path = String(input);
      if (path === '/api/runtime/session') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        acquireCount += 1;
        if (acquireCount === 1) {
          return jsonResponse({
            error: 'editor_busy',
            message: 'Another editor owns the Runtime editing lease.',
          }, 409);
        }
        return jsonResponse({ mode: 'chrome', projectId: PROJECT_ID, token: LEASE_TOKEN, expiresAt: 31_000 });
      }
      if (path.startsWith('/api/runtime/editor?')) {
        return jsonResponse({ mode: 'busy', projectId: PROJECT_ID, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/project') {
        return jsonResponse({
          error: 'editor_lease_invalid',
          message: 'The Runtime editing lease is invalid or expired.',
        }, 409);
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);

    await client.initialize();
    await expect(client.acquireChromeEditor(PROJECT_ID)).rejects.toBeInstanceOf(RuntimeProjectClientError);
    expect(client.getEditorState()).toEqual({ mode: 'busy', projectId: PROJECT_ID, expiresAt: 31_000 });
    await expect(client.saveProject({ id: PROJECT_ID })).rejects.toBeInstanceOf(
      RuntimeProjectClientError,
    );
    expect(client.getEditorState()).toEqual({ mode: 'lost', projectId: PROJECT_ID });
    expect(acquireCount).toBe(2);
  });

  it('sends an explicit force request when taking over a project editor lease', async () => {
    const requests: Array<{ path: string; options?: RequestInit }> = [];
    const fetchRequest = vi.fn(async (input: URL | RequestInfo, options?: RequestInit) => {
      const path = String(input);
      requests.push({ path, options });
      if (path === '/api/runtime/session') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        return jsonResponse({ mode: 'chrome', projectId: PROJECT_ID, token: LEASE_TOKEN, expiresAt: 31_000 });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);

    await client.initialize();
    await expect(client.acquireChromeEditor(PROJECT_ID, { force: true })).resolves.toEqual({
      mode: 'chrome',
      projectId: PROJECT_ID,
      expiresAt: 31_000,
    });

    expect(requests[1].options?.body).toBe(JSON.stringify({ projectId: PROJECT_ID, force: true }));
  });

  it('recreates an expired Runtime session before forcing a project takeover', async () => {
    let sessionCount = 0;
    let acquireCount = 0;
    const fetchRequest = vi.fn(async (input: URL | RequestInfo) => {
      const path = String(input);
      if (path === '/api/runtime/session') {
        sessionCount += 1;
        return jsonResponse({
          token: sessionCount === 1 ? SESSION_TOKEN : 'replacement-session-token-00000000',
          expiresAt: 100_000,
        }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        acquireCount += 1;
        if (acquireCount === 1) {
          return jsonResponse({
            error: 'session_invalid',
            message: 'The Runtime browser session is invalid or expired.',
          }, 401);
        }
        return jsonResponse({
          mode: 'chrome',
          projectId: PROJECT_ID,
          token: LEASE_TOKEN,
          expiresAt: 31_000,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);

    await client.initialize();

    await expect(client.acquireChromeEditor(PROJECT_ID, { force: true })).resolves.toEqual({
      mode: 'chrome',
      projectId: PROJECT_ID,
      expiresAt: 31_000,
    });

    expect(sessionCount).toBe(2);
    expect(acquireCount).toBe(2);
  });

  it('recreates an expired Runtime session before retrying a Chrome project mutation', async () => {
    let sessionCount = 0;
    let acquireCount = 0;
    let mutationCount = 0;
    const fetchRequest = vi.fn(async (input: URL | RequestInfo) => {
      const path = String(input);
      if (path === '/api/runtime/session') {
        sessionCount += 1;
        return jsonResponse({
          token: sessionCount === 1 ? SESSION_TOKEN : 'replacement-session-token-00000000',
          expiresAt: 100_000,
        }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        acquireCount += 1;
        return jsonResponse({
          mode: 'chrome',
          projectId: PROJECT_ID,
          token: acquireCount === 1 ? LEASE_TOKEN : 'replacement-lease-token-000000000',
          expiresAt: 31_000,
        });
      }
      if (path === '/api/runtime/project') {
        mutationCount += 1;
        if (mutationCount === 1) {
          return jsonResponse({
            error: 'session_invalid',
            message: 'The Runtime browser session is invalid or expired.',
          }, 401);
        }
        return jsonResponse({ project: { id: PROJECT_ID } });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);

    await client.initialize();

    await expect(client.saveProject({ id: PROJECT_ID })).resolves.toEqual({ id: PROJECT_ID });

    expect(sessionCount).toBe(2);
    expect(acquireCount).toBe(2);
    expect(mutationCount).toBe(2);
  });

  it('uses a fresh action-bound delegation for each Codex mutation after handoff', async () => {
    const mutationHeaders: HeadersInit[] = [];
    const fetchRequest = vi.fn(async (input: URL | RequestInfo, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/runtime/session') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        return jsonResponse({ mode: 'chrome', projectId: PROJECT_ID, token: LEASE_TOKEN, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/editor/handoff') {
        return jsonResponse({ mode: 'codex', projectId: PROJECT_ID, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/project') {
        mutationHeaders.push(options?.headers ?? {});
        return jsonResponse({ project: JSON.parse(String(options?.body)) });
      }
      if (path === '/api/runtime/asset' && options?.method === 'DELETE') {
        mutationHeaders.push(options.headers ?? {});
        return jsonResponse({ deleted: true });
      }
      if (path === '/api/runtime/asset/metadata?assetId=asset-1') {
        return jsonResponse({ metadata: { projectId: PROJECT_ID } });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);
    const createToken = vi.fn()
      .mockResolvedValueOnce('delegation-token-1')
      .mockResolvedValueOnce('delegation-token-2');

    await client.initialize();
    await expect(client.handoffToCodex(PROJECT_ID, 'codex-session-1')).resolves.toEqual({
      mode: 'codex',
      projectId: PROJECT_ID,
      expiresAt: 31_000,
    });
    await client.withCodexDelegation({ projectId: PROJECT_ID, actionId: 'action-1', createToken }, async () => {
      await client.saveProject({ id: PROJECT_ID });
      await client.deleteAsset('asset-1');
    });

    expect(createToken).toHaveBeenCalledTimes(2);
    expect(mutationHeaders).toEqual([
      expect.objectContaining({
        'X-Lumina-Codex-Delegation': 'delegation-token-1',
        'X-Lumina-Codex-Action': 'action-1',
      }),
      expect.objectContaining({
        'X-Lumina-Codex-Delegation': 'delegation-token-2',
        'X-Lumina-Codex-Action': 'action-1',
      }),
    ]);
    expect(client.getEditorState()).toEqual({ mode: 'codex', projectId: PROJECT_ID, expiresAt: 31_000 });
  });

  it('serializes overlapping Codex mutation scopes without mixing action authorities', async () => {
    const mutationHeaders: HeadersInit[] = [];
    const fetchRequest = vi.fn(async (input: URL | RequestInfo, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/runtime/session') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        return jsonResponse({ mode: 'chrome', projectId: PROJECT_ID, token: LEASE_TOKEN, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/editor/handoff') {
        return jsonResponse({ mode: 'codex', projectId: PROJECT_ID, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/project') {
        mutationHeaders.push(options?.headers ?? {});
        return jsonResponse({ project: JSON.parse(String(options?.body)) });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    await client.initialize();
    await client.handoffToCodex(PROJECT_ID, 'codex-session-1');
    const first = client.withCodexDelegation({
      projectId: PROJECT_ID,
      actionId: 'action-1',
      createToken: async () => 'delegation-token-1',
    }, async () => {
      await firstBlocked;
      await client.saveProject({ id: PROJECT_ID });
    });
    const second = client.withCodexDelegation({
      projectId: PROJECT_ID,
      actionId: 'action-2',
      createToken: async () => 'delegation-token-2',
    }, async () => {
      await client.saveProject({ id: PROJECT_ID });
    });

    await Promise.resolve();
    expect(mutationHeaders).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(mutationHeaders).toEqual([
      expect.objectContaining({
        'X-Lumina-Codex-Delegation': 'delegation-token-1',
        'X-Lumina-Codex-Action': 'action-1',
      }),
      expect.objectContaining({
        'X-Lumina-Codex-Delegation': 'delegation-token-2',
        'X-Lumina-Codex-Action': 'action-2',
      }),
    ]);
  });
});
