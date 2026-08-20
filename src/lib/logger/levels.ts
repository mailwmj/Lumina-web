import type { Level } from './types';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function levelValue(level: Level): number {
  return LEVEL_ORDER[level];
}

export function isLevelEnabled(target: Level, globalLevel: Level): boolean {
  return levelValue(target) >= levelValue(globalLevel);
}

export function resolveLevel(
  target: string,
  config: { level: Level; moduleLevels: Record<string, Level> },
): Level {
  // 最长前缀匹配
  const entries = Object.entries(config.moduleLevels);
  let bestMatch: { prefix: string; level: Level } | null = null;
  for (const [prefix, lvl] of entries) {
    if (target === prefix || target.startsWith(prefix + '.')) {
      if (!bestMatch || prefix.length > bestMatch.prefix.length) {
        bestMatch = { prefix, level: lvl };
      }
    }
  }
  return bestMatch?.level ?? config.level;
}