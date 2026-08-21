import { describe, expect, it, vi } from 'vitest';

import {
  captureReadonlyCanvasBootstrap,
  clearCapturedReadonlyCanvasBootstrap,
  consumeReadonlyCanvasBootstrap,
  getCapturedReadonlyCanvasBootstrap,
} from './readonlyCanvasBootstrap';

describe('consumeReadonlyCanvasBootstrap', () => {
  it('reads bootstrap only from the fragment and immediately clears it without persistence', () => {
    const bootstrap = {
      endpoint: 'http://127.0.0.1:17372',
      canonicalOrigin: 'http://127.0.0.1:49123',
      sessionId: 'session-1',
      token: 'short-lived-token',
      expiresAt: 12_345,
    };
    const history = { replaceState: vi.fn() };
    const location = {
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`,
      origin: 'http://127.0.0.1:49123',
      pathname: '/canvas',
      search: '?project=1',
    };

    expect(consumeReadonlyCanvasBootstrap(location, history)).toEqual(bootstrap);
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/canvas?project=1');
  });

  it('does not accept bootstrap values outside the fragment', () => {
    const history = { replaceState: vi.fn() };
    expect(consumeReadonlyCanvasBootstrap({
      hash: '',
      origin: 'http://127.0.0.1:49123',
      pathname: '/canvas',
      search: '?token=not-accepted',
    }, history)).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it('leaves a session-bound Web fragment for the Web bridge to consume', () => {
    const history = { replaceState: vi.fn() };
    const bootstrap = {
      bridge: 'web',
      endpoint: 'http://127.0.0.1:17372',
      canonicalOrigin: 'http://127.0.0.1:49123',
      sessionId: 'session-1',
      token: 'short-lived-web-token',
      expiresAt: 12_345,
    };

    expect(consumeReadonlyCanvasBootstrap({
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`,
      origin: bootstrap.canonicalOrigin,
      pathname: '/',
      search: '',
    }, history)).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it('rejects a bootstrap copied to another Origin after clearing the fragment', () => {
    const history = { replaceState: vi.fn() };
    const bootstrap = {
      endpoint: 'http://127.0.0.1:17372',
      canonicalOrigin: 'http://127.0.0.1:49123',
      sessionId: 'session-1',
      token: 'short-lived-token',
      expiresAt: 12_345,
    };

    expect(consumeReadonlyCanvasBootstrap({
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`,
      origin: 'http://127.0.0.1:49777',
      pathname: '/canvas',
      search: '',
    }, history)).toBeNull();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/canvas');
  });

  it('rejects a bootstrap endpoint without an explicit loopback port', () => {
    const history = { replaceState: vi.fn() };
    const bootstrap = {
      endpoint: 'http://127.0.0.1',
      canonicalOrigin: 'http://127.0.0.1:49123',
      sessionId: 'session-1',
      token: 'short-lived-token',
      expiresAt: 12_345,
    };

    expect(consumeReadonlyCanvasBootstrap({
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`,
      origin: bootstrap.canonicalOrigin,
      pathname: '/',
      search: '',
    }, history)).toBeNull();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('keeps a valid bootstrap only in module memory after the entry point clears its fragment', () => {
    const history = { replaceState: vi.fn() };
    const bootstrap = {
      endpoint: 'http://127.0.0.1:17372',
      canonicalOrigin: 'http://127.0.0.1:49123',
      sessionId: 'session-1',
      token: 'short-lived-token',
      expiresAt: 12_345,
    };
    const captured = captureReadonlyCanvasBootstrap({
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`,
      origin: bootstrap.canonicalOrigin,
      pathname: '/',
      search: '',
    }, history);

    expect(captured).toEqual(bootstrap);
    expect(getCapturedReadonlyCanvasBootstrap()).toEqual(bootstrap);
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
    clearCapturedReadonlyCanvasBootstrap(captured!);
    expect(getCapturedReadonlyCanvasBootstrap()).toBeNull();
  });
});
