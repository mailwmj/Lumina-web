export interface SettingsSnapshot<TState> {
  state: TState;
  version: number;
}

export interface SettingsExport<TState = unknown> {
  settings: TState;
  version: number;
}

export const SETTINGS_SCHEMA_VERSION = 31;

export const SETTINGS_SECRET_PATHS = [
  ['openAiImageApi', 'apiKey'],
  ['chaomoImageApi', 'apiKey'],
  ['customImageApis', '*', 'apiKey'],
  ['textApis', '*', 'apiKey'],
  ['videoApis', '*', 'apiKey'],
  ['externalAgentConnection', 'token'],
  ['webDav', 'username'],
  ['webDav', 'password'],
] as const;

export interface SettingsStorageAdapter {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

export interface SettingsRepository<TState> {
  read(): Promise<SettingsSnapshot<TState> | null>;
  update(snapshot: SettingsSnapshot<TState>): Promise<void>;
  migrate(snapshot: SettingsSnapshot<unknown>): SettingsSnapshot<TState>;
  reset(): Promise<void>;
  createExport(): Promise<SettingsExport | null>;
}

export interface SettingsRepositoryOptions<TState> {
  currentVersion: number;
  migrateState(state: unknown, persistedVersion: number): TState;
}
