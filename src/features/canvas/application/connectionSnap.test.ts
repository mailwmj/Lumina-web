import { describe, expect, it } from 'vitest';

import {
  CANVAS_CONNECTION_SNAP_SCREEN_RADIUS,
  resolveCanvasConnectionRadius,
} from './connectionSnap';

describe('canvas connection snap radius', () => {
  it('keeps the target snap zone at a consistent screen distance across zoom levels', () => {
    expect(CANVAS_CONNECTION_SNAP_SCREEN_RADIUS).toBe(36);
    expect(resolveCanvasConnectionRadius(1)).toBe(36);
    expect(resolveCanvasConnectionRadius(0.5)).toBe(72);
    expect(resolveCanvasConnectionRadius(2)).toBe(18);
  });

  it('falls back to the default viewport zoom for invalid values', () => {
    expect(resolveCanvasConnectionRadius(0)).toBe(36);
    expect(resolveCanvasConnectionRadius(Number.NaN)).toBe(36);
  });
});
