import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ACCENT_COLOR,
  getAccentForeground,
  hexToRgbChannels,
  migrateAppearanceSettings,
  migrateAccentColor,
  normalizeAccentColor,
} from './accentColor';

describe('accentColor', () => {
  it('normalizes valid colors and falls back to lime', () => {
    expect(normalizeAccentColor('8b5cf6')).toBe('#8B5CF6');
    expect(normalizeAccentColor('invalid')).toBe(DEFAULT_ACCENT_COLOR);
    expect(normalizeAccentColor(undefined)).toBe(DEFAULT_ACCENT_COLOR);
  });

  it('migrates only the legacy default blue', () => {
    expect(migrateAccentColor('#3b82f6')).toBe(DEFAULT_ACCENT_COLOR);
    expect(migrateAccentColor('#8B5CF6')).toBe('#8B5CF6');
  });

  it('converts the accent to CSS rgb channels', () => {
    expect(hexToRgbChannels('#9DE500')).toBe('157 229 0');
  });

  it('chooses a readable foreground for bright and dark colors', () => {
    expect(getAccentForeground('#9DE500')).toBe('#09090B');
    expect(getAccentForeground('#312E81')).toBe('#FAFAFA');
  });

  it('removes retired appearance presets while preserving unrelated settings', () => {
    expect(migrateAppearanceSettings({
      uiRadiusPreset: 'large',
      themeTonePreset: 'warm',
      accentColor: '#8B5CF6',
      snapGridSize: 24,
    })).toEqual({
      accentColor: '#8B5CF6',
      snapGridSize: 24,
    });
  });

  it('applies accent migration when appearance settings are upgraded', () => {
    expect(migrateAppearanceSettings({ accentColor: '#3b82f6' })).toEqual({
      accentColor: DEFAULT_ACCENT_COLOR,
    });
    expect(migrateAppearanceSettings({ accentColor: 'invalid' })).toEqual({
      accentColor: DEFAULT_ACCENT_COLOR,
    });
  });
});
