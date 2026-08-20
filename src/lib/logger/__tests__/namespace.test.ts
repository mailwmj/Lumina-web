import { describe, it, expect } from 'vitest';
import { fileToNamespace } from '../namespace';

describe('fileToNamespace', () => {
  it('converts a src-prefixed path to dot notation', () => {
    expect(fileToNamespace('src/features/canvas/Canvas.tsx'))
      .toBe('features.canvas.Canvas');
  });

  it('strips .tsx extension', () => {
    expect(fileToNamespace('src/lib/logger/index.tsx'))
      .toBe('lib.logger');
  });

  it('strips .ts extension', () => {
    expect(fileToNamespace('src/lib/logger/types.ts'))
      .toBe('lib.logger.types');
  });

  it('removes /index suffix', () => {
    expect(fileToNamespace('src/lib/logger/index.ts'))
      .toBe('lib.logger');
  });

  it('handles paths with no src prefix', () => {
    // Falls back to basename
    expect(fileToNamespace('foo/bar/baz.ts'))
      .toBe('baz');
  });

  it('handles Windows-style backslashes', () => {
    // With backslash, lastIndexOf('src/') returns -1, so falls back to basename
    expect(fileToNamespace('src\\features\\Canvas.tsx'))
      .toBe('Canvas');
  });

  it('strips Vite query strings', () => {
    expect(fileToNamespace('src/features/Canvas.tsx?t=12345'))
      .toBe('features.Canvas');
  });
});