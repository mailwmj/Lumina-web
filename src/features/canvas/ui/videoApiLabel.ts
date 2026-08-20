import type { VideoApiConfig } from '@/stores/settingsStore';

/** Compact labels distinguish the selected Seedance model and configured provider. */
export function getVideoApiControlLabel(
  api: Pick<VideoApiConfig, 'name' | 'modelId'>
): string {
  const modelId = api.modelId.toLowerCase();
  const providerName = api.name.trim();
  let modelLabel: string;

  if (modelId.includes('doubao-seedance-2-0-fast')) {
    modelLabel = 'SD2F';
  } else if (modelId.includes('doubao-seedance-2-0')) {
    modelLabel = 'SD2.0';
  } else {
    modelLabel = api.modelId;
  }

  return providerName ? `${modelLabel}(${providerName})` : modelLabel;
}
