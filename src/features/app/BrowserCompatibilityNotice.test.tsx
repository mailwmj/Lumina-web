// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';

import { BrowserCompatibilityNotice } from './BrowserCompatibilityNotice';

describe('BrowserCompatibilityNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('warns Safari users without blocking their work and can be dismissed', async () => {
    await act(async () => {
      root.render(
        <BrowserCompatibilityNotice
          capabilities={{
            browser: 'safari',
            isRecommendedBrowser: false,
            hasIndexedDb: true,
            hasStorageEstimate: false,
            hasServiceWorker: true,
            issues: ['browser-not-recommended', 'storage-estimate-unavailable'],
          }}
        />
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('浏览器兼容性提示');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Safari');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('存储配额');

    const closeButton = container.querySelector<HTMLButtonElement>('[aria-label="关闭"]');
    await act(async () => {
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
