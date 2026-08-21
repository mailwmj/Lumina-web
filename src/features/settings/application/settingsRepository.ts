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

const SECRET_URL_QUERY_PARAMETER_NAMES = new Set([
  'api_key',
  'apikey',
  'key',
  'token',
  'access_token',
  'password',
  'secret',
]);

function removeUrlSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(removeUrlSecrets);
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }

  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    if ((key === 'baseUrl' || key === 'url') && typeof entry === 'string') {
      const sanitized = sanitizeUrl(entry);
      if (sanitized !== entry) {
        (value as Record<string, unknown>)[key] = sanitized;
      }
      return;
    }
    removeUrlSecrets(entry);
  });
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    let changed = Boolean(url.username || url.password || url.hash);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_URL_QUERY_PARAMETER_NAMES.has(key.toLowerCase())) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1');
  }
}

export function createCredentialFreeSettingsExport<TState>(
  snapshot: SettingsSnapshot<TState>
): SettingsExport<TState> {
  const settings = JSON.parse(JSON.stringify(snapshot.state)) as TState;
  SETTINGS_SECRET_PATHS.forEach((path) => removePath(settings, path));
  removeUrlSecrets(settings);
  return {
    settings,
    version: snapshot.version,
  };
}

function hydrateState<TState extends object>(
  defaults: TState,
  persisted: Partial<TState>
): TState {
  const keys = Object.keys(defaults) as Array<keyof TState>;
  return Object.fromEntries(
    keys.map((key) => [key, key in persisted ? persisted[key] : defaults[key]])
  ) as unknown as TState;
}

export function createSettingsRepository<TState extends object>(
  storage: SettingsStorageAdapter,
  options: SettingsRepositoryOptions<TState>
): SettingsRepository<TState> {
  const migrate = (snapshot: SettingsSnapshot<unknown>): SettingsSnapshot<TState> => {
    const persistedState = snapshot.version === options.currentVersion
      ? snapshot.state as Partial<TState>
      : options.migrateState(snapshot.state, snapshot.version);
    return {
      state: hydrateState(options.createDefaultState(), persistedState),
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
      return snapshot === null ? null : createCredentialFreeSettingsExport(snapshot);
    },
  };
}
