import type { VideoApiConfig } from '@/stores/settingsStore';

/**
 * Resolves the settings entry that owns a video task. New nodes persist the
 * configuration ID; model matching remains only for projects created before
 * that field existed.
 */
export function resolveVideoApiConfig(
  videoApis: VideoApiConfig[],
  videoApiId: string | null | undefined,
  modelId: string | null | undefined
): VideoApiConfig | undefined {
  const normalizedApiId = videoApiId?.trim();
  if (normalizedApiId) {
    return videoApis.find((api) => api.id === normalizedApiId);
  }

  const normalizedModelId = modelId?.trim();
  return normalizedModelId
    ? videoApis.find((api) => api.modelId === normalizedModelId)
    : undefined;
}
