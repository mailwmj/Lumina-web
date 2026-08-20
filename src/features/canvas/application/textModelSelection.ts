import type { TextApiConfig } from '@/stores/settingsStore';

export interface ConfiguredTextModel {
  apiId: string;
  apiName: string;
  modelId: string;
}

export interface ResolvedTextModelSelection extends ConfiguredTextModel {
  apiConfig: TextApiConfig;
}

function candidateModelIds(api: TextApiConfig): string[] {
  const selectedModelIds = Array.isArray(api.selectedModelIds)
    ? api.selectedModelIds.map((modelId) => modelId.trim()).filter(Boolean)
    : [];
  if (selectedModelIds.length > 0) {
    return Array.from(new Set(selectedModelIds));
  }

  const legacyModelId = api.modelId.trim();
  return legacyModelId ? [legacyModelId] : [];
}

export function listConfiguredTextModels(textApis: TextApiConfig[]): ConfiguredTextModel[] {
  return textApis.flatMap((api) => candidateModelIds(api).map((modelId) => ({
    apiId: api.id,
    apiName: api.name || api.id,
    modelId,
  })));
}

export function resolveTextModelSelection(
  textApis: TextApiConfig[],
  textApiId?: string,
  textModelId?: string
): ResolvedTextModelSelection | null {
  const requestedApiId = textApiId?.trim() ?? '';
  const requestedModelId = textModelId?.trim() ?? '';

  if (requestedApiId || requestedModelId) {
    if (!requestedApiId || !requestedModelId) {
      return null;
    }
    const api = textApis.find((candidate) => candidate.id === requestedApiId);
    if (!api || !candidateModelIds(api).includes(requestedModelId)) {
      return null;
    }
    return {
      apiId: api.id,
      apiName: api.name || api.id,
      modelId: requestedModelId,
      apiConfig: { ...api, modelId: requestedModelId },
    };
  }

  const enabledApi = textApis.find((api) => api.enabled && candidateModelIds(api).length > 0);
  const fallbackApi = enabledApi ?? textApis.find((api) => candidateModelIds(api).length > 0);
  if (!fallbackApi) {
    return null;
  }

  const candidates = candidateModelIds(fallbackApi);
  const modelId = candidates.includes(fallbackApi.modelId.trim())
    ? fallbackApi.modelId.trim()
    : candidates[0];
  return {
    apiId: fallbackApi.id,
    apiName: fallbackApi.name || fallbackApi.id,
    modelId,
    apiConfig: { ...fallbackApi, modelId },
  };
}

export function resolveEnabledTextModelSelection(
  textApis: TextApiConfig[]
): ResolvedTextModelSelection | null {
  const enabledApi = textApis.find((api) => api.enabled);
  if (!enabledApi) {
    return null;
  }

  const candidates = candidateModelIds(enabledApi);
  if (candidates.length === 0) {
    return null;
  }
  const modelId = candidates.includes(enabledApi.modelId.trim())
    ? enabledApi.modelId.trim()
    : candidates[0];
  return {
    apiId: enabledApi.id,
    apiName: enabledApi.name || enabledApi.id,
    modelId,
    apiConfig: { ...enabledApi, modelId },
  };
}
