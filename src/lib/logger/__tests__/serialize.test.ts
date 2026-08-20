import { describe, it, expect } from 'vitest';
import { serializeFields } from '../serialize';

describe('serializeFields', () => {
  it('passes through primitives', () => {
    expect(serializeFields({ a: 1, b: 'x', c: true, d: null })).toEqual({
      a: 1, b: 'x', c: true, d: null,
    });
  });

  it('marks circular references', () => {
    const a: any = { x: 1 };
    a.self = a;
    const result = serializeFields({ a });
    expect((result.a as any).self).toBe('<circular>');
  });

  it('extracts Error info', () => {
    const err = new Error('boom');
    const result = serializeFields({ err });
    expect((result.err as any).__error).toBe(true);
    expect((result.err as any).message).toBe('boom');
  });

  it('truncates the result when serialized JSON exceeds size limit', () => {
    const big = 'x'.repeat(20_000);
    const result = serializeFields({ big });
    // truncateIfLarge replaces the whole object when over limit
    expect((result as any).__truncated).toBe(true);
    expect((result as any).original_bytes).toBeGreaterThan(10 * 1024);
  });

  it('handles undefined input', () => {
    expect(serializeFields(undefined)).toEqual({});
  });
});