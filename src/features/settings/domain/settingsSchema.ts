import {
  TEXT_REASONING_EFFORTS,
  type TextReasoningEffort,
} from '@/features/canvas/models/types';
import {
  IMAGE_OUTPUT_COUNTS,
  IMAGE_SIZES,
  type ImageOutputCount,
  type ImageSize,
  type StoryboardRatioControlMode,
} from '@/features/canvas/domain/canvasNodes';
import {
  DEFAULT_CUSTOM_IMAGE_PROTOCOL,
  FHL_IMAGE_DEFAULT_BASE_URL,
  isFhlImageBaseUrl,
  normalizeCustomImageProtocol,
  type CustomImageProtocol,
} from '@/features/canvas/models/imageProviderProtocols';

import {
  DEFAULT_IMAGE_POLISH_PROMPT,
  DEFAULT_TEXT_POLISH_PROMPT,
  PRESET_TEXT_APIS,
  PRESET_VIDEO_APIS,
  createPromptPolishConfig,
} from './settingsDefaults';

export * from './settingsDefaults';

export const DEFAULT_ACCENT_COLOR = '#9DE500';
export type CanvasEdgeRoutingMode = 'spline' | 'orthogonal' | 'smartOrthogonal';
export const DEFAULT_EXTERNAL_AGENT_URL = 'http://127.0.0.1:17372';

export interface ExternalAgentConnectionConfig {
  enabled: boolean;
  url: string;
  token: string;
}

export function createDefaultExternalAgentConnectionConfig(): ExternalAgentConnectionConfig {
  return {
    enabled: false,
    url: DEFAULT_EXTERNAL_AGENT_URL,
    token: '',
  };
}

export function normalizeExternalAgentConnectionConfig(
  input: unknown
): ExternalAgentConnectionConfig {
  const defaults = createDefaultExternalAgentConnectionConfig();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return defaults;
  }
  const record = input as Record<string, unknown>;
  const url = normalizeExternalAgentUrl(record.url);
  return {
    enabled: record.enabled === true && url !== null,
    url: url ?? defaults.url,
    token: typeof record.token === 'string' ? record.token.trim() : '',
  };
}

