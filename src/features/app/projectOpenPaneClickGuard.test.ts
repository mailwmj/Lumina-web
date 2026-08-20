import { afterEach, describe, expect, it } from 'vitest';

import {
  recordProjectOpenClick,
  resetProjectOpenPaneClickGuard,
  shouldSuppressPaneClickAfterProjectOpen,
} from './projectOpenPaneClickGuard';

function click(detail: number, clientX: number, clientY: number) {
  return { detail, clientX, clientY };
}

describe('project-open pane click guard', () => {
  afterEach(() => {
    resetProjectOpenPaneClickGuard();
  });

  it('suppresses the second click when opening a project replaces its first-click target with the canvas', () => {
    recordProjectOpenClick(click(1, 382, 192));

    expect(
      shouldSuppressPaneClickAfterProjectOpen(click(2, 382, 192))
    ).toBe(true);
  });

  it('keeps a normal canvas double-click available after a distinct canvas click starts a new sequence', () => {
    recordProjectOpenClick(click(1, 382, 192));

    expect(
      shouldSuppressPaneClickAfterProjectOpen(click(1, 720, 460))
    ).toBe(false);
    expect(
      shouldSuppressPaneClickAfterProjectOpen(click(2, 720, 460))
    ).toBe(false);
  });

  it('does not create a guard for keyboard activation', () => {
    recordProjectOpenClick(click(0, 0, 0));

    expect(
      shouldSuppressPaneClickAfterProjectOpen(click(2, 382, 192))
    ).toBe(false);
  });
});
