import {
  migrateAccentColor,
  migrateAppearanceSettings,
} from '@/features/settings/application/accentColor';
import type { TextReasoningEffort } from '@/features/canvas/models/types';
import {
  DEFAULT_IMAGE_POLISH_PROMPT,
  DEFAULT_TEXT_POLISH_PROMPT,
  createLegacyImagePolishConfig,
  mergeVideoApis,
  migrateLegacyFhlImageApiConfigs,
  normalizeBatchAiFillSelection,
  normalizeCanvasEdgeRoutingMode,
  normalizeChaomoImageApiConfig,
  normalizeCustomImageApiConfigs,
  normalizeAdditionalImageApiConfigs,
  normalizeImageModelSelection,
  normalizeLastImageGenerationOptions,
  normalizeOpenAiImageApiConfig,
  normalizePromptPolishConfig,
  normalizeTextApiConfigs,
  normalizeTextGenerationModelSelection,
  type CanvasEdgeRoutingMode,
  type ChaomoImageApiConfig,
  type CustomImageApiConfig,
  type ImageModelSelection,
  type LastImageGenerationOptions,
  type OpenAiImageApiConfig,
  type PromptPolishConfig,
  type SettingsData,
  type TextApiConfig,
  type TextGenerationModelSelection,
  type VideoApiConfig,
  type BatchAiFillSelection,
  type AdditionalImageApiConfig,
} from '@/features/settings/domain/settingsSchema';

export function migrateSettingsState(
  persistedState: unknown,
  persistedVersion: number
): Partial<SettingsData> {
  const state = migrateAppearanceSettings(persistedState) as Record<string, unknown> & {
    openAiImageApi?: Partial<OpenAiImageApiConfig>;
    chaomoImageApi?: Partial<ChaomoImageApiConfig>;
    customImageApis?: CustomImageApiConfig[];
    additionalImageApis?: AdditionalImageApiConfig[];
    canvasEdgeRoutingMode?: CanvasEdgeRoutingMode | string;
    textApis?: TextApiConfig[];
    activeTextApiId?: string | null;
    textPolishReasoningEffort?: TextReasoningEffort | null;
    imagePolishPrompt?: string;
    imagePolishConfig?: PromptPolishConfig;
    textPolishConfig?: PromptPolishConfig;
    videoApis?: VideoApiConfig[];
    activeVideoApiId?: string | null;
    lastImageModelSelection?: ImageModelSelection | null;
    lastBatchAiFillSelection?: BatchAiFillSelection | null;
    lastImageGenerationOptions?: LastImageGenerationOptions;
    lastTextGenerationModelSelection?: TextGenerationModelSelection | null;
    accentColor?: unknown;
  };
  const {
    apiKey: _legacyApiKey,
    apiKeys: _legacyApiKeys,
    grsaiNanoBananaProModel: _legacyGrsaiModel,
    hideProviderGuidePopover: _legacyProviderGuide,
    showNodePrice: _legacyShowNodePrice,
    priceDisplayCurrencyMode: _legacyPriceCurrency,
    usdToCnyRate: _legacyUsdToCnyRate,
    preferDiscountedPrice: _legacyDiscountPreference,
    grsaiCreditTierId: _legacyGrsaiCreditTier,
    textPolishReasoningEffort: legacyTextPolishReasoningEffort,
    imagePolishPrompt: legacyImagePolishPrompt,
    ...retainedState
  } = state;

  const textApis = normalizeTextApiConfigs(state.textApis);
  const normalizedCustomImageApis = normalizeCustomImageApiConfigs(state.customImageApis);
  const additionalImageApis = normalizeAdditionalImageApiConfigs(state.additionalImageApis);
  const customImageApis = persistedVersion < 28
    ? migrateLegacyFhlImageApiConfigs(normalizedCustomImageApis)
    : normalizedCustomImageApis;
  const legacyImagePolishConfig = createLegacyImagePolishConfig(
    textApis,
    legacyTextPolishReasoningEffort,
    legacyImagePolishPrompt
  );
  const imagePolishConfig = normalizePromptPolishConfig(
    state.imagePolishConfig ?? legacyImagePolishConfig,
    DEFAULT_IMAGE_POLISH_PROMPT
  );

  return {
    ...retainedState,
    openAiImageApi: normalizeOpenAiImageApiConfig(state.openAiImageApi),
    chaomoImageApi: normalizeChaomoImageApiConfig(state.chaomoImageApi),
    customImageApis,
    additionalImageApis,
    canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(state.canvasEdgeRoutingMode),
    accentColor: migrateAccentColor(state.accentColor),
    ...(persistedVersion < 22 && (state.snapGridSize === 20 || state.snapGridSize === 36)
      ? { snapGridSize: 72 }
      : {}),
    textApis,
    activeTextApiId: state.activeTextApiId ?? null,
    imagePolishConfig,
    textPolishConfig: normalizePromptPolishConfig(
      state.textPolishConfig ?? {
        textApiId: imagePolishConfig.textApiId,
        textModelId: imagePolishConfig.textModelId,
        reasoningEffort: imagePolishConfig.reasoningEffort,
        prompt: DEFAULT_TEXT_POLISH_PROMPT,
      },
      DEFAULT_TEXT_POLISH_PROMPT
    ),
    videoApis: mergeVideoApis(state.videoApis),
    activeVideoApiId: state.activeVideoApiId ?? null,
    lastImageModelSelection: normalizeImageModelSelection(state.lastImageModelSelection),
    lastBatchAiFillSelection: normalizeBatchAiFillSelection(state.lastBatchAiFillSelection),
    lastImageGenerationOptions: normalizeLastImageGenerationOptions(
      state.lastImageGenerationOptions
    ),
    lastTextGenerationModelSelection: normalizeTextGenerationModelSelection(
      state.lastTextGenerationModelSelection
    ),
  };
}
