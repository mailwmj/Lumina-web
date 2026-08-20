import type { SettingsStorageAdapter } from '@/features/settings/domain/settingsRepository';

export const SETTINGS_STORAGE_KEY = 'settings-storage';

let memoryValue: string | null = null;

type LocalSettingsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function resolveStorage(storage?: LocalSettingsStorage): LocalSettingsStorage | null {
  if (storage) {
    return storage;
  }
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function createLocalStorageSettingsStorage(
  storage?: LocalSettingsStorage
): SettingsStorageAdapter {
  return {
    async read() {
      try {
        const target = resolveStorage(storage);
        return target ? target.getItem(SETTINGS_STORAGE_KEY) : memoryValue;
      } catch {
        return memoryValue;
      }
    },
    async write(value) {
      memoryValue = value;
      try {
        resolveStorage(storage)?.setItem(SETTINGS_STORAGE_KEY, value);
      } catch {
        // Keep settings available for the current session when storage rejects a write.
      }
    },
    async remove() {
      memoryValue = null;
      try {
        resolveStorage(storage)?.removeItem(SETTINGS_STORAGE_KEY);
      } catch {
        // The in-memory copy is still reset when storage is unavailable.
      }
    },
  };
}
