import { expect, it } from 'vitest';

import { migrateSettingsState } from '@/features/settings/application/settingsMigration';
import { createSettingsRepository } from '@/features/settings/application/settingsRepository';
import { SETTINGS_SCHEMA_VERSION } from '@/features/settings/domain/settingsRepository';
import { createDefaultSettingsData } from '@/features/settings/domain/settingsSchema';
import { createLocalStorageSettingsStorage } from './localStorageSettingsRepository';

function createStorage(snapshot: unknown) {
  const values = new Map<string, string>([
    ['settings-storage', JSON.stringify(snapshot)],
  ]);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

it('reads the existing settings-storage snapshot through SettingsRepository', async () => {
  const storage = createStorage({
    state: { accentColor: '#123456' },
    version: 31,
  });
  const repository = createSettingsRepository(
    createLocalStorageSettingsStorage(storage),
    {
      currentVersion: 31,
      createDefaultState: () => ({ accentColor: '#9DE500' }),
      migrateState: (state) => state as { accentColor: string },
    }
  );

  await expect(repository.read()).resolves.toEqual({
    state: { accentColor: '#123456' },
    version: 31,
  });
});

it('hydrates the legacy model selections through the current settings schema', async () => {
  const storage = createStorage({
    version: 24,
    state: {
      openAiImageApi: {
        apiKey: 'image-key',
        baseUrl: 'https://image.example/v1',
        modelCatalog: {
          models: [{ id: 'gpt-image-1' }],
          refreshedAt: 1,
        },
        selectedModelIds: ['gpt-image-1'],
      },
      lastImageModelSelection: {
        providerId: 'ai-media',
        modelId: 'gpt-image-1',
      },
      textApis: [{
        id: 'legacy-text',
        name: 'Legacy Text',
        apiKey: 'text-key',
        baseUrl: 'https://text.example/v1',
        modelId: 'text-model',
        selectedModelIds: ['text-model'],
        enabled: true,
      }],
      textPolishReasoningEffort: 'high',
      imagePolishPrompt: 'legacy image prompt',
      videoApis: [{
        id: 'legacy-video',
        name: 'Legacy Video',
        apiKey: 'video-key',
        baseUrl: 'https://video.example/v1',
        modelId: 'video-model',
        enabled: true,
      }],
    },
  });
  const repository = createSettingsRepository(
    createLocalStorageSettingsStorage(storage),
    {
      currentVersion: SETTINGS_SCHEMA_VERSION,
      createDefaultState: createDefaultSettingsData,
      migrateState: migrateSettingsState,
    }
  );

  const snapshot = await repository.read();

  expect(snapshot?.version).toBe(SETTINGS_SCHEMA_VERSION);
  expect(snapshot?.state).toMatchObject({
    openAiImageApi: {
      apiKey: 'image-key',
      selectedModelIds: ['gpt-image-1'],
    },
    lastImageModelSelection: {
      providerId: 'ai-media',
      modelId: 'gpt-image-1',
    },
    textApis: [{
      id: 'legacy-text',
      modelId: 'text-model',
      selectedModelIds: ['text-model'],
    }],
    imagePolishConfig: {
      textApiId: 'legacy-text',
      textModelId: 'text-model',
      reasoningEffort: 'high',
      prompt: 'legacy image prompt',
    },
  });
  expect(snapshot?.state.videoApis).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: 'legacy-video',
      modelId: 'video-model',
    }),
  ]));
});

it('removes retired additional image provider presets during migration', async () => {
  const storage = createStorage({
    version: 31,
    state: {
      additionalImageApis: [{
        id: 'kie',
        name: 'KIE',
        protocol: 'kie',
        apiKey: 'legacy-key',
        baseUrl: 'https://api.kie.ai',
        modelCatalog: null,
        selectedModelIds: ['kie/nano-banana-2'],
      }],
    },
  });
  const repository = createSettingsRepository(
    createLocalStorageSettingsStorage(storage),
    {
      currentVersion: SETTINGS_SCHEMA_VERSION,
      createDefaultState: createDefaultSettingsData,
      migrateState: migrateSettingsState,
    }
  );

  const snapshot = await repository.read();

  expect(snapshot?.state.additionalImageApis).toEqual([]);
});
