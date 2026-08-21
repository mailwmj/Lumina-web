import { describe, expect, it } from 'vitest';

import { readBrowserCapabilities } from './browserCapabilities';

describe('browser capability diagnostics', () => {
  it('keeps Firefox usable while warning that it is outside the recommended browser set', () => {
    expect(readBrowserCapabilities({
      userAgent: 'Mozilla/5.0 Firefox/128.0',
      indexedDb: {},
      storage: { estimate: async () => ({}) },
      serviceWorker: {},
    })).toEqual({
      browser: 'firefox',
      isRecommendedBrowser: false,
      hasIndexedDb: true,
      hasStorageEstimate: true,
      hasServiceWorker: true,
      issues: ['browser-not-recommended'],
    });
  });

  it('reports missing local persistence and offline capabilities without treating them as a destructive error', () => {
    expect(readBrowserCapabilities({
      userAgent: 'Mozilla/5.0 Chrome/136.0.0.0 Safari/537.36',
      indexedDb: undefined,
      storage: undefined,
      serviceWorker: undefined,
    })).toEqual({
      browser: 'chrome',
      isRecommendedBrowser: true,
      hasIndexedDb: false,
      hasStorageEstimate: false,
      hasServiceWorker: false,
      issues: [
        'indexeddb-unavailable',
        'storage-estimate-unavailable',
        'service-worker-unavailable',
      ],
    });
  });
});
