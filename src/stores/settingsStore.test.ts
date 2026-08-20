import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXTERNAL_AGENT_URL,
  DEFAULT_TEXT_POLISH_PROMPT,
  PRESET_VIDEO_APIS,
  createPromptPolishConfig,
  migrateSettingsState,
  normalizePromptPolishConfig,
  normalizeExternalAgentConnectionConfig,
} from './settingsStore';

describe('prompt polishing settings', () => {
  it('ships only Seedance 2.0 series video API presets', () => {
    expect(PRESET_VIDEO_APIS).not.toHaveLength(0);
    expect(PRESET_VIDEO_APIS.every((api) => api.modelId.includes('seedance-2-0'))).toBe(true);
  });

  it('creates an independent empty selection for a new profile', () => {
    expect(createPromptPolishConfig('template')).toEqual({
      textApiId: null,
      textModelId: null,
      reasoningEffort: null,
      prompt: 'template',
    });
  });

  it('keeps an explicit API and model reference without relying on API enabled state', () => {
    expect(normalizePromptPolishConfig({
      textApiId: 'provider-b',
      textModelId: 'model-b',
      reasoningEffort: 'high',
      prompt: 'Keep the meaning.',
    }, DEFAULT_TEXT_POLISH_PROMPT)).toEqual({
      textApiId: 'provider-b',
      textModelId: 'model-b',
      reasoningEffort: 'high',
      prompt: 'Keep the meaning.',
    });
  });

  it('uses safe defaults for malformed persisted values', () => {
    expect(normalizePromptPolishConfig({
      textApiId: '  ',
      textModelId: 42,
      reasoningEffort: 'unsupported',
    }, 'fallback template')).toEqual({
      textApiId: null,
      textModelId: null,
      reasoningEffort: null,
      prompt: 'fallback template',
    });
  });

  it('migrates the legacy shared selection into image and text profiles', () => {
    const migrated = migrateSettingsState({
      textApis: [{
        id: 'legacy-provider',
        name: 'Legacy Provider',
        apiKey: 'key',
        baseUrl: 'https://legacy.example/v1',
        modelId: 'legacy-model',
        selectedModelIds: ['legacy-model'],
        enabled: true,
      }],
      textPolishReasoningEffort: 'high',
      imagePolishPrompt: 'legacy image template',
    }, 24) as {
      imagePolishConfig: unknown;
      textPolishConfig: unknown;
    };

    expect(migrated.imagePolishConfig).toEqual({
      textApiId: 'legacy-provider',
      textModelId: 'legacy-model',
      reasoningEffort: 'high',
      prompt: 'legacy image template',
    });
    expect(migrated.textPolishConfig).toMatchObject({
      textApiId: 'legacy-provider',
      textModelId: 'legacy-model',
      reasoningEffort: 'high',
      prompt: DEFAULT_TEXT_POLISH_PROMPT,
    });
  });

  it('defaults existing custom image providers to the OpenAI Images protocol', () => {
    const migrated = migrateSettingsState({
      customImageApis: [{
        id: 'custom-openai:legacy',
        name: 'Legacy Gateway',
        apiKey: 'key',
        baseUrl: 'https://legacy.example/v1',
        modelCatalog: null,
        selectedModelIds: [],
      }],
    }, 25) as {
      customImageApis: Array<{ protocol: string }>;
    };

    expect(migrated.customImageApis[0]?.protocol).toBe('openai-images');
  });

  it('upgrades legacy FHL providers without changing their configured identity or models', () => {
    const providerId = 'custom-openai:fhl';
    const modelId = `${providerId}/gpt-image-2`;
    const migrated = migrateSettingsState({
      customImageApis: [{
        id: providerId,
        name: 'fhl',
        protocol: 'openai-images',
        apiKey: 'key',
        baseUrl: 'https://www.fhl.mom/v1',
        modelCatalog: {
          models: [{ id: modelId }],
          refreshedAt: 1,
        },
        selectedModelIds: [modelId],
      }],
      lastImageModelSelection: { providerId, modelId },
    }, 27) as {
      customImageApis: Array<{
        id: string;
        protocol: string;
        apiKey: string;
        baseUrl: string;
        selectedModelIds: string[];
      }>;
      lastImageModelSelection: { providerId: string; modelId: string } | null;
    };

    expect(migrated.customImageApis).toHaveLength(1);
    expect(migrated.customImageApis[0]).toMatchObject({
      id: providerId,
      protocol: 'fhl-images',
      apiKey: 'key',
      baseUrl: 'https://www.fhl.mom/v1',
      selectedModelIds: [modelId],
    });
    expect(migrated.lastImageModelSelection).toEqual({ providerId, modelId });
  });

  it('fills the default endpoint for persisted FHL configurations', () => {
    const migrated = migrateSettingsState({
      customImageApis: [{
        id: 'custom-openai:fhl',
        name: 'FHL',
        protocol: 'fhl-images',
        apiKey: 'key',
        baseUrl: '',
        modelCatalog: null,
        selectedModelIds: [],
      }],
    }, 27) as {
      customImageApis: Array<{ baseUrl: string }>;
    };

    expect(migrated.customImageApis[0]?.baseUrl).toBe('https://www.fhl.mom');
  });

  it('keeps only valid persisted image-generation defaults', () => {
    const migrated = migrateSettingsState({
      lastImageGenerationOptions: {
        size: '4K',
        requestAspectRatio: '3:4',
        outputCount: 2,
        extraParams: {
          thinking_level: 'high',
          enable_search: true,
          invalid: { nested: true },
        },
        storyboardGridRows: 3,
        storyboardGridCols: 4,
        storyboardRatioControlMode: 'overall',
      },
    }, 26) as {
      lastImageGenerationOptions: unknown;
    };

    expect(migrated.lastImageGenerationOptions).toEqual({
      size: '4K',
      requestAspectRatio: '3:4',
      outputCount: 2,
      extraParams: {
        thinking_level: 'high',
        enable_search: true,
      },
      storyboardGridRows: 3,
      storyboardGridCols: 4,
      storyboardRatioControlMode: 'overall',
    });
  });

  it('persists only the batch AI model and resolution selection', () => {
    const migrated = migrateSettingsState({
      lastBatchAiFillSelection: {
        modelId: '  provider/edit-model  ',
        resolution: '  2K  ',
        prompt: 'must not be persisted',
      },
    }, 29) as {
      lastBatchAiFillSelection: unknown;
    };

    expect(migrated.lastBatchAiFillSelection).toEqual({
      modelId: 'provider/edit-model',
      resolution: '2K',
    });
  });

  it('normalizes persisted video APIs to the Volcengine Seedance-compatible protocol', () => {
    const migrated = migrateSettingsState({
      videoApis: [{
        id: ' yunxin-seedance ',
        name: ' NetEase Yunxin ',
        apiKey: ' yunxin-key ',
        baseUrl: ' https://ai.yunxinapi.com/hub/volcengine ',
        modelId: ' doubao-seedance-2-0-260128 ',
        enabled: true,
      }],
    }, 30) as {
      videoApis: Array<{
        id: string;
        apiKey: string;
        baseUrl: string;
        modelId: string;
        protocol?: string;
      }>;
    };

    expect(migrated.videoApis.find((api) => api.id === 'yunxin-seedance')).toMatchObject({
      apiKey: 'yunxin-key',
      baseUrl: 'https://ai.yunxinapi.com/hub/volcengine',
      modelId: 'doubao-seedance-2-0-260128',
      protocol: 'volcengine-seedance',
    });
  });

  it('keeps an edited preset instead of adding a second configuration with its original model', () => {
    const editedPreset = {
      ...PRESET_VIDEO_APIS[0],
      modelId: 'doubao-seedance-2-0-260201',
    };
    const migrated = migrateSettingsState({
      videoApis: [editedPreset, PRESET_VIDEO_APIS[1]],
    }, 31) as {
      videoApis: Array<{ id: string; modelId: string }>;
    };

    expect(migrated.videoApis).toHaveLength(PRESET_VIDEO_APIS.length);
    expect(migrated.videoApis.find((api) => api.id === editedPreset.id)).toMatchObject({
      modelId: 'doubao-seedance-2-0-260201',
    });
  });
});

describe('external Agent connection settings', () => {
  it('keeps an authenticated loopback endpoint', () => {
    expect(normalizeExternalAgentConnectionConfig({
      enabled: true,
      url: 'http://127.0.0.1:19000/',
      token: '  local-token  ',
    })).toEqual({
      enabled: true,
      url: 'http://127.0.0.1:19000',
      token: 'local-token',
    });
  });

  it('does not persist a remote bridge endpoint', () => {
    expect(normalizeExternalAgentConnectionConfig({
      enabled: true,
      url: 'https://agent.example.com',
      token: 'local-token',
    })).toEqual({
      enabled: false,
      url: DEFAULT_EXTERNAL_AGENT_URL,
      token: 'local-token',
    });
  });

  it('rejects loopback URLs with path, query, or fragment routing', () => {
    expect(normalizeExternalAgentConnectionConfig({
      enabled: true,
      url: 'http://127.0.0.1:19000/proxy?token=unsafe#bridge',
      token: 'local-token',
    })).toEqual({
      enabled: false,
      url: DEFAULT_EXTERNAL_AGENT_URL,
      token: 'local-token',
    });
  });
});
