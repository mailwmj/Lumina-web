/* global URL, Response, caches, fetch, self */

const version = new URL(self.location.href).searchParams.get('version') || 'dev';
const cacheName = `lumina-app-shell-${version}`;
const appShellUrl = new URL('/', self.location.origin).toString();

async function cacheUrls(urls) {
  const cache = await caches.open(cacheName);
  await Promise.all(urls.map(async (url) => {
    try {
      await cache.add(url);
    } catch {
      // A transient asset request must not prevent the shell from activating.
    }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheUrls([appShellUrl]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith('lumina-app-shell-') && name !== cacheName)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_APP_SHELL' || !Array.isArray(event.data.urls)) {
    return;
  }
  event.waitUntil(cacheUrls(event.data.urls));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    if (request.mode === 'navigate') {
      try {
        return await fetch(request);
      } catch {
        return await cache.match(request, { ignoreVary: true })
          || await cache.match(appShellUrl, { ignoreVary: true })
          || new Response('', { status: 503, statusText: 'Offline' });
      }
    }
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) {
      return cached;
    }
    if (self.navigator.onLine === false) {
      return new Response('', { status: 503, statusText: 'Offline' });
    }
    return await fetch(request);
  })());
});
