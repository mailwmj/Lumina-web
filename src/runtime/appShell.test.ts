import { describe, expect, it, vi } from 'vitest';

import {
  collectAppShellResourceUrls,
  registerAppShellServiceWorker,
} from './appShell';

describe('versioned app shell', () => {
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
});
