import { describe, expect, it } from 'vitest';

import {
  resolveImageFileExtension,
  resolveImageFileName,
  resolveImageFileStem,
} from './imageMetadata';

describe('resolveImageFileName', () => {
  it.each([
    ['/projects/outputs/cat.png', 'cat.png'],
    ['C:\\projects\\outputs\\cat.png', 'cat.png'],
    ['https://cdn.example.com/generated/my%20image.png', 'my image.png'],
    ['https://cdn.example.com/generated/cat.png?token=secret&expires=1', 'cat.png'],
  ])('resolves a basename from %s', (source, expected) => {
    expect(resolveImageFileName(source, 'Result image')).toBe(expected);
  });

  it.each([
    ['https://cdn.example.com/generated/', 'Result image'],
    ['blob:https://example.com/5f6f5bd9', 'Result image'],
    ['data:image/png;base64,AAAA', 'Result image'],
  ])('uses the fallback for non-file source %s', (source, expected) => {
    expect(resolveImageFileName(source, expected)).toBe(expected);
  });

  it('splits a resolved filename into stem and extension', () => {
    expect(resolveImageFileStem('AI_Media_GPT_Image_1.webp')).toBe('AI_Media_GPT_Image_1');
    expect(resolveImageFileExtension('AI_Media_GPT_Image_1.webp')).toBe('webp');
    expect(resolveImageFileStem('node-output-1')).toBe('node-output-1');
    expect(resolveImageFileExtension('node-output-1')).toBeNull();
  });
});
