import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectWebCanvasBridge,
  postWebCanvasActionResult,
} from './webCanvasBridge';

const bootstrap = {
  bridge: 'web' as const,
  endpoint: 'http://127.0.0.1:17372',
  canonicalOrigin: 'http://127.0.0.1:49123',
  sessionId: 'session-1',
  token: 'short-lived-web-token',
  expiresAt: Date.now() + 60_000,
};

describe('Web canvas bridge transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects through the session-bound loopback endpoint without placing its token in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await connectWebCanvasBridge(bootstrap);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17372/v1/connect',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer short-lived-web-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(request.body)).toContain('"sessionId":"session-1"');
    expect(String(request.body)).toContain('"build":"lumina-canvas-web-v2"');
  });

  it('does not retry an action result after a transport failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('disconnected'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postWebCanvasActionResult(bootstrap, {
      actionId: 'action-1',
      status: 'stale',
      error: 'canvas_disconnected',
    })).rejects.toThrow('disconnected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
