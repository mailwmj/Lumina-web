import { describe, expect, it } from 'vitest';

import { normalizeTextApiConfigs, type TextApiConfig } from '@/stores/settingsStore';
import {
  listConfiguredTextModels,
  resolveEnabledTextModelSelection,
  resolveTextModelSelection,
} from './textModelSelection';

function textApi(overrides: Partial<TextApiConfig> = {}): TextApiConfig {
  return {
    id: 'gateway-a',
    name: 'Gateway A',
    apiKey: 'test-key',
    baseUrl: 'https://gateway.example/v1',
    modelId: 'model-a',
    modelCatalog: null,
    selectedModelIds: ['model-a', 'model-b'],
    enabled: false,
    ...overrides,
  };
}

describe('text model selection', () => {
  it('migrates a legacy single-model API into the node model catalog', () => {
    expect(normalizeTextApiConfigs([{
      id: 'legacy',
      name: 'Legacy API',
      apiKey: 'key',
      baseUrl: 'https://legacy.example/v1',
      modelId: 'legacy-model',
      enabled: true,
    }])).toEqual([{
      id: 'legacy',
      name: 'Legacy API',
      apiKey: 'key',
      baseUrl: 'https://legacy.example/v1',
      modelId: 'legacy-model',
      modelCatalog: null,
      selectedModelIds: ['legacy-model'],
      enabled: true,
    }]);
  });

  it('lists every selected model for every API', () => {
    expect(listConfiguredTextModels([
      textApi(),
      textApi({ id: 'gateway-b', name: 'Gateway B', selectedModelIds: ['model-c'] }),
    ])).toEqual([
      { apiId: 'gateway-a', apiName: 'Gateway A', modelId: 'model-a' },
      { apiId: 'gateway-a', apiName: 'Gateway A', modelId: 'model-b' },
      { apiId: 'gateway-b', apiName: 'Gateway B', modelId: 'model-c' },
    ]);
  });

  it('uses an explicit node model even when its API is not globally enabled', () => {
    const resolved = resolveTextModelSelection([textApi()], 'gateway-a', 'model-b');
    expect(resolved?.modelId).toBe('model-b');
    expect(resolved?.apiConfig.modelId).toBe('model-b');
  });

  it('uses the enabled API default for a legacy node without a selection', () => {
    const resolved = resolveTextModelSelection([
      textApi(),
      textApi({
        id: 'gateway-b',
        name: 'Gateway B',
        modelId: 'model-c',
        selectedModelIds: ['model-c', 'model-d'],
        enabled: true,
      }),
    ]);
    expect(resolved?.apiId).toBe('gateway-b');
    expect(resolved?.modelId).toBe('model-c');
  });

  it('requires an explicitly enabled API for media prompt polishing', () => {
    expect(resolveEnabledTextModelSelection([textApi()])).toBeNull();
    const resolved = resolveEnabledTextModelSelection([textApi({ enabled: true })]);
    expect(resolved?.modelId).toBe('model-a');
  });

  it('does not silently replace an explicit model that is no longer configured', () => {
    expect(resolveTextModelSelection([textApi()], 'gateway-a', 'removed-model')).toBeNull();
  });

  it('supports legacy configs that only have modelId at runtime', () => {
    const legacy = textApi({ selectedModelIds: [] });
    expect(listConfiguredTextModels([legacy])).toEqual([
      { apiId: 'gateway-a', apiName: 'Gateway A', modelId: 'model-a' },
    ]);
  });
});
