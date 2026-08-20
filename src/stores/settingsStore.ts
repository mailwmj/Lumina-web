import { create } from 'zustand';
import { persist, type PersistStorage } from 'zustand/middleware';

import { createRuntimeSettingsRepository } from '@/features/settings/application/createRuntimeSettingsRepository';
import {
  DEFAULT_ACCENT_COLOR,
  normalizeAccentColor,
} from '@/features/settings/application/accentColor';
import {
  DEFAULT_IMAGE_POLISH_PROMPT,
  DEFAULT_TEXT_POLISH_PROMPT,
  PRESET_TEXT_APIS,
  PRESET_VIDEO_APIS,
  createDefaultChaomoImageApiConfig,
  createDefaultExternalAgentConnectionConfig,
  createDefaultOpenAiImageApiConfig,
  createPromptPolishConfig,
  isCustomImageProviderId,
  mergeVideoApis,
  normalizeBatchAiFillSelection,
  normalizeCanvasEdgeRoutingMode,
  normalizeChaomoImageApiConfig,
  normalizeCustomImageApiConfigs,
  normalizeExternalAgentConnectionConfig,
  normalizeImageModelSelection,
  normalizeLastImageGenerationOptions,
  normalizeOpenAiImageApiConfig,
  normalizePromptPolishConfig,
  normalizeTextApiConfigs,
  normalizeTextGenerationModelSelection,
  type BatchAiFillSelection,
  type CanvasEdgeRoutingMode,
  type ChaomoImageApiConfig,
  type CustomImageApiConfig,
  type ExternalAgentConnectionConfig,
  type ImageModelSelection,
  type LastImageGenerationOptions,
  type LastImageGenerationOptionsPatch,
  type OpenAiImageApiConfig,
  type PromptPolishConfig,
  type TextApiConfig,
  type TextGenerationModelSelection,
  type VideoApiConfig,
} from '@/features/settings/domain/settingsSchema';
import { SETTINGS_SCHEMA_VERSION } from '@/features/settings/domain/settingsRepository';
import { logger } from '@/lib/logger';

export * from '@/features/settings/application/settingsMigration';
export * from '@/features/settings/domain/settingsSchema';

interface SettingsState {
  isHydrated: boolean;
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
  setOpenAiImageApi: (config: OpenAiImageApiConfig) => void;
  setChaomoImageApi: (config: ChaomoImageApiConfig) => void;
  setCustomImageApis: (configs: CustomImageApiConfig[]) => void;
  setLastImageModelSelection: (selection: ImageModelSelection | null) => void;
  setLastBatchAiFillSelection: (selection: BatchAiFillSelection | null) => void;
  updateLastImageGenerationOptions: (options: LastImageGenerationOptionsPatch) => void;
  setLastTextGenerationModelSelection: (
    selection: TextGenerationModelSelection | null
  ) => void;
  setDownloadPresetPaths: (paths: string[]) => void;
  setUseUploadFilenameAsNodeTitle: (enabled: boolean) => void;
  setStoryboardGenKeepStyleConsistent: (enabled: boolean) => void;
  setStoryboardGenDisableTextInImage: (enabled: boolean) => void;
  setStoryboardGenAutoInferEmptyFrame: (enabled: boolean) => void;
  setIgnoreAtTagWhenCopyingAndGenerating: (enabled: boolean) => void;
  setEnableStoryboardGenGridPreviewShortcut: (enabled: boolean) => void;
  setShowStoryboardGenAdvancedRatioControls: (enabled: boolean) => void;
  setAccentColor: (color: string) => void;
  setCanvasEdgeRoutingMode: (mode: CanvasEdgeRoutingMode) => void;
  setSnapToGridEnabled: (enabled: boolean) => void;
  setSnapGridSize: (size: number) => void;
  setAutoCheckAppUpdateOnLaunch: (enabled: boolean) => void;
  setEnableUpdateDialog: (enabled: boolean) => void;
  setExternalAgentConnection: (config: ExternalAgentConnectionConfig) => void;
  setTextApis: (apis: TextApiConfig[]) => void;
  setActiveTextApiId: (id: string | null) => void;
  setImagePolishConfig: (config: PromptPolishConfig) => void;
  setTextPolishConfig: (config: PromptPolishConfig) => void;
  setVideoApis: (apis: VideoApiConfig[]) => void;
  setActiveVideoApiId: (id: string | null) => void;
}

