import { describe, expect, it } from 'vitest';

import { resolveCanvasGridPattern } from './CanvasGridBackground';

describe('resolveCanvasGridPattern', () => {
  it('matches the reference grid at the default viewport', () => {
    expect(resolveCanvasGridPattern(72, 0, 0, 1)).toEqual({
      size: 72,
      x: 0,
      y: 0,
    });
  });

  it('scales the spacing and normalizes negative viewport offsets', () => {
    const pattern = resolveCanvasGridPattern(72, -800, -640, 1.8);

    expect(pattern.size).toBeCloseTo(129.6);
    expect(pattern.x).toBeCloseTo(107.2);
    expect(pattern.y).toBeCloseTo(8);
  });
});
