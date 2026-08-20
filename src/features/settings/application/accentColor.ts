export const DEFAULT_ACCENT_COLOR = '#9DE500';
export const LEGACY_DEFAULT_ACCENT_COLOR = '#3B82F6';

const DARK_ACCENT_FOREGROUND = '#09090B';
const LIGHT_ACCENT_FOREGROUND = '#FAFAFA';
const HEX_COLOR_PATTERN = /^#?[0-9a-fA-F]{6}$/;

export function normalizeAccentColor(input: unknown): string {
  if (typeof input !== 'string') {
    return DEFAULT_ACCENT_COLOR;
  }

  const trimmed = input.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return DEFAULT_ACCENT_COLOR;
  }

  return (trimmed.startsWith('#') ? trimmed : `#${trimmed}`).toUpperCase();
}

export function migrateAccentColor(input: unknown): string {
  const normalized = normalizeAccentColor(input);
  return normalized === LEGACY_DEFAULT_ACCENT_COLOR ? DEFAULT_ACCENT_COLOR : normalized;
}

export function migrateAppearanceSettings(input: unknown): Record<string, unknown> {
  const state = input && typeof input === 'object'
    ? input as Record<string, unknown>
    : {};
  const {
    uiRadiusPreset: _legacyUiRadiusPreset,
    themeTonePreset: _legacyThemeTonePreset,
    accentColor,
    ...retainedState
  } = state;

  return {
    ...retainedState,
    accentColor: migrateAccentColor(accentColor),
  };
}

export function hexToRgbChannels(input: unknown): string {
  const normalized = normalizeAccentColor(input).slice(1);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `${red} ${green} ${blue}`;
}

function toLinearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function getRelativeLuminance(hexColor: string): number {
  const hex = normalizeAccentColor(hexColor).slice(1);
  const red = toLinearChannel(Number.parseInt(hex.slice(0, 2), 16));
  const green = toLinearChannel(Number.parseInt(hex.slice(2, 4), 16));
  const blue = toLinearChannel(Number.parseInt(hex.slice(4, 6), 16));
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function getContrastRatio(left: string, right: string): number {
  const leftLuminance = getRelativeLuminance(left);
  const rightLuminance = getRelativeLuminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function getAccentForeground(input: unknown): string {
  const accent = normalizeAccentColor(input);
  const darkContrast = getContrastRatio(accent, DARK_ACCENT_FOREGROUND);
  const lightContrast = getContrastRatio(accent, LIGHT_ACCENT_FOREGROUND);
  return darkContrast >= lightContrast ? DARK_ACCENT_FOREGROUND : LIGHT_ACCENT_FOREGROUND;
}