export const settingsRepository = createRuntimeSettingsRepository<SettingsState>();
const settingsPersistStorage: PersistStorage<SettingsState> = {
  getItem: () => settingsRepository.read(),
  setItem: (_name, snapshot) => settingsRepository.update({
    state: snapshot.state,
    version: snapshot.version ?? SETTINGS_SCHEMA_VERSION,
  }),
  removeItem: () => settingsRepository.reset(),
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      isHydrated: false,
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
      setOpenAiImageApi: (config) =>
        set((state) => {
          const openAiImageApi = normalizeOpenAiImageApiConfig(config);
          const lastImageModelSelection = state.lastImageModelSelection?.providerId === 'ai-media' &&
            !openAiImageApi.selectedModelIds.includes(state.lastImageModelSelection.modelId)
            ? null
            : state.lastImageModelSelection;
          return { openAiImageApi, lastImageModelSelection };
        }),
      setChaomoImageApi: (config) =>
        set((state) => {
          const chaomoImageApi = normalizeChaomoImageApiConfig(config);
          const lastImageModelSelection = state.lastImageModelSelection?.providerId === 'chaomo' &&
            !chaomoImageApi.selectedModelIds.includes(state.lastImageModelSelection.modelId)
            ? null
            : state.lastImageModelSelection;
          return { chaomoImageApi, lastImageModelSelection };
        }),
      setCustomImageApis: (configs) =>
        set((state) => {
          const customImageApis = normalizeCustomImageApiConfigs(configs);
          const lastSelection = state.lastImageModelSelection;
          const selectedProvider = lastSelection && isCustomImageProviderId(lastSelection.providerId)
            ? customImageApis.find((config) => config.id === lastSelection.providerId)
            : undefined;
          const lastImageModelSelection = lastSelection && isCustomImageProviderId(lastSelection.providerId)
            && (!selectedProvider || !selectedProvider.selectedModelIds.includes(lastSelection.modelId))
            ? null
            : lastSelection;
          return { customImageApis, lastImageModelSelection };
        }),
      setDownloadPresetPaths: (paths) => {
        const uniquePaths = Array.from(
          new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))
        ).slice(0, 8);
        set({ downloadPresetPaths: uniquePaths });
      },
      setUseUploadFilenameAsNodeTitle: (enabled) => set({ useUploadFilenameAsNodeTitle: enabled }),
      setStoryboardGenKeepStyleConsistent: (enabled) =>
        set({ storyboardGenKeepStyleConsistent: enabled }),
      setStoryboardGenDisableTextInImage: (enabled) =>
        set({ storyboardGenDisableTextInImage: enabled }),
      setStoryboardGenAutoInferEmptyFrame: (enabled) =>
        set({ storyboardGenAutoInferEmptyFrame: enabled }),
      setIgnoreAtTagWhenCopyingAndGenerating: (enabled) =>
        set({ ignoreAtTagWhenCopyingAndGenerating: enabled }),
      setEnableStoryboardGenGridPreviewShortcut: (enabled) =>
        set({ enableStoryboardGenGridPreviewShortcut: enabled }),
      setShowStoryboardGenAdvancedRatioControls: (enabled) =>
        set({ showStoryboardGenAdvancedRatioControls: enabled }),
      setAccentColor: (color) => set({ accentColor: normalizeAccentColor(color) }),
      setCanvasEdgeRoutingMode: (canvasEdgeRoutingMode) =>
        set({ canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(canvasEdgeRoutingMode) }),
      setSnapToGridEnabled: (enabled: boolean) => set({ snapToGridEnabled: enabled }),
      setSnapGridSize: (size: number) => set({ snapGridSize: Math.max(5, Math.min(100, size)) }),
      setAutoCheckAppUpdateOnLaunch: (enabled: boolean) => set({ autoCheckAppUpdateOnLaunch: enabled }),
      setEnableUpdateDialog: (enabled) => set({ enableUpdateDialog: enabled }),
      setExternalAgentConnection: (config) => set({
        externalAgentConnection: normalizeExternalAgentConnectionConfig(config),
      }),
      textApis: PRESET_TEXT_APIS,
      activeTextApiId: null,
      setTextApis: (apis) => set({ textApis: normalizeTextApiConfigs(apis) }),
      setActiveTextApiId: (id) => set({ activeTextApiId: id }),
      imagePolishConfig: createPromptPolishConfig(DEFAULT_IMAGE_POLISH_PROMPT),
      textPolishConfig: createPromptPolishConfig(DEFAULT_TEXT_POLISH_PROMPT),
      setImagePolishConfig: (config) => set({
        imagePolishConfig: normalizePromptPolishConfig(config, DEFAULT_IMAGE_POLISH_PROMPT),
      }),
      setTextPolishConfig: (config) => set({
        textPolishConfig: normalizePromptPolishConfig(config, DEFAULT_TEXT_POLISH_PROMPT),
      }),
      videoApis: PRESET_VIDEO_APIS,
      activeVideoApiId: null,
      lastImageModelSelection: null,
      setLastImageModelSelection: (selection) =>
        set({ lastImageModelSelection: normalizeImageModelSelection(selection) }),
      lastBatchAiFillSelection: null,
      setLastBatchAiFillSelection: (selection) =>
        set({ lastBatchAiFillSelection: normalizeBatchAiFillSelection(selection) }),
      lastImageGenerationOptions: {},
      updateLastImageGenerationOptions: (options) =>
        set((state) => ({
          lastImageGenerationOptions: {
            ...state.lastImageGenerationOptions,
            ...normalizeLastImageGenerationOptions(options),
          },
        })),
      lastTextGenerationModelSelection: null,
      setLastTextGenerationModelSelection: (selection) => set({
        lastTextGenerationModelSelection: normalizeTextGenerationModelSelection(selection),
      }),
      setVideoApis: (apis) => {
        set({ videoApis: mergeVideoApis(apis) });
      },
      setActiveVideoApiId: (id) => set({ activeVideoApiId: id }),
    }),
    {
      name: 'settings-storage',
      version: SETTINGS_SCHEMA_VERSION,
      storage: settingsPersistStorage,
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            logger.error('failed to hydrate settings storage', error);
          }
          useSettingsStore.setState({ isHydrated: true });
        };
      },
    }
  )
);
