import { describe, expect, it, vi } from 'vitest';

import {
  getAppShellCacheVersion,
  collectAppShellResourceUrls,
  registerAppShellServiceWorker,
  subscribeToAppShellUpdates,
} from './appShell';

describe('versioned app shell', () => {
  it('separates the app-shell cache when the Runtime API contract changes within a release line', () => {
    expect(getAppShellCacheVersion('0.2.46', 'runtime-api-v2')).toBe('0.2.46-runtime-api-v2');
    expect(getAppShellCacheVersion('0.2.46', 'runtime-api-v3')).toBe('0.2.46-runtime-api-v3');
  });

  it('registers a versioned worker and asks it to cache the already loaded shell resources', async () => {
    const postMessage = vi.fn();
    const registration = { active: { postMessage } };
    const serviceWorker = {
      register: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    };

    await registerAppShellServiceWorker({
      serviceWorker,
      version: '0.2.32',
      resources: ['http://localhost/', 'http://localhost/assets/app.js'],
    });

    expect(serviceWorker.register).toHaveBeenCalledWith('/service-worker.js?version=0.2.32');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'CACHE_APP_SHELL',
      urls: ['http://localhost/', 'http://localhost/assets/app.js'],
    });
  });

  it('removes stale app-shell workers when disabled for Vite development', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const serviceWorker = {
      register: vi.fn(),
      ready: Promise.resolve({ active: null }),
      getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
    };

    await registerAppShellServiceWorker({
      serviceWorker,
      version: '0.2.32',
      enabled: false,
    });

    expect(serviceWorker.register).not.toHaveBeenCalled();
    expect(serviceWorker.getRegistrations).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('collects only same-origin document and performance resources for the app shell', () => {
    const resources = collectAppShellResourceUrls({
      origin: 'http://localhost',
      pageUrl: 'http://localhost/projects',
      documentUrls: ['/assets/app.js', 'https://cdn.example.com/font.woff2'],
      performanceUrls: ['http://localhost/assets/style.css', 'https://api.example.com/tasks'],
    });

    expect(resources).toEqual([
      'http://localhost/',
      'http://localhost/projects',
      'http://localhost/assets/app.js',
      'http://localhost/assets/style.css',
    ]);
  });

  it('sends an updated shell to the installing worker instead of the old active worker', async () => {
    const activePostMessage = vi.fn();
    const installingPostMessage = vi.fn();
    const registration = {
      active: { postMessage: activePostMessage },
      installing: { postMessage: installingPostMessage },
    };
    const serviceWorker = {
      register: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    };

    await registerAppShellServiceWorker({
      serviceWorker,
      version: '0.2.33',
      resources: ['http://localhost/', 'http://localhost/assets/app.js'],
    });

    expect(installingPostMessage).toHaveBeenCalledOnce();
    expect(activePostMessage).not.toHaveBeenCalled();
  });

  it('only announces an app shell update after a page already has a worker controller', () => {
    const listeners = new Set<EventListener>();
    const serviceWorker = {
      controller: null as object | null,
      addEventListener: (_type: 'controllerchange', listener: EventListener) => listeners.add(listener),
      removeEventListener: (_type: 'controllerchange', listener: EventListener) => listeners.delete(listener),
    };
    const onUpdateReady = vi.fn();

    const unsubscribe = subscribeToAppShellUpdates(serviceWorker, onUpdateReady);
    listeners.forEach((listener) => listener(new Event('controllerchange')));
    expect(onUpdateReady).not.toHaveBeenCalled();

    serviceWorker.controller = {};
    listeners.forEach((listener) => listener(new Event('controllerchange')));
    expect(onUpdateReady).toHaveBeenCalledOnce();

    unsubscribe();
    listeners.forEach((listener) => listener(new Event('controllerchange')));
    expect(onUpdateReady).toHaveBeenCalledOnce();
  });
});
