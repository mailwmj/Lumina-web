interface AppShellWorker {
  postMessage(message: { type: 'CACHE_APP_SHELL'; urls: string[] }): void;
}

interface AppShellRegistration {
  active?: AppShellWorker | null;
  installing?: AppShellWorker | null;
  waiting?: AppShellWorker | null;
}

export interface AppShellServiceWorkerContainer {
  register(url: string): Promise<AppShellRegistration>;
  ready: Promise<AppShellRegistration>;
}

export interface AppShellUpdateServiceWorkerContainer {
  controller?: unknown | null;
  addEventListener(type: 'controllerchange', listener: EventListener): void;
  removeEventListener(type: 'controllerchange', listener: EventListener): void;
}

interface AppShellResourceInput {
  origin: string;
  pageUrl: string;
  documentUrls: readonly string[];
  performanceUrls: readonly string[];
}

function addSameOriginUrl(urls: Set<string>, value: string, origin: string): void {
  try {
    const resolved = new URL(value, origin);
    if (resolved.origin === origin) {
      urls.add(resolved.toString());
    }
  } catch {
    // Ignore malformed optional performance entries.
  }
}

export function collectAppShellResourceUrls({
  origin,
  pageUrl,
  documentUrls,
  performanceUrls,
}: AppShellResourceInput): string[] {
  const urls = new Set<string>();
  addSameOriginUrl(urls, '/', origin);
  addSameOriginUrl(urls, pageUrl, origin);
  documentUrls.forEach((url) => addSameOriginUrl(urls, url, origin));
  performanceUrls.forEach((url) => addSameOriginUrl(urls, url, origin));
  return [...urls];
}

function currentAppShellResources(): string[] {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return [];
  }
  const documentUrls = Array.from(document.querySelectorAll('script[src], link[href]'))
    .map((element) => element.getAttribute('src') ?? element.getAttribute('href'))
    .filter((value): value is string => Boolean(value));
  const performanceUrls = typeof performance === 'undefined'
    ? []
    : performance.getEntriesByType('resource')
      .filter((entry) => {
        const initiatorType = (entry as { initiatorType?: unknown }).initiatorType;
        return typeof initiatorType === 'string'
          && ['script', 'link', 'css', 'font', 'img'].includes(initiatorType);
      })
      .map((entry) => entry.name);
  return collectAppShellResourceUrls({
    origin: window.location.origin,
    pageUrl: window.location.href,
    documentUrls,
    performanceUrls,
  });
}

function waitForDocumentLoad(): Promise<void> {
  if (typeof document === 'undefined' || document.readyState === 'complete') {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.addEventListener('load', () => resolve(), { once: true }));
}

export async function registerAppShellServiceWorker({
  serviceWorker = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
  version,
  resources,
}: {
  serviceWorker?: AppShellServiceWorkerContainer;
  version: string;
  resources?: readonly string[];
}): Promise<void> {
  if (!serviceWorker || !version.trim()) {
    return;
  }

  const registration = await serviceWorker.register(
    `/service-worker.js?version=${encodeURIComponent(version)}`,
  );
  if (!resources) {
    await waitForDocumentLoad();
  }
  const readyRegistration = registration.active ? registration : await serviceWorker.ready;
  const cacheWorker = registration.installing
    ?? registration.waiting
    ?? readyRegistration.active;
  cacheWorker?.postMessage({
    type: 'CACHE_APP_SHELL',
    urls: resources ? [...resources] : currentAppShellResources(),
  });
}

export function subscribeToAppShellUpdates(
  serviceWorker: AppShellUpdateServiceWorkerContainer | undefined,
  onUpdateReady: () => void,
): () => void {
  if (!serviceWorker) {
    return () => undefined;
  }

  let hadController = Boolean(serviceWorker.controller);
  const handleControllerChange: EventListener = () => {
    if (hadController) {
      onUpdateReady();
    }
    hadController = true;
  };
  serviceWorker.addEventListener('controllerchange', handleControllerChange);

  return () => {
    serviceWorker.removeEventListener('controllerchange', handleControllerChange);
  };
}
