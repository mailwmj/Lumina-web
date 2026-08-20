import {
  SETTINGS_SCHEMA_VERSION,
  type SettingsRepository,
} from '@/features/settings/domain/settingsRepository';
import { createLocalStorageSettingsStorage } from '@/features/settings/infrastructure/localStorageSettingsRepository';
import { migrateSettingsState } from './settingsMigration';
import { createSettingsRepository } from './settingsRepository';

export function createRuntimeSettingsRepository<TState>(): SettingsRepository<TState> {
  return createSettingsRepository(createLocalStorageSettingsStorage(), {
    currentVersion: SETTINGS_SCHEMA_VERSION,
    migrateState: (state, version) => migrateSettingsState(state, version) as TState,
  });
}
