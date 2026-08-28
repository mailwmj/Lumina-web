export interface SettingsSnapshot<TState> {
  state: TState;
  version: number;
}

export interface SettingsExport<TState = unknown> {
  settings: TState;
  version: number;
}

export const SETTINGS_SCHEMA_VERSION = 33;

export const SETTINGS_SECRET_PATHS = [
  ['openAiImageApi', 'apiKey'],
  ['chaomoImageApi', 'apiKey'],
  ['additionalImageApis', '*', 'apiKey'],
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

export interface SettingsRepository<TState extends object> {
  read(): Promise<SettingsSnapshot<TState> | null>;
  update(snapshot: SettingsSnapshot<TState>): Promise<void>;
  migrate(snapshot: SettingsSnapshot<unknown>): SettingsSnapshot<TState>;
  reset(): Promise<void>;
  createExport(): Promise<SettingsExport | null>;
}

export interface SettingsRepositoryOptions<TState extends object> {
  currentVersion: number;
  createDefaultState(): TState;
  migrateState(state: unknown, persistedVersion: number): Partial<TState>;
}
