import { describe, expect, it, vi } from 'vitest';

import {
  RuntimeProjectClient,
  RuntimeProjectClientError,
} from './runtimeProjectClient';

const SESSION_TOKEN = 'session-token-00000000000000000000';
const LEASE_TOKEN = 'lease-token-000000000000000000000';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
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
  it('holds a per-client Bearer session and attaches the Chrome lease to mutations', async () => {
    const requests: Array<{ path: string; options?: RequestInit }> = [];
    const fetchRequest = vi.fn(async (input: URL | RequestInfo, options?: RequestInit) => {
      const path = String(input);
      requests.push({ path, options });
      if (path === '/api/runtime/session' && options?.method === 'POST') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        return jsonResponse({ mode: 'chrome', token: LEASE_TOKEN, expiresAt: 31_000 });
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

    await expect(client.initialize()).resolves.toEqual({ mode: 'chrome', expiresAt: 31_000 });
    await client.saveProject({ id: 'project-1' });
    await client.close();

    expect(requests).toHaveLength(4);
    expect(requests[0].options?.headers).not.toHaveProperty('Authorization');
    expect(requests[1].options?.headers).toMatchObject({
      Authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(requests[2].options?.headers).toMatchObject({
      Authorization: `Bearer ${SESSION_TOKEN}`,
      'X-Lumina-Editor-Lease': LEASE_TOKEN,
    });
    expect(requests[3].options).toMatchObject({ keepalive: true });
  });

  it('does not replay a mutation after an ambiguous transport failure', async () => {
    let mutationCount = 0;
    const fetchRequest = vi.fn(async (input: URL | RequestInfo) => {
      const path = String(input);
      if (path === '/api/runtime/session') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        return jsonResponse({ mode: 'chrome', token: LEASE_TOKEN, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/project') {
        mutationCount += 1;
        throw new TypeError('connection closed');
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);
    await client.initialize();

    await expect(client.saveProject({ id: 'project-1' })).rejects.toThrow('connection closed');
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
        return jsonResponse({ mode: 'chrome', token: LEASE_TOKEN, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/editor') {
        return jsonResponse({ mode: 'busy', expiresAt: 31_000 });
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

    await expect(client.initialize()).resolves.toEqual({ mode: 'busy', expiresAt: 31_000 });
    await expect(client.saveProject({ id: 'project-1' })).rejects.toBeInstanceOf(
      RuntimeProjectClientError,
    );
    expect(client.getEditorState()).toEqual({ mode: 'lost' });
    expect(acquireCount).toBe(2);
  });

  it('uses a fresh action-bound delegation for each Codex mutation after handoff', async () => {
    const mutationHeaders: HeadersInit[] = [];
    const fetchRequest = vi.fn(async (input: URL | RequestInfo, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/runtime/session') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        return jsonResponse({ mode: 'chrome', token: LEASE_TOKEN, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/editor/handoff') {
        return jsonResponse({ mode: 'codex', expiresAt: 31_000 });
      }
      if (path === '/api/runtime/project') {
        mutationHeaders.push(options?.headers ?? {});
        return jsonResponse({ project: JSON.parse(String(options?.body)) });
      }
      if (path === '/api/runtime/asset' && options?.method === 'DELETE') {
        mutationHeaders.push(options.headers ?? {});
        return jsonResponse({ deleted: true });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const client = createClient(fetchRequest);
    const createToken = vi.fn()
      .mockResolvedValueOnce('delegation-token-1')
      .mockResolvedValueOnce('delegation-token-2');

    await client.initialize();
    await expect(client.handoffToCodex('codex-session-1')).resolves.toEqual({
      mode: 'codex',
      expiresAt: 31_000,
    });
    await client.withCodexDelegation({ actionId: 'action-1', createToken }, async () => {
      await client.saveProject({ id: 'project-1' });
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
    expect(client.getEditorState()).toEqual({ mode: 'codex', expiresAt: 31_000 });
  });

  it('serializes overlapping Codex mutation scopes without mixing action authorities', async () => {
    const mutationHeaders: HeadersInit[] = [];
    const fetchRequest = vi.fn(async (input: URL | RequestInfo, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/runtime/session') {
        return jsonResponse({ token: SESSION_TOKEN, expiresAt: 100_000 }, 201);
      }
      if (path === '/api/runtime/editor/acquire') {
        return jsonResponse({ mode: 'chrome', token: LEASE_TOKEN, expiresAt: 31_000 });
      }
      if (path === '/api/runtime/editor/handoff') {
        return jsonResponse({ mode: 'codex', expiresAt: 31_000 });
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
    await client.handoffToCodex('codex-session-1');
    const first = client.withCodexDelegation({
      actionId: 'action-1',
      createToken: async () => 'delegation-token-1',
    }, async () => {
      await firstBlocked;
      await client.saveProject({ id: 'project-1' });
    });
    const second = client.withCodexDelegation({
      actionId: 'action-2',
      createToken: async () => 'delegation-token-2',
    }, async () => {
      await client.saveProject({ id: 'project-2' });
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
