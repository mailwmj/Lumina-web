import { describe, expect, it } from 'vitest';

import {
  resolveImageReferencePickerAnchor,
  shouldCloseImageReferencePickerOnPointerDown,
} from './imageReferencePicker';

describe('image reference picker', () => {
  it('anchors to the original @ caret instead of the input container', () => {
    expect(resolveImageReferencePickerAnchor(
      { left: 100, top: 200 },
      { left: 148, bottom: 260 }
    )).toEqual({ left: 48, top: 64 });

    expect(resolveImageReferencePickerAnchor({ left: 100, top: 200 }, null))
      .toEqual({ left: 0, top: 24 });
  });

  it('closes for every pointer press outside the picker itself', () => {
    expect(shouldCloseImageReferencePickerOnPointerDown(true)).toBe(false);
    expect(shouldCloseImageReferencePickerOnPointerDown(false)).toBe(true);
  });
});
