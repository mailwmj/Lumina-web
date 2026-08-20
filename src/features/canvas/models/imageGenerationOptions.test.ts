import { describe, expect, it } from 'vitest';

import {
  IMAGE_GENERATION_ASPECT_RATIO_VALUES,
  IMAGE_GENERATION_RESOLUTION_VALUES,
  pickClosestImageGenerationAspectRatio,
  resolveImageGenerationResolution,
} from './imageGenerationOptions';

describe('shared image generation options', () => {
  it('exposes every resolution and aspect ratio supported by the generation UI', () => {
    expect(IMAGE_GENERATION_RESOLUTION_VALUES).toEqual(['1K', '2K', '4K']);
    expect(IMAGE_GENERATION_ASPECT_RATIO_VALUES).toEqual([
      '1:1',
      '5:4',
      '9:16',
      '21:9',
      '16:9',
      '3:2',
      '4:3',
      '4:5',
      '3:4',
      '2:3',
    ]);
  });

  it('preserves valid resolutions independently of model metadata', () => {
    expect(resolveImageGenerationResolution('1K').value).toBe('1K');
    expect(resolveImageGenerationResolution('2K').value).toBe('2K');
    expect(resolveImageGenerationResolution('4K').value).toBe('4K');
    expect(resolveImageGenerationResolution('0.5K').value).toBe('2K');
  });

  it('maps automatic ratios to the closest shared option', () => {
    expect(pickClosestImageGenerationAspectRatio(1)).toBe('1:1');
    expect(pickClosestImageGenerationAspectRatio(1.26)).toBe('5:4');
    expect(pickClosestImageGenerationAspectRatio(2.3)).toBe('21:9');
    expect(pickClosestImageGenerationAspectRatio(Number.NaN)).toBe('1:1');
  });
});