export function normalizeExternalAgentUrl(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  try {
    const url = new URL(input.trim());
    if (
      url.protocol !== 'http:'
      || url.hostname !== '127.0.0.1'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
export type BuiltInImageProviderId = 'ai-media' | 'chaomo';
export const CUSTOM_IMAGE_PROVIDER_ID_PREFIX = 'custom-openai:';
export type CustomImageProviderId = `${typeof CUSTOM_IMAGE_PROVIDER_ID_PREFIX}${string}`;
export type ImageProviderId = BuiltInImageProviderId | CustomImageProviderId;

export const DEFAULT_OPENAI_IMAGE_BASE_URL = 'https://api.ai-media.vip/v1';
export const DEFAULT_CHAOMO_IMAGE_BASE_URL = 'https://www.chaomoapi.com/v1';

export interface DiscoveredImageModel {
  id: string;
  label?: string;
}

export interface ImageModelCatalog {
  models: DiscoveredImageModel[];
  refreshedAt: number;
}

export interface ImageModelSelection {
  providerId: string;
  modelId: string;
}

export interface BatchAiFillSelection {
  modelId: string;
  resolution: string;
}

export type ImageGenerationExtraParamValue = boolean | number | string;

/**
 * User-level defaults applied only when a new image or storyboard generation
 * node is created. Prompt, references, frames, and generated assets remain
 * node-local creative content.
 */
export interface LastImageGenerationOptions {
  size?: ImageSize;
  requestAspectRatio?: string;
  outputCount?: ImageOutputCount;
  extraParams?: Record<string, ImageGenerationExtraParamValue>;
  storyboardGridRows?: number;
  storyboardGridCols?: number;
  storyboardRatioControlMode?: StoryboardRatioControlMode;
}

export type LastImageGenerationOptionsPatch = Omit<
  Partial<LastImageGenerationOptions>,
  'extraParams'
> & {
  extraParams?: Record<string, unknown>;
};

export interface TextGenerationModelSelection {
  apiId: string;
  modelId: string;
}

/**
 * A persisted reference to a configured text API and model used for prompt
 * polishing. It deliberately stores no credentials: the selected API remains
 * the single source of truth for connection details.
 */
export interface PromptPolishConfig {
  textApiId: string | null;
  textModelId: string | null;
  reasoningEffort: TextReasoningEffort | null;
  prompt: string;
}

export interface ImageProviderApiConfig {
  apiKey: string;
  baseUrl: string;
  modelCatalog: ImageModelCatalog | null;
  selectedModelIds: string[];
}

export type OpenAiImageApiConfig = ImageProviderApiConfig;
export type ChaomoImageApiConfig = ImageProviderApiConfig;

export interface CustomImageApiConfig extends ImageProviderApiConfig {
  id: CustomImageProviderId;
  name: string;
  protocol: CustomImageProtocol;
}

export function isCustomImageProviderId(providerId: string): providerId is CustomImageProviderId {
  return providerId.startsWith(CUSTOM_IMAGE_PROVIDER_ID_PREFIX)
    && providerId.length > CUSTOM_IMAGE_PROVIDER_ID_PREFIX.length;
}

export function createCustomImageApiConfig(
  id: CustomImageProviderId = `${CUSTOM_IMAGE_PROVIDER_ID_PREFIX}${crypto.randomUUID()}`
): CustomImageApiConfig {
  return {
    id,
    name: '',
    protocol: DEFAULT_CUSTOM_IMAGE_PROTOCOL,
    apiKey: '',
    baseUrl: '',
    modelCatalog: null,
    selectedModelIds: [],
  };
}

export function createDefaultOpenAiImageApiConfig(): OpenAiImageApiConfig {
  return {
    apiKey: '',
    baseUrl: DEFAULT_OPENAI_IMAGE_BASE_URL,
    modelCatalog: null,
    selectedModelIds: [],
  };
}

export function createDefaultChaomoImageApiConfig(): ChaomoImageApiConfig {
  return {
    apiKey: '',
    baseUrl: DEFAULT_CHAOMO_IMAGE_BASE_URL,
    modelCatalog: null,
    selectedModelIds: [],
  };
}

export interface TextApiConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  modelCatalog: ImageModelCatalog | null;
  selectedModelIds: string[];
  enabled: boolean;
}

export interface VideoApiConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  /** Runtime protocol used by this video endpoint. */
  protocol?: 'volcengine-seedance';
  polishPrompt?: string;
  defaultPolishPrompt?: string;
}

export function normalizeVideoApiConfigs(input: unknown): VideoApiConfig[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seenIds = new Set<string>();
  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seenIds.has(id)) {
      return [];
    }
    seenIds.add(id);

    return [{
      id,
      name: typeof record.name === 'string' ? record.name.trim() : '',
      apiKey: normalizeApiKey(typeof record.apiKey === 'string' ? record.apiKey : ''),
      baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '',
      modelId: typeof record.modelId === 'string' ? record.modelId.trim() : '',
      enabled: record.enabled === true,
      protocol: 'volcengine-seedance',
      ...(typeof record.polishPrompt === 'string' ? { polishPrompt: record.polishPrompt } : {}),
      ...(typeof record.defaultPolishPrompt === 'string'
        ? { defaultPolishPrompt: record.defaultPolishPrompt }
        : {}),
    }];
  });
}

/**
 * 合并视频API配置，确保所有预设模型都存在
 * 保留用户已添加的自定义API，同时添加缺失的预设模型
 */
export function mergeVideoApis(existingApis?: VideoApiConfig[]): VideoApiConfig[] {
  const normalizedApis = normalizeVideoApiConfigs(existingApis);
  if (normalizedApis.length === 0) {
    return PRESET_VIDEO_APIS;
  }

  // Preset membership is defined by the stable configuration ID. Model IDs are user-editable.
  const existingIds = new Set(normalizedApis.map((api) => api.id));

  // 找出缺失的预设配置
  const missingPresets = PRESET_VIDEO_APIS.filter(
    (preset) => !existingIds.has(preset.id)
  );

  // 如果有缺失的预设配置，合并它们
  if (missingPresets.length > 0) {
    return [...normalizedApis, ...missingPresets];
  }

  return normalizedApis;
}

