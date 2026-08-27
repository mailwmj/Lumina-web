import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureCanvasBootstrap } from './canvasBootstrap';
import {
  clearCapturedReadonlyCanvasBootstrap,
  getCapturedReadonlyCanvasBootstrap,
} from './readonlyCanvasBootstrap';
import {
  clearCapturedWebCanvasBootstrap,
  getCapturedWebCanvasBootstrap,
} from './webCanvasBootstrap';

describe('captureCanvasBootstrap', () => {
  afterEach(() => {
    const web = getCapturedWebCanvasBootstrap();
    if (web) clearCapturedWebCanvasBootstrap(web);
    const readonly = getCapturedReadonlyCanvasBootstrap();
    if (readonly) clearCapturedReadonlyCanvasBootstrap(readonly);
  });

  it('captures and clears a Web bridge fragment before React hydration', () => {
    const bootstrap = {
      bridge: 'web' as const,
      endpoint: 'http://127.0.0.1:17372',
      canonicalOrigin: 'http://127.0.0.1:49123',
      sessionId: 'session-web',
      token: 'short-lived-web-token',
      expiresAt: 12_345,
    };
    const history = { replaceState: vi.fn() };

    captureCanvasBootstrap({
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`,
      origin: bootstrap.canonicalOrigin,
      pathname: '/',
      search: '',
    }, history);

    expect(getCapturedWebCanvasBootstrap()).toEqual(bootstrap);
    expect(getCapturedReadonlyCanvasBootstrap()).toBeNull();
    expect(history.replaceState).toHaveBeenCalledOnce();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('leaves a legacy fragment for the readonly bridge consumer', () => {
    const bootstrap = {
      endpoint: 'http://127.0.0.1:17372',
      canonicalOrigin: 'http://127.0.0.1:49123',
      sessionId: 'session-readonly',
      token: 'short-lived-readonly-token',
      expiresAt: 12_345,
    };
    const history = { replaceState: vi.fn() };

    captureCanvasBootstrap({
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`,
      origin: bootstrap.canonicalOrigin,
      pathname: '/canvas',
      search: '?project=1',
    }, history);

    expect(getCapturedWebCanvasBootstrap()).toBeNull();
    expect(getCapturedReadonlyCanvasBootstrap()).toEqual(bootstrap);
    expect(history.replaceState).toHaveBeenCalledOnce();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/canvas?project=1');
  });
});
