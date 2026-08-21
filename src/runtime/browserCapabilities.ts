export type BrowserKind = 'chrome' | 'edge' | 'firefox' | 'safari' | 'unknown';

export type BrowserCapabilityIssue =
  | 'browser-not-recommended'
  | 'indexeddb-unavailable'
  | 'storage-estimate-unavailable'
  | 'service-worker-unavailable';

export interface BrowserCapabilities {
  browser: BrowserKind;
  isRecommendedBrowser: boolean;
  hasIndexedDb: boolean;
  hasStorageEstimate: boolean;
  hasServiceWorker: boolean;
  issues: BrowserCapabilityIssue[];
}

export interface BrowserCapabilityEnvironment {
  userAgent?: string;
  indexedDb?: unknown;
  storage?: { estimate?: unknown } | null;
  serviceWorker?: unknown;
}

function detectBrowser(userAgent: string): BrowserKind {
  if (/Edg\//i.test(userAgent)) {
    return 'edge';
  }
  if (/Firefox\//i.test(userAgent) || /FxiOS\//i.test(userAgent)) {
    return 'firefox';
  }
  if (/Chrome\//i.test(userAgent) || /CriOS\//i.test(userAgent)) {
    return 'chrome';
  }
  if (/Safari\//i.test(userAgent)) {
    return 'safari';
  }
  return 'unknown';
}

export function readBrowserCapabilities(
  environment: BrowserCapabilityEnvironment = {
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    indexedDb: typeof indexedDB === 'undefined' ? undefined : indexedDB,
    storage: typeof navigator === 'undefined' ? undefined : navigator.storage,
    serviceWorker: typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
  },
): BrowserCapabilities {
  const browser = detectBrowser(environment.userAgent ?? '');
  const isRecommendedBrowser = browser === 'chrome' || browser === 'edge';
  const hasIndexedDb = environment.indexedDb !== undefined;
  const hasStorageEstimate = typeof environment.storage?.estimate === 'function';
  const hasServiceWorker = environment.serviceWorker !== undefined;
  const issues: BrowserCapabilityIssue[] = [];

  if (!isRecommendedBrowser) {
    issues.push('browser-not-recommended');
  }
  if (!hasIndexedDb) {
    issues.push('indexeddb-unavailable');
  }
  if (!hasStorageEstimate) {
    issues.push('storage-estimate-unavailable');
  }
  if (!hasServiceWorker) {
    issues.push('service-worker-unavailable');
  }

  return {
    browser,
    isRecommendedBrowser,
    hasIndexedDb,
    hasStorageEstimate,
    hasServiceWorker,
    issues,
  };
}
