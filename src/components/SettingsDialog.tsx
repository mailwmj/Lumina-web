import { useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { X, FolderOpen, Plus, Trash2 } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import {
  useSettingsStore,
  type ChaomoImageApiConfig,
  type CustomImageApiConfig,
  type OpenAiImageApiConfig,
  type PromptPolishConfig,
  type TextApiConfig,
  type VideoApiConfig,
  type ExternalAgentConnectionConfig,
} from '@/stores/settingsStore';
import { UiSelect, UiTooltip } from '@/components/ui';
import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import type { SettingsCategory } from '@/features/settings/settingsEvents';
import { DEFAULT_ACCENT_COLOR } from '@/features/settings/application/accentColor';
import { logger } from '@/lib/logger';
import { ImageApisSettings } from '@/features/settings/ImageApisSettings';
import { LoggingSettings } from '@/features/settings/LoggingSettings';
import { SettingsCheckboxCard } from '@/features/settings/SettingsCheckboxCard';
import { TextApisSettings } from '@/features/settings/TextApisSettings';
import { VideoApisSettings } from '@/features/settings/VideoApisSettings';
import { PromptPolishSettings } from '@/features/settings/PromptPolishSettings';
import { ExternalAgentSettings } from '@/features/settings/ExternalAgentSettings';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialCategory?: SettingsCategory;
}

