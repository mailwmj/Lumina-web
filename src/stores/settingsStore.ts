import { create } from 'zustand';
import { persist, type PersistStorage } from 'zustand/middleware';

import { createRuntimeSettingsRepository } from '@/features/settings/application/createRuntimeSettingsRepository';
import { normalizeAccentColor } from '@/features/settings/application/accentColor';
import {
  DEFAULT_IMAGE_POLISH_PROMPT,
  DEFAULT_TEXT_POLISH_PROMPT,
  createDefaultSettingsData,
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
  selectSettingsData,
  type BatchAiFillSelection,
  type CanvasEdgeRoutingMode,
  type ChaomoImageApiConfig,
  type CustomImageApiConfig,
  type ExternalAgentConnectionConfig,
  type ImageModelSelection,
  type LastImageGenerationOptionsPatch,
  type OpenAiImageApiConfig,
  type PromptPolishConfig,
  type SettingsData,
  type TextApiConfig,
  type TextGenerationModelSelection,
  type VideoApiConfig,
} from '@/features/settings/domain/settingsSchema';
import { SETTINGS_SCHEMA_VERSION } from '@/features/settings/domain/settingsRepository';
import { logger } from '@/lib/logger';

export * from '@/features/settings/application/settingsMigration';
export * from '@/features/settings/domain/settingsSchema';

interface SettingsState extends SettingsData {
  isHydrated: boolean;
  persistenceError: string | null;
  clearPersistenceError: () => void;
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

export const settingsRepository = createRuntimeSettingsRepository();
let settingsStoreSetState: ((partial: Partial<SettingsState>) => void) | null = null;
let settingsPersistenceErrorReported = false;
const reportSettingsPersistenceError = (error: unknown): void => {
  if (settingsPersistenceErrorReported) {
    return;
  }
  settingsPersistenceErrorReported = true;
  logger.error('failed to persist settings storage', error);
  settingsStoreSetState?.({
    persistenceError: error instanceof Error ? error.message : String(error),
  });
};
const settingsPersistStorage: PersistStorage<SettingsData> = {
  getItem: () => settingsRepository.read(),
  setItem: async (_name, snapshot) => {
    try {
      await settingsRepository.update({
        state: snapshot.state,
        version: snapshot.version ?? SETTINGS_SCHEMA_VERSION,
      });
      settingsPersistenceErrorReported = false;
    } catch (error) {
      reportSettingsPersistenceError(error);
    }
  },
  removeItem: async () => {
    try {
      await settingsRepository.reset();
      settingsPersistenceErrorReported = false;
    } catch (error) {
      reportSettingsPersistenceError(error);
    }
  },
};

export const useSettingsStore = create<SettingsState>()(
  persist<SettingsState, [], [], SettingsData>(
    (set) => ({
      ...createDefaultSettingsData(),
      isHydrated: false,
      persistenceError: null,
      clearPersistenceError: () => {
        settingsPersistenceErrorReported = false;
        set({ persistenceError: null });
      },
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
      setTextApis: (apis) => set({ textApis: normalizeTextApiConfigs(apis) }),
      setActiveTextApiId: (id) => set({ activeTextApiId: id }),
      setImagePolishConfig: (config) => set({
        imagePolishConfig: normalizePromptPolishConfig(config, DEFAULT_IMAGE_POLISH_PROMPT),
      }),
      setTextPolishConfig: (config) => set({
        textPolishConfig: normalizePromptPolishConfig(config, DEFAULT_TEXT_POLISH_PROMPT),
      }),
      setLastImageModelSelection: (selection) =>
        set({ lastImageModelSelection: normalizeImageModelSelection(selection) }),
      setLastBatchAiFillSelection: (selection) =>
        set({ lastBatchAiFillSelection: normalizeBatchAiFillSelection(selection) }),
      updateLastImageGenerationOptions: (options) =>
        set((state) => ({
          lastImageGenerationOptions: {
            ...state.lastImageGenerationOptions,
            ...normalizeLastImageGenerationOptions(options),
          },
        })),
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
      partialize: selectSettingsData,
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            logger.error('failed to hydrate settings storage', error);
            useSettingsStore.setState({
              persistenceError: error instanceof Error ? error.message : String(error),
            });
          }
          useSettingsStore.setState({ isHydrated: true });
        };
      },
    }
  )
);

settingsStoreSetState = useSettingsStore.setState;
