import { OPENAI_IMAGE_PROVIDER_ID } from './providers/openai';

export const FHL_IMAGE_PROVIDER_ID = 'fhl';
export const FHL_IMAGE_DEFAULT_BASE_URL = 'https://www.fhl.mom';
export const CUSTOM_IMAGE_PROTOCOLS = [
  'openai-images', 'fhl-images', 'gemini-native', 'fal', 'grsai', 'kie', 'runninghub', 'bltcy', 'ppio',
] as const;
export type CustomImageProtocol = (typeof CUSTOM_IMAGE_PROTOCOLS)[number];

export const DEFAULT_CUSTOM_IMAGE_PROTOCOL: CustomImageProtocol = 'openai-images';
export const GEMINI_NATIVE_IMAGE_PROVIDER_ID = 'gemini';

export interface CustomImageProtocolDefinition {
  id: CustomImageProtocol;
  backendProviderId: string;
  labelKey: string;
  summaryKey: string;
  baseUrlPlaceholder: string;
  modelIdPlaceholder: string;
}

const CUSTOM_IMAGE_PROTOCOL_DEFINITIONS: Record<
  CustomImageProtocol,
  CustomImageProtocolDefinition
> = {
  'openai-images': {
    id: 'openai-images',
    backendProviderId: OPENAI_IMAGE_PROVIDER_ID,
    labelKey: 'settings.customImageProtocolOpenAiImages',
    summaryKey: 'settings.customImageProtocolOpenAiImagesSummary',
    baseUrlPlaceholder: 'https://api.example.com/v1',
    modelIdPlaceholder: 'gpt-image-1',
  },
  'fhl-images': {
    id: 'fhl-images',
    backendProviderId: FHL_IMAGE_PROVIDER_ID,
    labelKey: 'settings.customImageProtocolFhlImages',
    summaryKey: 'settings.customImageProtocolFhlImagesSummary',
    baseUrlPlaceholder: FHL_IMAGE_DEFAULT_BASE_URL,
    modelIdPlaceholder: 'gpt-image-2',
  },
  'gemini-native': {
    id: 'gemini-native',
    backendProviderId: GEMINI_NATIVE_IMAGE_PROVIDER_ID,
    labelKey: 'settings.customImageProtocolGeminiNative',
    summaryKey: 'settings.customImageProtocolGeminiNativeSummary',
    baseUrlPlaceholder: 'https://api.example.com/v1beta',
    modelIdPlaceholder: 'gemini-3-pro-image-preview',
  },
  fal: {
    id: 'fal', backendProviderId: 'fal', labelKey: 'settings.customImageProtocolFal',
    summaryKey: 'settings.customImageProtocolFalSummary', baseUrlPlaceholder: 'https://queue.fal.run', modelIdPlaceholder: 'nano-banana-2',
  },
  grsai: {
    id: 'grsai', backendProviderId: 'grsai', labelKey: 'settings.customImageProtocolGrsai',
    summaryKey: 'settings.customImageProtocolGrsaiSummary', baseUrlPlaceholder: 'https://grsai.dakka.com.cn', modelIdPlaceholder: 'nano-banana-2',
  },
  kie: {
    id: 'kie', backendProviderId: 'kie', labelKey: 'settings.customImageProtocolKie',
    summaryKey: 'settings.customImageProtocolKieSummary', baseUrlPlaceholder: 'https://api.kie.ai', modelIdPlaceholder: 'nano-banana-2',
  },
  runninghub: {
    id: 'runninghub', backendProviderId: 'runninghub', labelKey: 'settings.customImageProtocolRunningHub',
    summaryKey: 'settings.customImageProtocolRunningHubSummary', baseUrlPlaceholder: 'https://www.runninghub.cn/openapi/v2', modelIdPlaceholder: 'rhart-image-n-g31-flash',
  },
  bltcy: {
    id: 'bltcy', backendProviderId: 'bltcy', labelKey: 'settings.customImageProtocolBltcy',
    summaryKey: 'settings.customImageProtocolBltcySummary', baseUrlPlaceholder: 'https://api.bltcy.ai', modelIdPlaceholder: 'nano-banana',
  },
  ppio: {
    id: 'ppio', backendProviderId: 'ppio', labelKey: 'settings.customImageProtocolPpio',
    summaryKey: 'settings.customImageProtocolPpioSummary', baseUrlPlaceholder: 'https://api.ppio.com', modelIdPlaceholder: 'gemini-3.1-flash',
  },
};

export function isCustomImageProtocol(value: unknown): value is CustomImageProtocol {
  return typeof value === 'string' && CUSTOM_IMAGE_PROTOCOLS.includes(value as CustomImageProtocol);
}

export function normalizeCustomImageProtocol(value: unknown): CustomImageProtocol {
  if (value === 'fhl') {
    return 'fhl-images';
  }
  return isCustomImageProtocol(value) ? value : DEFAULT_CUSTOM_IMAGE_PROTOCOL;
}

export function getCustomImageProtocolDefinition(
  protocol: CustomImageProtocol
): CustomImageProtocolDefinition {
  return CUSTOM_IMAGE_PROTOCOL_DEFINITIONS[protocol];
}

export function isFhlImageBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl.trim()).hostname.toLowerCase();
    return hostname === 'www.fhl.mom' || hostname === 'fhl.mom';
  } catch {
    return false;
  }
}

export function migrateCustomImageBaseUrlForProtocolChange(
  baseUrl: string,
  fromProtocol: CustomImageProtocol,
  toProtocol: CustomImageProtocol
): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return toProtocol === 'fhl-images' ? FHL_IMAGE_DEFAULT_BASE_URL : trimmed;
  }
  if (fromProtocol === toProtocol) {
    return trimmed;
  }

  const normalized = trimmed.replace(/\/+$/, '');

  const fromSuffix = fromProtocol === 'gemini-native' ? '/v1beta' : '/v1';
  const toSuffix = toProtocol === 'gemini-native' ? '/v1beta' : '/v1';
  if (!normalized.endsWith(fromSuffix)) {
    return trimmed;
  }

  return `${normalized.slice(0, -fromSuffix.length)}${toSuffix}`;
}

export function normalizeCustomImageRemoteModelId(
  protocol: CustomImageProtocol,
  modelId: string
): string {
  let normalized = modelId.trim();
  if (protocol === 'fhl-images') {
    while (normalized.startsWith('fhl/')) {
      normalized = normalized.slice('fhl/'.length);
    }
  }
  if (!['gemini-native'].includes(protocol)) {
    const providerPrefix = `${protocol}/`;
    while (normalized.startsWith(providerPrefix)) normalized = normalized.slice(providerPrefix.length);
    return normalized;
  }

  while (normalized.startsWith('models/') || normalized.startsWith('gemini/')) {
    normalized = normalized.startsWith('models/')
      ? normalized.slice('models/'.length)
      : normalized.slice('gemini/'.length);
  }
  return normalized;
}

export function toCustomImageRequestModel(
  protocol: CustomImageProtocol,
  remoteModelId: string
): string {
  const normalized = normalizeCustomImageRemoteModelId(protocol, remoteModelId);
  return `${getCustomImageProtocolDefinition(protocol).backendProviderId}/${normalized}`;
}