export interface SettingsData {
  openAiImageApi: OpenAiImageApiConfig;
  chaomoImageApi: ChaomoImageApiConfig;
  customImageApis: CustomImageApiConfig[];
  downloadPresetPaths: string[];
  useUploadFilenameAsNodeTitle: boolean;
  storyboardGenKeepStyleConsistent: boolean;
  storyboardGenDisableTextInImage: boolean;
  storyboardGenAutoInferEmptyFrame: boolean;
  ignoreAtTagWhenCopyingAndGenerating: boolean;
  enableStoryboardGenGridPreviewShortcut: boolean;
  showStoryboardGenAdvancedRatioControls: boolean;
  accentColor: string;
  canvasEdgeRoutingMode: CanvasEdgeRoutingMode;
  snapToGridEnabled: boolean;
  snapGridSize: number;
  autoCheckAppUpdateOnLaunch: boolean;
  enableUpdateDialog: boolean;
  externalAgentConnection: ExternalAgentConnectionConfig;
  textApis: TextApiConfig[];
  activeTextApiId: string | null;
  imagePolishConfig: PromptPolishConfig;
  textPolishConfig: PromptPolishConfig;
  videoApis: VideoApiConfig[];
  activeVideoApiId: string | null;
  lastImageModelSelection: ImageModelSelection | null;
  lastBatchAiFillSelection: BatchAiFillSelection | null;
  lastImageGenerationOptions: LastImageGenerationOptions;
  lastTextGenerationModelSelection: TextGenerationModelSelection | null;
}

export function createDefaultSettingsData(): SettingsData {
  return {
    openAiImageApi: createDefaultOpenAiImageApiConfig(),
    chaomoImageApi: createDefaultChaomoImageApiConfig(),
    customImageApis: [],
    downloadPresetPaths: [],
    useUploadFilenameAsNodeTitle: true,
    storyboardGenKeepStyleConsistent: true,
    storyboardGenDisableTextInImage: true,
    storyboardGenAutoInferEmptyFrame: true,
    ignoreAtTagWhenCopyingAndGenerating: true,
    enableStoryboardGenGridPreviewShortcut: false,
    showStoryboardGenAdvancedRatioControls: false,
    accentColor: DEFAULT_ACCENT_COLOR,
    canvasEdgeRoutingMode: 'spline',
    snapToGridEnabled: false,
    snapGridSize: 72,
    autoCheckAppUpdateOnLaunch: true,
    enableUpdateDialog: true,
    externalAgentConnection: createDefaultExternalAgentConnectionConfig(),
    textApis: PRESET_TEXT_APIS,
    activeTextApiId: null,
    imagePolishConfig: createPromptPolishConfig(DEFAULT_IMAGE_POLISH_PROMPT),
    textPolishConfig: createPromptPolishConfig(DEFAULT_TEXT_POLISH_PROMPT),
    videoApis: PRESET_VIDEO_APIS,
    activeVideoApiId: null,
    lastImageModelSelection: null,
    lastBatchAiFillSelection: null,
    lastImageGenerationOptions: {},
    lastTextGenerationModelSelection: null,
  };
}

export function selectSettingsData(state: SettingsData): SettingsData {
  const keys = Object.keys(createDefaultSettingsData()) as Array<keyof SettingsData>;
  return Object.fromEntries(keys.map((key) => [key, state[key]])) as unknown as SettingsData;
}

function normalizeApiKey(input: string): string {
  return input.trim();
}

function normalizeDiscoveredImageModels(input: unknown): DiscoveredImageModel[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const modelById = new Map<string, DiscoveredImageModel>();
  input.forEach((item) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || modelById.has(id)) {
      return;
    }
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    modelById.set(id, label ? { id, label } : { id });
  });

  return Array.from(modelById.values());
}

function normalizeImageModelCatalog(input: unknown): ImageModelCatalog | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Record<string, unknown>;
  const models = normalizeDiscoveredImageModels(record.models);
  const refreshedAt = typeof record.refreshedAt === 'number' && Number.isFinite(record.refreshedAt)
    ? record.refreshedAt
    : Date.now();

  return { models, refreshedAt };
}

export function normalizeTextApiConfigs(input: unknown): TextApiConfig[] {
  const source = Array.isArray(input) ? input : PRESET_TEXT_APIS;
  const seenIds = new Set<string>();

  return source.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seenIds.has(id)) {
      return [];
    }
    seenIds.add(id);

    const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
    const selectedModelIds = Array.from(new Set([
      ...(Array.isArray(record.selectedModelIds)
        ? record.selectedModelIds
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
        : []),
      ...(modelId ? [modelId] : []),
    ]));
    return [{
      id,
      name: typeof record.name === 'string' ? record.name.trim() : '',
      apiKey: normalizeApiKey(typeof record.apiKey === 'string' ? record.apiKey : ''),
      baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '',
      modelId: modelId || selectedModelIds[0] || '',
      modelCatalog: normalizeImageModelCatalog(record.modelCatalog),
      selectedModelIds,
      enabled: record.enabled === true,
    }];
  });
}

