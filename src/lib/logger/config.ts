import type { LogConfig } from './types';
import { DEFAULT_LOG_CONFIG } from './types';

export const STORAGE_KEY = 'itv.log.config';

/**
 * Load log config from localStorage, falling back to defaults.
 */
export function loadConfig(): LogConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_LOG_CONFIG;
    }
    return JSON.parse(raw) as LogConfig;
  } catch {
    return DEFAULT_LOG_CONFIG;
  }
}

/**
 * Persist log config to localStorage.
 */
export function saveConfig(partial: Partial<LogConfig>): void {
  const current = loadConfig();
  const next: LogConfig = { ...current, ...partial };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota/privacy mode errors
  }
}

/**
 * Reset log config to defaults.
 */
export function resetConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}