export function SettingsDialog({
  isOpen,
  onClose,
  initialCategory = 'general',
}: SettingsDialogProps) {
  const { t } = useTranslation();
  const {
    openAiImageApi,
    chaomoImageApi,
    customImageApis,
    downloadPresetPaths,
    storyboardGenKeepStyleConsistent,
    storyboardGenDisableTextInImage,
    storyboardGenAutoInferEmptyFrame,
    ignoreAtTagWhenCopyingAndGenerating,
    enableStoryboardGenGridPreviewShortcut,
    showStoryboardGenAdvancedRatioControls,
    accentColor,
    canvasEdgeRoutingMode,
    setOpenAiImageApi,
    setChaomoImageApi,
    setCustomImageApis,
    setDownloadPresetPaths,
    setStoryboardGenKeepStyleConsistent,
    setStoryboardGenDisableTextInImage,
    setStoryboardGenAutoInferEmptyFrame,
    setIgnoreAtTagWhenCopyingAndGenerating,
    setEnableStoryboardGenGridPreviewShortcut,
    setShowStoryboardGenAdvancedRatioControls,
    setAccentColor,
    setCanvasEdgeRoutingMode,
    textApis,
    setTextApis,
    imagePolishConfig,
    setImagePolishConfig,
    textPolishConfig,
    setTextPolishConfig,
    videoApis,
    setVideoApis,
    externalAgentConnection,
    setExternalAgentConnection,
  } = useSettingsStore();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(initialCategory);
  const [localOpenAiImageApi, setLocalOpenAiImageApi] = useState<OpenAiImageApiConfig>(
    openAiImageApi
  );
  const [localChaomoImageApi, setLocalChaomoImageApi] = useState<ChaomoImageApiConfig>(
    chaomoImageApi
  );
  const [localCustomImageApis, setLocalCustomImageApis] = useState<CustomImageApiConfig[]>(
    customImageApis
  );
  const [localDownloadPathInput, setLocalDownloadPathInput] = useState('');
  const [localDownloadPresetPaths, setLocalDownloadPresetPaths] = useState(downloadPresetPaths);
  const [localStoryboardGenKeepStyleConsistent, setLocalStoryboardGenKeepStyleConsistent] =
    useState(storyboardGenKeepStyleConsistent);
  const [localStoryboardGenDisableTextInImage, setLocalStoryboardGenDisableTextInImage] = useState(
    storyboardGenDisableTextInImage
  );
  const [localStoryboardGenAutoInferEmptyFrame, setLocalStoryboardGenAutoInferEmptyFrame] = useState(
    storyboardGenAutoInferEmptyFrame
  );
  const [localIgnoreAtTagWhenCopyingAndGenerating, setLocalIgnoreAtTagWhenCopyingAndGenerating] =
    useState(ignoreAtTagWhenCopyingAndGenerating);
  const [localEnableStoryboardGenGridPreviewShortcut, setLocalEnableStoryboardGenGridPreviewShortcut] =
    useState(enableStoryboardGenGridPreviewShortcut);
  const [localShowStoryboardGenAdvancedRatioControls, setLocalShowStoryboardGenAdvancedRatioControls] =
    useState(showStoryboardGenAdvancedRatioControls);
  const [localAccentColor, setLocalAccentColor] = useState(accentColor);
  const [localCanvasEdgeRoutingMode, setLocalCanvasEdgeRoutingMode] = useState(canvasEdgeRoutingMode);
  const [localTextApis, setLocalTextApis] = useState<TextApiConfig[]>(textApis);
  const [localImagePolishConfig, setLocalImagePolishConfig] = useState<PromptPolishConfig>(
    imagePolishConfig
  );
  const [localTextPolishConfig, setLocalTextPolishConfig] = useState<PromptPolishConfig>(
    textPolishConfig
  );
  const [localVideoApis, setLocalVideoApis] = useState<VideoApiConfig[]>(videoApis);
  const [isProviderDetailOpen, setProviderDetailOpen] = useState(false);
  const [localExternalAgentConnection, setLocalExternalAgentConnection] =
    useState<ExternalAgentConnectionConfig>(externalAgentConnection);
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setLocalOpenAiImageApi(openAiImageApi);
    setLocalChaomoImageApi(chaomoImageApi);
    setLocalCustomImageApis(customImageApis);
    setLocalDownloadPresetPaths(downloadPresetPaths);
    setLocalStoryboardGenKeepStyleConsistent(storyboardGenKeepStyleConsistent);
    setLocalStoryboardGenDisableTextInImage(storyboardGenDisableTextInImage);
    setLocalStoryboardGenAutoInferEmptyFrame(storyboardGenAutoInferEmptyFrame);
    setLocalIgnoreAtTagWhenCopyingAndGenerating(ignoreAtTagWhenCopyingAndGenerating);
    setLocalEnableStoryboardGenGridPreviewShortcut(enableStoryboardGenGridPreviewShortcut);
    setLocalShowStoryboardGenAdvancedRatioControls(showStoryboardGenAdvancedRatioControls);
    setLocalAccentColor(accentColor);
    setLocalCanvasEdgeRoutingMode(canvasEdgeRoutingMode);
    setLocalTextApis(textApis);
    setLocalImagePolishConfig(imagePolishConfig);
    setLocalTextPolishConfig(textPolishConfig);
    setLocalVideoApis(videoApis);
    setLocalExternalAgentConnection(externalAgentConnection);
    setLocalDownloadPathInput('');
  }, [
    isOpen,
    openAiImageApi,
    chaomoImageApi,
    customImageApis,
    downloadPresetPaths,
    storyboardGenKeepStyleConsistent,
    storyboardGenDisableTextInImage,
    storyboardGenAutoInferEmptyFrame,
    ignoreAtTagWhenCopyingAndGenerating,
    enableStoryboardGenGridPreviewShortcut,
    showStoryboardGenAdvancedRatioControls,
    accentColor,
    canvasEdgeRoutingMode,
    textApis,
    imagePolishConfig,
    textPolishConfig,
    videoApis,
    externalAgentConnection,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveCategory(initialCategory);
  }, [initialCategory, isOpen]);

  useLayoutEffect(() => {
    setProviderDetailOpen(false);
  }, [activeCategory, isOpen]);

  const handleSave = useCallback(() => {
    setOpenAiImageApi(localOpenAiImageApi);
    setChaomoImageApi(localChaomoImageApi);
    setCustomImageApis(localCustomImageApis);
    setDownloadPresetPaths(localDownloadPresetPaths);
    setStoryboardGenKeepStyleConsistent(localStoryboardGenKeepStyleConsistent);
    setStoryboardGenDisableTextInImage(localStoryboardGenDisableTextInImage);
    setStoryboardGenAutoInferEmptyFrame(localStoryboardGenAutoInferEmptyFrame);
    setIgnoreAtTagWhenCopyingAndGenerating(localIgnoreAtTagWhenCopyingAndGenerating);
    setEnableStoryboardGenGridPreviewShortcut(localEnableStoryboardGenGridPreviewShortcut);
    setShowStoryboardGenAdvancedRatioControls(localShowStoryboardGenAdvancedRatioControls);
    setAccentColor(localAccentColor);
    setCanvasEdgeRoutingMode(localCanvasEdgeRoutingMode);
    setTextApis(localTextApis);
    setImagePolishConfig(localImagePolishConfig);
    setTextPolishConfig(localTextPolishConfig);
    setVideoApis(localVideoApis);
    setExternalAgentConnection(localExternalAgentConnection);
    onClose();
  }, [
    localOpenAiImageApi,
    localChaomoImageApi,
    localCustomImageApis,
    localDownloadPresetPaths,
    localStoryboardGenKeepStyleConsistent,
    localStoryboardGenDisableTextInImage,
    localStoryboardGenAutoInferEmptyFrame,
    localIgnoreAtTagWhenCopyingAndGenerating,
    localEnableStoryboardGenGridPreviewShortcut,
    localShowStoryboardGenAdvancedRatioControls,
    localAccentColor,
    localCanvasEdgeRoutingMode,
    localTextApis,
    localImagePolishConfig,
    localTextPolishConfig,
    localVideoApis,
    localExternalAgentConnection,
    setOpenAiImageApi,
    setChaomoImageApi,
    setCustomImageApis,
    setDownloadPresetPaths,
    setStoryboardGenKeepStyleConsistent,
    setStoryboardGenDisableTextInImage,
    setStoryboardGenAutoInferEmptyFrame,
    setIgnoreAtTagWhenCopyingAndGenerating,
    setEnableStoryboardGenGridPreviewShortcut,
    setShowStoryboardGenAdvancedRatioControls,
    setAccentColor,
    setCanvasEdgeRoutingMode,
    setTextApis,
    setImagePolishConfig,
    setTextPolishConfig,
    setVideoApis,
    setExternalAgentConnection,
    onClose,
  ]);

  const handlePickDownloadPath = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (!selected || Array.isArray(selected)) {
        return;
      }
      setLocalDownloadPresetPaths((previous) => {
        if (previous.includes(selected)) {
          return previous;
        }
        return [...previous, selected].slice(0, 8);
      });
    } catch (error) {
      logger.error('Failed to pick download path', error);
    }
  }, []);

  const handleAddDownloadPathFromInput = useCallback(() => {
    const next = localDownloadPathInput.trim();
    if (!next) {
      return;
    }
    setLocalDownloadPresetPaths((previous) => {
      if (previous.includes(next)) {
        return previous;
      }
      return [...previous, next].slice(0, 8);
    });
    setLocalDownloadPathInput('');
  }, [localDownloadPathInput]);

  const handleRemoveDownloadPath = useCallback((path: string) => {
    setLocalDownloadPresetPaths((previous) => previous.filter((value) => value !== path));
  }, []);

  const categoryButtonClass = (category: SettingsCategory) =>
    `mx-2 flex w-[calc(100%-1rem)] items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
      activeCategory === category
        ? 'bg-accent/14 font-medium text-accent'
        : 'text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark'
    }`;

  if (!shouldRender) return null;

  return (
    <div className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-50 flex items-center justify-center`}>
      <div
        className={`absolute inset-0 bg-black/65 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div className="relative w-[min(94vw,920px)]">
        <div
          className={`relative mx-auto flex h-[min(84vh,720px)] w-full overflow-hidden rounded-[10px] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)] shadow-[var(--ui-shadow-panel)] transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        >
          <UiTooltip content={t('common.close')}>
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={onClose}
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-[var(--ui-hover)] hover:text-text-dark"
            >
              <X className="h-4 w-4" />
            </button>
          </UiTooltip>

          {/* Sidebar */}
          <div className="flex w-[200px] shrink-0 flex-col border-r border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)]">
            <div className="px-4 py-4">
              <span className="text-xs font-medium text-text-muted">
                {t('settings.title')}
              </span>
            </div>

            <nav className="flex-1">
              <button
                onClick={() => setActiveCategory('general')}
                className={categoryButtonClass('general')}
              >
                <span className="text-sm">{t('settings.general')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('imageApis')}
                className={categoryButtonClass('imageApis')}
              >
                <span className="text-sm">{t('settings.imageApis')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('textApis')}
                className={categoryButtonClass('textApis')}
              >
                <span className="text-sm">{t('settings.textApis')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('videoApis')}
                className={categoryButtonClass('videoApis')}
              >
                <span className="text-sm">{t('settings.videoApis')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('promptPolish')}
                className={categoryButtonClass('promptPolish')}
              >
                <span className="text-sm">{t('settings.promptPolish')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('appearance')}
                className={categoryButtonClass('appearance')}
              >
                <span className="text-sm">{t('settings.appearance')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('experimental')}
                className={categoryButtonClass('experimental')}
              >
                <span className="text-sm">{t('settings.experimental')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('externalAgent')}
                className={categoryButtonClass('externalAgent')}
              >
                <span className="text-sm">{t('settings.externalAgent')}</span>
              </button>

              <button
                onClick={() => setActiveCategory('logging')}
                className={categoryButtonClass('logging')}
              >
                <span className="text-sm">{t('settings.logging')}</span>
              </button>
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col">
            {activeCategory === 'imageApis' && (
              <>
                {!isProviderDetailOpen && (
                  <div className="border-b border-[var(--ui-border-soft)] px-6 py-4">
                    <h2 className="text-base font-semibold text-text-dark">
                      {t('settings.imageApis')}
                    </h2>
                    <p className="text-sm text-text-muted mt-1">
                      {t('settings.imageApisDesc')}
                    </p>
                  </div>
                )}

                <div className="ui-scrollbar flex-1 overflow-y-auto px-6 py-2">
                  <ImageApisSettings
                    value={{
                      openAiImageApi: localOpenAiImageApi,
                      chaomoImageApi: localChaomoImageApi,
                      customImageApis: localCustomImageApis,
                    }}
                    onChange={({ openAiImageApi, chaomoImageApi, customImageApis }) => {
                      setLocalOpenAiImageApi(openAiImageApi);
                      setLocalChaomoImageApi(chaomoImageApi);
                      setLocalCustomImageApis(customImageApis);
                    }}
                    onDetailChange={setProviderDetailOpen}
                  />
                </div>

                <div className="px-6 py-4 border-t border-border-dark flex justify-end">
                  <button
                    onClick={handleSave}
                    className="px-4 py-2 text-sm font-medium bg-accent text-[var(--accent-foreground)] rounded
                             hover:bg-accent/80 transition-colors"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'appearance' && (
              <>
                <div className="border-b border-[var(--ui-border-soft)] px-6 py-4">
                  <h2 className="text-base font-semibold text-text-dark">
                    {t('settings.appearance')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.appearanceDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 overflow-y-auto px-6">
                  <section className="border-b border-[var(--ui-border-soft)] py-5">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.edgeRoutingMode')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.edgeRoutingModeDesc')}
                    </p>
                    <div className="mt-3">
                      <UiSelect
                        value={localCanvasEdgeRoutingMode}
                        onChange={(event) =>
                          setLocalCanvasEdgeRoutingMode(
                            event.target.value as typeof localCanvasEdgeRoutingMode
                          )
                        }
                        className="h-9 text-sm"
                      >
                        <option value="spline">{t('settings.edgeRoutingSpline')}</option>
                        <option value="orthogonal">{t('settings.edgeRoutingOrthogonal')}</option>
                        <option value="smartOrthogonal">{t('settings.edgeRoutingSmartOrthogonal')}</option>
                      </UiSelect>
                    </div>
                  </section>

                  <section className="py-5">
                    <h3 className="text-sm font-medium text-text-dark">
                      {t('settings.accentColor')}
                    </h3>
                    <p className="mt-1 text-xs text-text-muted">
                      {t('settings.accentColorDesc')}
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        type="color"
                        value={localAccentColor}
                        onChange={(event) => setLocalAccentColor(event.target.value)}
                        className="h-9 w-12 rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] p-1"
                      />
                      <input
                        value={localAccentColor}
                        onChange={(event) => setLocalAccentColor(event.target.value)}
                        placeholder={DEFAULT_ACCENT_COLOR}
                        className="h-9 flex-1 rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-3 font-mono text-sm text-text-dark outline-none placeholder:text-text-muted focus:border-accent"
                      />
                      <button
                        type="button"
                        className="inline-flex h-9 items-center justify-center rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-3 text-xs text-text-dark transition-colors hover:bg-[var(--ui-hover)]"
                        onClick={() => setLocalAccentColor(DEFAULT_ACCENT_COLOR)}
                      >
                        {t('settings.resetAccentColor')}
                      </button>
                    </div>
                  </section>
                </div>

                <div className="flex justify-end border-t border-[var(--ui-border-soft)] px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-accent/85"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'general' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.general')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.generalDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <SettingsCheckboxCard
                    checked={localStoryboardGenKeepStyleConsistent}
                    onCheckedChange={setLocalStoryboardGenKeepStyleConsistent}
                    title={t('settings.storyboardGenKeepStyleConsistent')}
                    description={t('settings.storyboardGenKeepStyleConsistentDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localIgnoreAtTagWhenCopyingAndGenerating}
                    onCheckedChange={setLocalIgnoreAtTagWhenCopyingAndGenerating}
                    title={t('settings.ignoreAtTagWhenCopyingAndGenerating')}
                    description={t('settings.ignoreAtTagWhenCopyingAndGeneratingDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localStoryboardGenDisableTextInImage}
                    onCheckedChange={setLocalStoryboardGenDisableTextInImage}
                    title={t('settings.storyboardGenDisableTextInImage')}
                    description={t('settings.storyboardGenDisableTextInImageDesc')}
                  />

                  <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                    <div className="mb-3">
                      <h3 className="text-sm font-medium text-text-dark">
                        {t('settings.downloadPresetPaths')}
                      </h3>
                      <p className="mt-1 text-xs text-text-muted">
                        {t('settings.downloadPresetPathsDesc')}
                      </p>
                    </div>

                    <div className="mb-2 flex items-center gap-2">
                      <input
                        value={localDownloadPathInput}
                        onChange={(event) => setLocalDownloadPathInput(event.target.value)}
                        placeholder={t('settings.downloadPathPlaceholder')}
                        className="h-9 flex-1 rounded border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-none placeholder:text-text-muted"
                      />
                      <button
                        type="button"
                        className="inline-flex h-9 items-center justify-center rounded border border-border-dark bg-surface-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark"
                        onClick={handleAddDownloadPathFromInput}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        {t('settings.addPath')}
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-9 items-center justify-center rounded border border-border-dark bg-surface-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark"
                        onClick={() => {
                          void handlePickDownloadPath();
                        }}
                      >
                        <FolderOpen className="mr-1 h-3.5 w-3.5" />
                        {t('settings.chooseFolder')}
                      </button>
                    </div>

                    <div className="space-y-1">
                      {localDownloadPresetPaths.length > 0 ? (
                        localDownloadPresetPaths.map((path) => (
                          <div
                            key={path}
                            className="flex items-center gap-2 rounded border border-border-dark bg-surface-dark px-2 py-1.5"
                          >
                            <span className="truncate text-xs text-text-dark">{path}</span>
                            <UiTooltip content={t('common.delete')}>
                              <button
                                type="button"
                                aria-label={t('common.delete')}
                                className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-[var(--ui-hover)] hover:text-red-400"
                                onClick={() => handleRemoveDownloadPath(path)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </UiTooltip>
                          </div>
                        ))
                      ) : (
                        <div className="text-xs text-text-muted">{t('settings.noDownloadPresetPaths')}</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-accent/85"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'experimental' && (
              <>
                <div className="px-6 py-5 border-b border-border-dark">
                  <h2 className="text-lg font-semibold text-text-dark">
                    {t('settings.experimental')}
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {t('settings.experimentalDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <SettingsCheckboxCard
                    checked={localEnableStoryboardGenGridPreviewShortcut}
                    onCheckedChange={setLocalEnableStoryboardGenGridPreviewShortcut}
                    title={t('settings.enableStoryboardGenGridPreviewShortcut')}
                    description={t('settings.enableStoryboardGenGridPreviewShortcutDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localShowStoryboardGenAdvancedRatioControls}
                    onCheckedChange={setLocalShowStoryboardGenAdvancedRatioControls}
                    title={t('settings.showStoryboardGenAdvancedRatioControls')}
                    description={t('settings.showStoryboardGenAdvancedRatioControlsDesc')}
                  />

                  <SettingsCheckboxCard
                    checked={localStoryboardGenAutoInferEmptyFrame}
                    onCheckedChange={setLocalStoryboardGenAutoInferEmptyFrame}
                    title={t('settings.storyboardGenAutoInferEmptyFrame')}
                    description={t('settings.storyboardGenAutoInferEmptyFrameDesc')}
                  />
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-accent/85"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'textApis' && (
              <>
                {!isProviderDetailOpen && (
                  <div className="px-6 py-5 border-b border-border-dark">
                    <h2 className="text-lg font-semibold text-text-dark">
                      {t('settings.textApis')}
                    </h2>
                    <p className="text-sm text-text-muted mt-1">
                      {t('settings.textApisDesc')}
                    </p>
                  </div>
                )}

                <div className="ui-scrollbar flex-1 overflow-y-auto px-6 py-2">
                  <TextApisSettings
                    apis={localTextApis}
                    onChange={setLocalTextApis}
                    onDetailChange={setProviderDetailOpen}
                  />
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-accent/85"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'promptPolish' && (
              <>
                <div className="border-b border-[var(--ui-border-soft)] px-6 py-4">
                  <h2 className="text-base font-semibold text-text-dark">
                    {t('settings.promptPolish')}
                  </h2>
                  <p className="mt-1 text-sm text-text-muted">
                    {t('settings.promptPolishDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 overflow-y-auto px-6 py-2">
                  <PromptPolishSettings
                    textApis={localTextApis}
                    imagePolishConfig={localImagePolishConfig}
                    textPolishConfig={localTextPolishConfig}
                    videoApis={localVideoApis}
                    onImagePolishConfigChange={setLocalImagePolishConfig}
                    onTextPolishConfigChange={setLocalTextPolishConfig}
                    onVideoApisChange={setLocalVideoApis}
                  />
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-accent/85"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'videoApis' && (
              <>
                {!isProviderDetailOpen && (
                  <div className="px-6 py-5 border-b border-border-dark">
                    <h2 className="text-lg font-semibold text-text-dark">
                      {t('settings.videoApis')}
                    </h2>
                    <p className="text-sm text-text-muted mt-1">
                      {t('settings.videoApisDesc')}
                    </p>
                  </div>
                )}

                <div className="ui-scrollbar flex-1 overflow-y-auto px-6 py-2">
                  <VideoApisSettings
                    apis={localVideoApis}
                    onChange={setLocalVideoApis}
                    onDetailChange={setProviderDetailOpen}
                  />
                </div>

                <div className="flex justify-end border-t border-border-dark px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-accent/85"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}

            {activeCategory === 'logging' && (
              <>
                <div className="border-b border-[var(--ui-border-soft)] px-6 py-4">
                  <h2 className="text-base font-semibold text-text-dark">
                    {t('settings.logging')}
                  </h2>
                </div>

                <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
                  <LoggingSettings />
                </div>
              </>
            )}

            {activeCategory === 'externalAgent' && (
              <>
                <div className="border-b border-[var(--ui-border-soft)] px-6 py-4">
                  <h2 className="text-base font-semibold text-text-dark">
                    {t('settings.externalAgent')}
                  </h2>
                  <p className="mt-1 text-sm text-text-muted">
                    {t('settings.externalAgentDesc')}
                  </p>
                </div>

                <div className="ui-scrollbar flex-1 overflow-y-auto px-6">
                  <ExternalAgentSettings
                    value={localExternalAgentConnection}
                    onChange={setLocalExternalAgentConnection}
                  />
                </div>

                <div className="flex justify-end border-t border-[var(--ui-border-soft)] px-6 py-4">
                  <button
                    onClick={handleSave}
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-accent/85"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