function normalizeSelectedModelIds(input: unknown, catalog: ImageModelCatalog | null): string[] {
  if (!catalog || !Array.isArray(input)) {
    return [];
  }

  const availableIds = new Set(catalog.models.map((model) => model.id));
  return Array.from(
    new Set(
      input
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => availableIds.has(value))
    )
  );
}

export function normalizeOpenAiImageApiConfig(
  input: Partial<OpenAiImageApiConfig> | null | undefined
): OpenAiImageApiConfig {
  const defaults = createDefaultOpenAiImageApiConfig();
  const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const modelCatalog = normalizeImageModelCatalog(input?.modelCatalog);

  return {
    apiKey: normalizeApiKey(input?.apiKey ?? ''),
    baseUrl: baseUrl || defaults.baseUrl,
    modelCatalog,
    selectedModelIds: normalizeSelectedModelIds(input?.selectedModelIds, modelCatalog),
  };
}

export function normalizeChaomoImageApiConfig(
  input: Partial<ChaomoImageApiConfig> | null | undefined
): ChaomoImageApiConfig {
  const defaults = createDefaultChaomoImageApiConfig();
  const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const modelCatalog = normalizeImageModelCatalog(input?.modelCatalog);

  return {
    apiKey: normalizeApiKey(input?.apiKey ?? ''),
    baseUrl: baseUrl || defaults.baseUrl,
    modelCatalog,
    selectedModelIds: normalizeSelectedModelIds(input?.selectedModelIds, modelCatalog),
  };
}

export function normalizeCustomImageApiConfigs(input: unknown): CustomImageApiConfig[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seenIds = new Set<string>();
  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!isCustomImageProviderId(id) || seenIds.has(id)) {
      return [];
    }
    seenIds.add(id);

    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const protocol = normalizeCustomImageProtocol(record.protocol);
    const configuredBaseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '';
    const baseUrl = protocol === 'fhl-images' && !configuredBaseUrl
      ? FHL_IMAGE_DEFAULT_BASE_URL
      : configuredBaseUrl;
    const modelCatalog = normalizeImageModelCatalog(record.modelCatalog);
    return [{
      id,
      name,
      protocol,
      apiKey: normalizeApiKey(typeof record.apiKey === 'string' ? record.apiKey : ''),
      baseUrl,
      modelCatalog,
      selectedModelIds: normalizeSelectedModelIds(record.selectedModelIds, modelCatalog),
    }];
  });
}

export function migrateLegacyFhlImageApiConfigs(
  configs: CustomImageApiConfig[]
): CustomImageApiConfig[] {
  return configs.map((config) => (
    config.protocol === 'openai-images' && isFhlImageBaseUrl(config.baseUrl)
      ? { ...config, protocol: 'fhl-images' }
      : config
  ));
}

export function normalizeImageModelSelection(input: unknown): ImageModelSelection | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Record<string, unknown>;
  const providerId = record.providerId;
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  if (
    (providerId !== 'ai-media'
      && providerId !== 'chaomo'
      && !(typeof providerId === 'string' && isCustomImageProviderId(providerId)))
    || !modelId
  ) {
    return null;
  }
  return { providerId, modelId };
}

export function normalizeBatchAiFillSelection(input: unknown): BatchAiFillSelection | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  const resolution = typeof record.resolution === 'string' ? record.resolution.trim() : '';
  return modelId && resolution ? { modelId, resolution } : null;
}

function normalizeImageGenerationExtraParams(
  input: unknown
): Record<string, ImageGenerationExtraParamValue> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }

  const normalized: Record<string, ImageGenerationExtraParamValue> = {};
  Object.entries(input as Record<string, unknown>).forEach(([key, value]) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }
    if (
      typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
      || typeof value === 'string'
    ) {
      normalized[normalizedKey] = value;
    }
  });
  return normalized;
}

