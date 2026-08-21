// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';

import { WebAppUpdateNotice } from './WebAppUpdateNotice';

describe('WebAppUpdateNotice', () => {
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

  it('waits for an explicit reload action after a new shell is ready', async () => {
    const onReload = vi.fn();
    await act(async () => {
      root.render(<WebAppUpdateNotice isReady onReload={onReload} />);
    });

    expect(onReload).not.toHaveBeenCalled();
    const button = Array.from(container.querySelectorAll('button'))
      .find((element) => element.textContent === '重新加载');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onReload).toHaveBeenCalledOnce();
  });
});
