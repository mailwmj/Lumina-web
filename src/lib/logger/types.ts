export type Level = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface LogConfig {
  level: Level;
  moduleLevels: Record<string, Level>;
  console: boolean;
  persist: boolean;
  consoleTimestamps: boolean;
}

export const DEFAULT_LOG_CONFIG: LogConfig = {
  level: 'debug',
  moduleLevels: {},
  console: true,
  persist: true,
  consoleTimestamps: false,
};

export interface LogEntry {
  id: string;
  ts: number;
  level: Level;
  target: string;
  message: string;
  fields: LogFields;
}