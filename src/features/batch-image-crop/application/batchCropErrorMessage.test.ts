import { describe, expect, it } from 'vitest';
import { resolveBatchCropErrorMessage } from './batchCropErrorMessage';

describe('batch crop error messages', () => {
  const translate = ((key: string) => `translated:${key}`) as never;

  it('translates known local error codes', () => {
    expect(resolveBatchCropErrorMessage(translate, new Error('IMAGE_DIMENSIONS_TOO_LARGE')))
      .toBe('translated:batchCrop.error.dimensionsTooLarge');
  });

  it.each([
    'INVALID_IMAGE',
    'INVALID_TARGET_SIZE',
    'INVALID_FIXED_CANVAS_TRANSFORM',
  ])('translates local rendering code %s', (code) => {
    expect(resolveBatchCropErrorMessage(translate, new Error(code)))
      .toBe('translated:batchCrop.error.invalidImage');
  });

  it('preserves provider error text when the code is unknown', () => {
    expect(resolveBatchCropErrorMessage(translate, new Error('provider rejected the request')))
      .toBe('provider rejected the request');
  });
});