export function normalizeLastImageGenerationOptions(input: unknown): LastImageGenerationOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const record = input as Record<string, unknown>;
  const size = typeof record.size === 'string' && (IMAGE_SIZES as readonly string[]).includes(record.size)
    ? record.size as ImageSize
    : undefined;
  const requestAspectRatio = typeof record.requestAspectRatio === 'string'
    && record.requestAspectRatio.trim()
    ? record.requestAspectRatio.trim()
    : undefined;
  const outputCount = typeof record.outputCount === 'number'
    && (IMAGE_OUTPUT_COUNTS as readonly number[]).includes(record.outputCount)
    ? record.outputCount as ImageOutputCount
    : undefined;
  const storyboardGridRows = typeof record.storyboardGridRows === 'number'
    && Number.isInteger(record.storyboardGridRows)
    && record.storyboardGridRows >= 1
    && record.storyboardGridRows <= 9
    ? record.storyboardGridRows
    : undefined;
  const storyboardGridCols = typeof record.storyboardGridCols === 'number'
    && Number.isInteger(record.storyboardGridCols)
    && record.storyboardGridCols >= 1
    && record.storyboardGridCols <= 9
    ? record.storyboardGridCols
    : undefined;
  const storyboardRatioControlMode = record.storyboardRatioControlMode === 'overall'
    || record.storyboardRatioControlMode === 'cell'
    ? record.storyboardRatioControlMode
    : undefined;
  const extraParams = normalizeImageGenerationExtraParams(record.extraParams);

  return {
    ...(size ? { size } : {}),
    ...(requestAspectRatio ? { requestAspectRatio } : {}),
    ...(outputCount !== undefined ? { outputCount } : {}),
    ...(extraParams ? { extraParams } : {}),
    ...(storyboardGridRows !== undefined ? { storyboardGridRows } : {}),
    ...(storyboardGridCols !== undefined ? { storyboardGridCols } : {}),
    ...(storyboardRatioControlMode ? { storyboardRatioControlMode } : {}),
  };
}

export function normalizeTextGenerationModelSelection(
  input: unknown
): TextGenerationModelSelection | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Record<string, unknown>;
  const apiId = typeof record.apiId === 'string' ? record.apiId.trim() : '';
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  return apiId && modelId ? { apiId, modelId } : null;
}

export function normalizePromptPolishConfig(
  input: unknown,
  defaultPrompt: string
): PromptPolishConfig {
  if (!input || typeof input !== 'object') {
    return createPromptPolishConfig(defaultPrompt);
  }
  const record = input as Record<string, unknown>;
  const textApiId = typeof record.textApiId === 'string' && record.textApiId.trim()
    ? record.textApiId.trim()
    : null;
  const textModelId = typeof record.textModelId === 'string' && record.textModelId.trim()
    ? record.textModelId.trim()
    : null;
  const reasoningEffort = typeof record.reasoningEffort === 'string'
    && TEXT_REASONING_EFFORTS.includes(record.reasoningEffort as TextReasoningEffort)
    ? record.reasoningEffort as TextReasoningEffort
    : null;
  return {
    textApiId,
    textModelId,
    reasoningEffort,
    prompt: typeof record.prompt === 'string' ? record.prompt : defaultPrompt,
  };
}

function resolveLegacyPromptPolishSelection(
  textApis: TextApiConfig[]
): TextGenerationModelSelection | null {
  const api = textApis.find((candidate) => candidate.enabled);
  if (!api) {
    return null;
  }
  const modelIds = api.selectedModelIds.length > 0
    ? api.selectedModelIds
    : api.modelId ? [api.modelId] : [];
  const modelId = modelIds.includes(api.modelId) ? api.modelId : modelIds[0];
  return modelId ? { apiId: api.id, modelId } : null;
}

export function createLegacyImagePolishConfig(
  textApis: TextApiConfig[],
  reasoningEffort: TextReasoningEffort | null | undefined,
  prompt: string | undefined
): PromptPolishConfig {
  const selection = resolveLegacyPromptPolishSelection(textApis);
  return {
    textApiId: selection?.apiId ?? null,
    textModelId: selection?.modelId ?? null,
    reasoningEffort: reasoningEffort && TEXT_REASONING_EFFORTS.includes(reasoningEffort)
      ? reasoningEffort
      : null,
    prompt: prompt ?? DEFAULT_IMAGE_POLISH_PROMPT,
  };
}

export function normalizeCanvasEdgeRoutingMode(
  input: CanvasEdgeRoutingMode | string | null | undefined
): CanvasEdgeRoutingMode {
  if (input === 'orthogonal' || input === 'smartOrthogonal' || input === 'spline') {
    return input;
  }
  return 'spline';
}
