// Provide a minimal localStorage shim for Node test environment
if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.has(k) ? store.get(k)! : null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
}

import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, saveConfig, STORAGE_KEY } from '../config';
import { DEFAULT_LOG_CONFIG } from '../types';

describe('loadConfig', () => {
  beforeEach(() => {
    localStorage!.clear();
  });

  it('returns default when storage empty', () => {
    const config = loadConfig();
    expect(config).toEqual(DEFAULT_LOG_CONFIG);
  });

  it('parses stored JSON', () => {
    const stored = { level: 'warn' as const, moduleLevels: {}, console: false, persist: false, consoleTimestamps: true };
    localStorage!.setItem(STORAGE_KEY, JSON.stringify(stored));
    const config = loadConfig();
    expect(config).toEqual(stored);
  });

  it('returns default on invalid JSON', () => {
    localStorage!.setItem(STORAGE_KEY, 'not json');
    const config = loadConfig();
    expect(config).toEqual(DEFAULT_LOG_CONFIG);
  });
});

describe('saveConfig', () => {
  beforeEach(() => {
    localStorage!.clear();
  });

  it('stores JSON under key', () => {
    const config = { level: 'error' as const, moduleLevels: { canvas: 'debug' as const }, console: false, persist: true, consoleTimestamps: false };
    saveConfig(config);
    expect(localStorage!.getItem(STORAGE_KEY)).toBe(JSON.stringify(config));
  });

  it('overwrites previous', () => {
    saveConfig({ ...DEFAULT_LOG_CONFIG, level: 'info' });
    saveConfig({ ...DEFAULT_LOG_CONFIG, level: 'error' });
    const config = loadConfig();
    expect(config.level).toBe('error');
  });
});