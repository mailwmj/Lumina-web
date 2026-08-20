import {
  SETTINGS_SCHEMA_VERSION,
  type SettingsRepository,
} from '@/features/settings/domain/settingsRepository';
import {
  createDefaultSettingsData,
  type SettingsData,
} from '@/features/settings/domain/settingsSchema';
import { createLocalStorageSettingsStorage } from '@/features/settings/infrastructure/localStorageSettingsRepository';
import { migrateSettingsState } from './settingsMigration';
import { createSettingsRepository } from './settingsRepository';

export function createRuntimeSettingsRepository(): SettingsRepository<SettingsData> {
  return createSettingsRepository(createLocalStorageSettingsStorage(), {
    currentVersion: SETTINGS_SCHEMA_VERSION,
    createDefaultState: createDefaultSettingsData,
    migrateState: migrateSettingsState,
  });
}
