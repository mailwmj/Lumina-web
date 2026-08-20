import type {
  SettingsExport,
  SettingsRepository,
  SettingsRepositoryOptions,
  SettingsSnapshot,
  SettingsStorageAdapter,
} from '@/features/settings/domain/settingsRepository';
import { SETTINGS_SECRET_PATHS } from '@/features/settings/domain/settingsRepository';

function parseSnapshot(value: string): SettingsSnapshot<unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid settings snapshot');
  }
  const snapshot = parsed as Record<string, unknown>;
  if (typeof snapshot.version !== 'number' || !('state' in snapshot)) {
    throw new Error('Invalid settings snapshot');
  }
  return {
    state: snapshot.state,
    version: snapshot.version,
  };
}

function removePath(value: unknown, path: readonly string[], index = 0): void {
  if (!value || typeof value !== 'object' || index >= path.length) {
    return;
  }
  const segment = path[index];
  if (segment === '*') {
    if (Array.isArray(value)) {
      value.forEach((item) => removePath(item, path, index + 1));
    }
    return;
  }
  if (Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (index === path.length - 1) {
    delete record[segment];
    return;
  }
  removePath(record[segment], path, index + 1);
}

function createCredentialFreeExport<TState>(
  snapshot: SettingsSnapshot<TState>
): SettingsExport {
  const settings = JSON.parse(JSON.stringify(snapshot.state)) as unknown;
  SETTINGS_SECRET_PATHS.forEach((path) => removePath(settings, path));
  return {
    settings,
    version: snapshot.version,
  };
}

export function createSettingsRepository<TState>(
  storage: SettingsStorageAdapter,
  options: SettingsRepositoryOptions<TState>
): SettingsRepository<TState> {
  const migrate = (snapshot: SettingsSnapshot<unknown>): SettingsSnapshot<TState> => {
    if (snapshot.version === options.currentVersion) {
      return snapshot as SettingsSnapshot<TState>;
    }
    return {
      state: options.migrateState(snapshot.state, snapshot.version),
      version: options.currentVersion,
    };
  };

  const read = async (): Promise<SettingsSnapshot<TState> | null> => {
    const value = await storage.read();
    if (value === null) {
      return null;
    }
    const persisted = parseSnapshot(value);
    const current = migrate(persisted);
    if (persisted.version !== current.version) {
      await storage.write(JSON.stringify(current));
    }
    return current;
  };

  return {
    read,
    async update(snapshot) {
      await storage.write(JSON.stringify(snapshot));
    },
    migrate,
    reset: () => storage.remove(),
    async createExport() {
      const snapshot = await read();
      return snapshot === null ? null : createCredentialFreeExport(snapshot);
    },
  };
}
