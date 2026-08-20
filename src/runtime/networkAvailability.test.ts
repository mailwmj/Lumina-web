import { describe, expect, it } from 'vitest';

import { NetworkUnavailableError, assertNetworkAvailable } from './networkAvailability';

describe('network availability boundary', () => {
  it('fails provider work explicitly while the browser reports an offline state', () => {
    expect(() => assertNetworkAvailable(false)).toThrow(NetworkUnavailableError);
    expect(() => assertNetworkAvailable(false)).toThrow('Network access is unavailable while offline.');
  });

  it('allows provider work when the browser is online or cannot report a network state', () => {
    expect(() => assertNetworkAvailable(true)).not.toThrow();
    expect(() => assertNetworkAvailable(undefined)).not.toThrow();
  });
});
