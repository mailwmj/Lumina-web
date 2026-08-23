// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';

import { StorageStatusNotice } from './StorageStatusNotice';

const noticeMocks = vi.hoisted(() => ({
  project: null as { id: string; name: string } | null,
  getCurrentProjectExportRecord: vi.fn(),
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector({
    currentProject: noticeMocks.project,
    getCurrentProjectExportRecord: noticeMocks.getCurrentProjectExportRecord,
  }),
}));

const deniedPersistenceService = {
  read: vi.fn(async () => ({
    supported: true,
    persisted: false,
    persistResult: false,
    usage: 2.9 * 1024 * 1024,
    quota: 10 * 1024 * 1024 * 1024,
    available: 10 * 1024 * 1024 * 1024 - 2.9 * 1024 * 1024,
  })),
  subscribeToCapacityErrors: vi.fn(() => () => {}),
};

describe('StorageStatusNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    noticeMocks.project = null;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderNotice() {
    await act(async () => {
      root.render(
        <StorageStatusNotice
          backupService={null}
          storageStatusService={deniedPersistenceService}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('does not warn about denied persistence before a project is open', async () => {
    await renderNotice();

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps the persistence warning while a project is open', async () => {
    noticeMocks.project = { id: 'project-1', name: 'Project' };
    await renderNotice();

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('浏览器未授予持久化存储');
  });
});
