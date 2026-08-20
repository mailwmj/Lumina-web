import {
  createSettingsRecord,
  getWebDatabase,
  readSettingsRecord,
  type WebDatabase,
} from '@/runtime/webDatabase';
import type { SettingsStorageAdapter } from '@/features/settings/domain/settingsRepository';

export function createIndexedDbSettingsStorage(
  database: WebDatabase = getWebDatabase()
): SettingsStorageAdapter {
  return {
    async read() {
      const record = await database.run(['settings'], 'readonly', (transaction) =>
        transaction.get<{ key: string; value: string }>('settings', 'settings-storage')
      );
      return readSettingsRecord(record);
    },
    async write(value) {
      await database.run(['settings'], 'readwrite', (transaction) =>
        transaction.put('settings', createSettingsRecord(value))
      );
    },
    async remove() {
      await database.run(['settings'], 'readwrite', (transaction) =>
        transaction.delete('settings', 'settings-storage')
      );
    },
  };
}
