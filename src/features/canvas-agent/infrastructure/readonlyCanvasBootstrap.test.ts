import { describe, expect, it, vi } from 'vitest';

import { consumeReadonlyCanvasBootstrap } from './readonlyCanvasBootstrap';

describe('consumeReadonlyCanvasBootstrap', () => {
  it('reads bootstrap only from the fragment and immediately clears it without persistence', () => {
    const bootstrap = {
      endpoint: 'http://127.0.0.1:17372',
      sessionId: 'session-1',
      token: 'short-lived-token',
      expiresAt: 12_345,
    };
    const history = { replaceState: vi.fn() };
    const location = {
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`,
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
      pathname: '/canvas',
      search: '?token=not-accepted',
    }, history)).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});
