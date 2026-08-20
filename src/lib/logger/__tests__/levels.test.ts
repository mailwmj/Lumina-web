import { describe, it, expect } from 'vitest';
import { isLevelEnabled, levelValue, resolveLevel } from '../levels';
import type { LogConfig } from '../types';

describe('levelValue', () => {
  it('returns numeric order for each level', () => {
    expect(levelValue('debug')).toBe(0);
    expect(levelValue('info')).toBe(1);
    expect(levelValue('warn')).toBe(2);
    expect(levelValue('error')).toBe(3);
  });
});

describe('isLevelEnabled', () => {
  it('passes when target >= threshold', () => {
    expect(isLevelEnabled('warn', 'info')).toBe(true);
    expect(isLevelEnabled('info', 'info')).toBe(true);
  });

  it('rejects when target < threshold', () => {
    expect(isLevelEnabled('debug', 'info')).toBe(false);
  });
});

describe('resolveLevel', () => {
  const baseConfig: LogConfig = {
    level: 'info',
    moduleLevels: {},
    console: true,
    persist: true,
    consoleTimestamps: false,
  };

  it('returns global level when no override', () => {
    expect(resolveLevel('canvas.Canvas', baseConfig)).toBe('info');
  });

  it('matches exact prefix', () => {
    expect(resolveLevel('canvas', { ...baseConfig, moduleLevels: { canvas: 'debug' } })).toBe('debug');
  });

  it('matches dotted prefix', () => {
    expect(resolveLevel('canvas.Canvas', { ...baseConfig, moduleLevels: { canvas: 'debug' } })).toBe('debug');
  });

  it('uses longest prefix when multiple match', () => {
    expect(
      resolveLevel('canvas.Canvas', {
        ...baseConfig,
        moduleLevels: { canvas: 'debug', 'canvas.Canvas': 'error' },
      }),
    ).toBe('error');
  });

  it('returns global level when prefix does not match', () => {
    expect(
      resolveLevel('ai.providers', { ...baseConfig, moduleLevels: { canvas: 'debug' } }),
    ).toBe('info');
  });
});