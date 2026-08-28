// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectPageNavigation } from './useProjectPageNavigation';

interface NavigationHarnessProps {
  isHydrated: boolean;
  isOpeningProject: boolean;
  projectId: string | null;
  openProject: (projectId: string) => void;
}

function NavigationHarness({
  isHydrated,
  isOpeningProject,
  projectId,
  openProject,
}: NavigationHarnessProps) {
  useProjectPageNavigation({ isHydrated, isOpeningProject, projectId, openProject });
  return null;
}

describe('useProjectPageNavigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.history.replaceState(null, '', '/canvas?project=project-1');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('reopens the project addressed by the page after hydration', async () => {
    const openProject = vi.fn();

    await act(async () => {
      root.render(
        <NavigationHarness
          isHydrated
          isOpeningProject={false}
          projectId={null}
          openProject={openProject}
        />,
      );
    });

    expect(openProject).toHaveBeenCalledWith('project-1');
  });

  it('keeps the addressed project in the URL while it is opening', async () => {
    await act(async () => {
      root.render(
        <NavigationHarness
          isHydrated
          isOpeningProject
          projectId={null}
          openProject={vi.fn()}
        />,
      );
    });

    expect(window.location.search).toBe('?project=project-1');
  });

  it('keeps the opened project in the page URL and preserves unrelated navigation state', async () => {
    window.history.replaceState(null, '', '/canvas?mode=inspect#details');

    await act(async () => {
      root.render(
        <NavigationHarness
          isHydrated
          isOpeningProject={false}
          projectId="project-1"
          openProject={vi.fn()}
        />,
      );
    });

    expect(window.location.pathname).toBe('/canvas');
    expect(window.location.search).toBe('?mode=inspect&project=project-1');
    expect(window.location.hash).toBe('#details');
  });

  it('removes a stale project parameter after the requested project cannot be opened', async () => {
    const openProject = vi.fn();

    await act(async () => {
      root.render(
        <NavigationHarness
          isHydrated
          isOpeningProject={false}
          projectId={null}
          openProject={openProject}
        />,
      );
    });
    await act(async () => {
      root.render(
        <NavigationHarness
          isHydrated
          isOpeningProject={false}
          projectId={null}
          openProject={openProject}
        />,
      );
    });

    expect(window.location.search).toBe('');
  });
});
