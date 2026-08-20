import { describe, expect, it } from 'vitest';

import { createSettingsRepository } from '@/features/settings/application/settingsRepository';
import type { SettingsStorageAdapter } from './settingsRepository';

function createMemoryStorage(initialValue: string | null = null): SettingsStorageAdapter {
  let value = initialValue;
  return {
    read: async () => value,
    write: async (nextValue) => {
      value = nextValue;
    },
    remove: async () => {
      value = null;
    },
  };
}

describe('SettingsRepository contract', () => {
  it('hydrates and persists an older snapshot through the configured schema migration', async () => {
    const storage = createMemoryStorage(JSON.stringify({
      state: { theme: 'legacy' },
      version: 1,
    }));
    let migrationCount = 0;
    const repository = createSettingsRepository(storage, {
      currentVersion: 2,
      createDefaultState: () => ({ theme: 'light', migratedFrom: 0 }),
      migrateState: (state, persistedVersion) => {
        migrationCount += 1;
        return {
          ...(state as Record<string, unknown>),
          migratedFrom: persistedVersion,
        };
      },
    });

    await expect(repository.read()).resolves.toEqual({
      state: { theme: 'legacy', migratedFrom: 1 },
      version: 2,
    });
    await repository.read();
    expect(migrationCount).toBe(1);
  });

  it('round-trips the current settings snapshot', async () => {
    const repository = createSettingsRepository(createMemoryStorage(), {
      currentVersion: 2,
      createDefaultState: () => ({ theme: 'light' }),
      migrateState: (state) => state as { theme: string },
    });

    await repository.update({
      state: { theme: 'dark' },
      version: 2,
    });

    await expect(repository.read()).resolves.toEqual({
      state: { theme: 'dark' },
      version: 2,
    });
  });

  it('hydrates persisted values onto a complete default state', async () => {
    const repository = createSettingsRepository(
      createMemoryStorage(JSON.stringify({
        state: { theme: 'dark', isHydrated: true },
        version: 2,
      })),
      {
        currentVersion: 2,
        createDefaultState: () => ({ theme: 'light', snapGridSize: 72 }),
        migrateState: (state) => state as { theme?: string; snapGridSize?: number },
      }
    );

    await expect(repository.read()).resolves.toEqual({
      state: { theme: 'dark', snapGridSize: 72 },
      version: 2,
    });
  });

  it('resets persisted settings', async () => {
    const repository = createSettingsRepository(createMemoryStorage(), {
      currentVersion: 2,
      createDefaultState: () => ({ theme: 'light' }),
      migrateState: (state) => state as { theme: string },
    });
    await repository.update({ state: { theme: 'dark' }, version: 2 });

    await repository.reset();

    await expect(repository.read()).resolves.toBeNull();
  });

  it('exports ordinary settings without credentials', async () => {
    const settings = {
      accentColor: '#123456',
      openAiImageApi: { apiKey: 'image-key', baseUrl: 'https://image.example' },
      chaomoImageApi: { apiKey: 'chaomo-key', baseUrl: 'https://chaomo.example' },
      customImageApis: [
        { id: 'custom-1', apiKey: 'custom-key', baseUrl: 'https://custom.example' },
      ],
      textApis: [
        { id: 'text-1', apiKey: 'text-key', baseUrl: 'https://text.example' },
      ],
      videoApis: [
        { id: 'video-1', apiKey: 'video-key', baseUrl: 'https://video.example' },
      ],
      externalAgentConnection: {
        enabled: true,
        url: 'http://127.0.0.1:17372',
        token: 'bridge-token',
      },
      webDav: {
        baseUrl: 'https://dav.example',
        username: 'dav-user',
        password: 'dav-password',
      },
    };
    const repository = createSettingsRepository(createMemoryStorage(), {
      currentVersion: 2,
      createDefaultState: () => settings,
      migrateState: (state) => state as Record<string, unknown>,
    });
    await repository.update({
      version: 2,
      state: settings,
    });

    await expect(repository.createExport()).resolves.toEqual({
      version: 2,
      settings: {
        accentColor: '#123456',
        openAiImageApi: { baseUrl: 'https://image.example' },
        chaomoImageApi: { baseUrl: 'https://chaomo.example' },
        customImageApis: [
          { id: 'custom-1', baseUrl: 'https://custom.example' },
        ],
        textApis: [
          { id: 'text-1', baseUrl: 'https://text.example' },
        ],
        videoApis: [
          { id: 'video-1', baseUrl: 'https://video.example' },
        ],
        externalAgentConnection: {
          enabled: true,
          url: 'http://127.0.0.1:17372',
        },
        webDav: {
          baseUrl: 'https://dav.example',
        },
      },
    });
  });
});
