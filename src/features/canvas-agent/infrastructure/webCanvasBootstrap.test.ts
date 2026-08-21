import { describe, expect, it, vi } from 'vitest';

import { consumeWebCanvasBootstrap } from './webCanvasBootstrap';

describe('consumeWebCanvasBootstrap', () => {
  it('accepts a session-bound Web bootstrap only from the canonical fragment and clears it immediately', () => {
    const bootstrap = {
      bridge: 'web' as const,
      endpoint: 'http://127.0.0.1:17372',
      canonicalOrigin: 'http://127.0.0.1:49123',
      sessionId: 'session-1',
      token: 'short-lived-web-token',
      expiresAt: 12_345,
    };
    const history = { replaceState: vi.fn() };

    expect(consumeWebCanvasBootstrap({
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`,
      origin: bootstrap.canonicalOrigin,
      pathname: '/canvas',
      search: '?project=1',
    }, history)).toEqual(bootstrap);
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/canvas?project=1');
  });

  it('leaves a legacy read-only fragment for the read-only bridge to consume', () => {
    const history = { replaceState: vi.fn() };
    const readonlyBootstrap = {
      endpoint: 'http://127.0.0.1:17372',
      canonicalOrigin: 'http://127.0.0.1:49123',
      sessionId: 'session-1',
      token: 'short-lived-readonly-token',
      expiresAt: 12_345,
    };

    expect(consumeWebCanvasBootstrap({
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(readonlyBootstrap))}`,
      origin: readonlyBootstrap.canonicalOrigin,
      pathname: '/',
      search: '',
    }, history)).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it('clears a Web bootstrap copied to a different Origin', () => {
    const history = { replaceState: vi.fn() };
    const bootstrap = {
      bridge: 'web' as const,
      endpoint: 'http://127.0.0.1:17372',
      canonicalOrigin: 'http://127.0.0.1:49123',
      sessionId: 'session-1',
      token: 'short-lived-web-token',
      expiresAt: 12_345,
    };

    expect(consumeWebCanvasBootstrap({
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`,
      origin: 'http://127.0.0.1:49777',
      pathname: '/',
      search: '',
    }, history)).toBeNull();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });
});
