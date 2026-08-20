import { describe, expect, it } from 'vitest';

import { resolveFittedImageNodeSize } from './imageNodeSizing';

describe('fitted image node size', () => {
  const target = { width: 384, height: 288 };
  const minimum = { minWidth: 168, minHeight: 168 };

  it('uses the result display box for square and landscape images', () => {
    expect(resolveFittedImageNodeSize('1:1', target, minimum)).toEqual({
      width: 288,
      height: 288,
    });
    expect(resolveFittedImageNodeSize('16:9', target, minimum)).toEqual({
      width: 384,
      height: 216,
    });
  });

  it('preserves a useful minimum width for portrait images', () => {
    expect(resolveFittedImageNodeSize('9:16', target, minimum)).toEqual({
      width: 168,
      height: 299,
    });
  });
});
