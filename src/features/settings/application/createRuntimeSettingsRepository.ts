import {
  SETTINGS_SCHEMA_VERSION,
  type SettingsRepository,
} from '@/features/settings/domain/settingsRepository';
import {
  createDefaultSettingsData,
  type SettingsData,
} from '@/features/settings/domain/settingsSchema';
import { createLocalStorageSettingsStorage } from '@/features/settings/infrastructure/localStorageSettingsRepository';
import { createIndexedDbSettingsStorage } from '@/features/settings/infrastructure/indexedDbSettingsRepository';
import { runtime } from '@/runtime/runtime';
import { migrateSettingsState } from './settingsMigration';
import { createSettingsRepository } from './settingsRepository';

export function createRuntimeSettingsRepository(): SettingsRepository<SettingsData> {
  const storage = runtime.isDesktop()
    ? createLocalStorageSettingsStorage()
    : createIndexedDbSettingsStorage();

  return createSettingsRepository(storage, {
    currentVersion: SETTINGS_SCHEMA_VERSION,
    createDefaultState: createDefaultSettingsData,
    migrateState: migrateSettingsState,
  });
}
