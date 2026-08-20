import { describe, expect, it } from 'vitest';

import {
  resolveSelectMenuHorizontalGeometry,
  resolveSelectMenuVerticalGeometry,
} from './selectMenuGeometry';

describe('resolveSelectMenuHorizontalGeometry', () => {
  it('widens a narrow trigger so option labels and the selected icon fit', () => {
    expect(resolveSelectMenuHorizontalGeometry(645, 76, 1442)).toEqual({
      left: 645,
      width: 160,
    });
  });

  it('keeps the widened menu inside the right viewport inset', () => {
    expect(resolveSelectMenuHorizontalGeometry(1390, 76, 1442)).toEqual({
      left: 1274,
      width: 160,
    });
  });

  it('uses a caller-provided minimum width while preserving the viewport inset', () => {
    expect(resolveSelectMenuHorizontalGeometry(1390, 76, 1442, 272)).toEqual({
      left: 1162,
      width: 272,
    });
  });

  it('shrinks to the available width on a very narrow viewport', () => {
    expect(resolveSelectMenuHorizontalGeometry(20, 76, 100)).toEqual({
      left: 8,
      width: 84,
    });
  });
});

describe('resolveSelectMenuVerticalGeometry', () => {
  it('shows all eight reasoning options when they fit below the trigger', () => {
    expect(resolveSelectMenuVerticalGeometry(620, 644, 8, 968)).toEqual({
      maxHeight: 298,
      top: 652,
    });
  });

  it('opens above a low trigger and still shows all eight options', () => {
    expect(resolveSelectMenuVerticalGeometry(573, 597, 8, 633)).toEqual({
      maxHeight: 298,
      top: 267,
    });
  });

  it('uses the larger available side when neither side fits the full menu', () => {
    expect(resolveSelectMenuVerticalGeometry(100, 124, 8, 220)).toEqual({
      maxHeight: 92,
      top: 8,
    });
  });
});
