import { describe, expect, it } from 'vitest';

import {
  resolveBrowserCropRect,
  resolveStoryboardSplitGeometry,
} from './browserCanvasImage';

describe('browser canvas image geometry', () => {
  it('centers fixed-ratio crops while preserving the whole image in free mode', () => {
    expect(resolveBrowserCropRect(400, 200, { aspectRatio: '1:1' })).toEqual({
      x: 100,
      y: 0,
      width: 200,
      height: 200,
    });
    expect(resolveBrowserCropRect(400, 200, { aspectRatio: 'free' })).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 200,
    });
    expect(resolveBrowserCropRect(12, 8, { aspectRatio: '1:1' })).toEqual({
      x: 2,
      y: 0,
      width: 8,
      height: 8,
    });
  });

  it('uses custom and original aspect modes when no manual crop has been recorded yet', () => {
    expect(resolveBrowserCropRect(400, 200, {
      aspectRatio: 'custom',
      customAspectRatio: '3:2',
    })).toEqual({
      x: 50,
      y: 0,
      width: 300,
      height: 200,
    });
    expect(resolveBrowserCropRect(400, 200, { aspectRatio: 'original' })).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 200,
    });
  });

  it('splits rows and columns around configured divider pixels without losing edge pixels', () => {
    expect(resolveStoryboardSplitGeometry(12, 8, 2, 3, 1)).toEqual([
      { x: 0, y: 0, width: 4, height: 4 },
      { x: 5, y: 0, width: 3, height: 4 },
      { x: 9, y: 0, width: 3, height: 4 },
      { x: 0, y: 5, width: 4, height: 3 },
      { x: 5, y: 5, width: 3, height: 3 },
      { x: 9, y: 5, width: 3, height: 3 },
    ]);
  });

  it('rejects a grid that cannot give every frame at least one source pixel', () => {
    expect(() => resolveStoryboardSplitGeometry(2, 2, 3, 1, 0))
      .toThrow('Storyboard grid exceeds the available image pixels.');
  });
});
