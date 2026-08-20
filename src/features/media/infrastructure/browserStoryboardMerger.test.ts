import { describe, expect, it } from 'vitest';

import { resolveBrowserStoryboardLayout } from './browserStoryboardMerger';

describe('browser storyboard merger', () => {
  it('keeps cell, gap, padding, and bottom-note layout when the output fits its maximum dimension', () => {
    expect(resolveBrowserStoryboardLayout({
      sourceCellWidth: 400,
      sourceCellHeight: 200,
      rows: 2,
      cols: 3,
      cellGap: 10,
      outerPadding: 20,
      noteHeight: 30,
      fontSize: 20,
      maxDimension: 4096,
    })).toEqual({
      canvasWidth: 1260,
      canvasHeight: 510,
      cellWidth: 400,
      cellHeight: 200,
      gap: 10,
      padding: 20,
      noteHeight: 30,
      fontSize: 20,
    });
  });
});
