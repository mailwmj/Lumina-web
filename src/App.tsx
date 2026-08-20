import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './features/canvas/Canvas';
import { TitleBar } from './components/TitleBar';
import { LogPanel } from '@/lib/logger/LogPanel';
import { useLogPanelHotkey } from '@/lib/logger/useLogPanelHotkey';
import { SettingsDialog } from './components/SettingsDialog';
import { UpdateAvailableDialog, type UpdateIgnoreMode } from './components/UpdateAvailableDialog';
import { GlobalErrorDialog } from './components/GlobalErrorDialog';
import { ProjectManager } from './features/project/ProjectManager';
import { BatchImageCropWorkbench } from './features/batch-image-crop/BatchImageCropWorkbench';
import { useThemeStore } from './stores/themeStore';
import { useProjectStore } from './stores/projectStore';
import { useSettingsStore } from './stores/settingsStore';
import { logger } from '@/lib/logger';
import {
  checkForUpdate,
  isUpdateVersionSuppressed,
  suppressUpdateVersion,
} from './features/update/application/checkForUpdate';
import {
  subscribeOpenGlobalErrorDialog,
  type GlobalErrorDialogDetail,
} from './features/app/errorDialogEvents';
import {
  subscribeOpenSettingsDialog,
  type SettingsCategory,
} from './features/settings/settingsEvents';
import {
  getAccentForeground,
  hexToRgbChannels,
  normalizeAccentColor,
} from './features/settings/application/accentColor';
import { runtime } from './runtime/runtime';
import { UiButton } from './components/ui';
import { StorageStatusNotice } from './features/assets/ui/StorageStatusNotice';
import type { BrowserProjectBackupService } from './features/assets/application/browserProjectBackup';
import type { BrowserProjectImportService } from './features/assets/application/browserProjectImport';
import type { BrowserStorageStatusService } from './features/assets/application/browserStorageStatus';

interface AppProps {
  browserProjectBackupService: BrowserProjectBackupService | null;
  browserProjectImportService: BrowserProjectImportService | null;
  browserStorageStatusService: BrowserStorageStatusService | null;
}

function App({
  browserProjectBackupService,
  browserProjectImportService,
  browserStorageStatusService,
}: AppProps) {
  const { t } = useTranslation();
  useLogPanelHotkey();
  const { theme } = useThemeStore();
  const accentColor = useSettingsStore((state) => state.accentColor);
  const autoCheckAppUpdateOnLaunch = useSettingsStore((state) => state.autoCheckAppUpdateOnLaunch);
  const enableUpdateDialog = useSettingsStore((state) => state.enableUpdateDialog);
  const setEnableUpdateDialog = useSettingsStore((state) => state.setEnableUpdateDialog);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<SettingsCategory>('general');
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string>('');
  const [currentVersion, setCurrentVersion] = useState<string>('');
  const [globalError, setGlobalError] = useState<GlobalErrorDialogDetail | null>(null);
  const [activeHomeTool, setActiveHomeTool] = useState<'batch-crop' | null>(null);
  const homeToolBackHandlerRef = useRef<() => void>(() => undefined);

  const isHydrated = useProjectStore((state) => state.isHydrated);
  const hydrate = useProjectStore((state) => state.hydrate);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const closeProject = useProjectStore((state) => state.closeProject);
  const hydrationError = useProjectStore((state) => state.hydrationError);
  const projectPersistenceError = useProjectStore((state) => state.persistenceError);
  const clearProjectPersistenceError = useProjectStore((state) => state.clearPersistenceError);
  const settingsPersistenceError = useSettingsStore((state) => state.persistenceError);
  const clearSettingsPersistenceError = useSettingsStore((state) => state.clearPersistenceError);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    const isMac =
      typeof navigator !== 'undefined'
      && /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform} ${navigator.userAgent}`);
    root.dataset.platform = isMac ? 'macos' : 'default';
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const normalized = normalizeAccentColor(accentColor);
    root.style.setProperty('--accent', normalized);
    root.style.setProperty('--accent-rgb', hexToRgbChannels(normalized));
    root.style.setProperty('--accent-foreground', getAccentForeground(normalized));
  }, [accentColor]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const unsubscribe = subscribeOpenGlobalErrorDialog((detail) => {
      setGlobalError(detail);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeOpenSettingsDialog(({ category }) => {
      setSettingsInitialCategory(category ?? 'general');
      setShowSettings(true);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof window.setTimeout> | null = null;

    const notifyFrontendReady = async (attempt = 1) => {
      if (cancelled) {
        return;
      }

      try {
        await runtime.notifyFrontendReady();
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (attempt === 1 || attempt % 10 === 0) {
          logger.warn('failed to notify frontend readiness', error);
        }

        const retryDelayMs = Math.min(500, 80 * attempt);
        retryTimer = window.setTimeout(() => {
          void notifyFrontendReady(attempt + 1);
        }, retryDelayMs);
      }
    };

    requestAnimationFrame(() => {
      void notifyFrontendReady();
    });

    return () => {
      cancelled = true;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    let cancelled = false;
    const runUpdateCheck = async () => {
      if (!autoCheckAppUpdateOnLaunch) {
        return;
      }
      const result = await checkForUpdate();
      if (!cancelled && result.hasUpdate && result.latestVersion && enableUpdateDialog) {
        if (isUpdateVersionSuppressed(result.latestVersion)) {
          return;
        }
        setLatestVersion(result.latestVersion ?? '');
        setCurrentVersion(result.currentVersion ?? '');
        setShowUpdateDialog(true);
      }
    };

    void runUpdateCheck();
    return () => {
      cancelled = true;
    };
  }, [isHydrated, autoCheckAppUpdateOnLaunch, enableUpdateDialog]);

  const handleApplyIgnore = (mode: UpdateIgnoreMode) => {
    if (mode === 'forever-all') {
      setEnableUpdateDialog(false);
      return;
    }

    if (!latestVersion) {
      return;
    }

    suppressUpdateVersion(latestVersion, mode === 'today-version' ? 'today' : 'forever');
  };

  if (!isHydrated) {
    return (
      <ReactFlowProvider>
        <div className="flex h-full w-full items-center justify-center bg-bg-dark px-6">
          {hydrationError ? (
            <div className="w-full max-w-lg space-y-4 border border-[var(--ui-border-soft)] bg-surface-dark p-6">
              <h1 className="text-base font-semibold text-text-dark">
                {t('project.storageUnavailableTitle')}
              </h1>
              <p className="text-sm leading-6 text-text-muted">
                {t('project.storageUnavailableMessage')}
              </p>
              <details className="text-xs text-text-muted">
                <summary className="cursor-pointer">{t('project.storageErrorDetails')}</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words">{hydrationError}</pre>
              </details>
              <UiButton variant="primary" onClick={() => void hydrate()}>
                {t('project.storageRetry')}
              </UiButton>
            </div>
          ) : null}
        </div>
      </ReactFlowProvider>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="w-full h-full flex flex-col bg-bg-dark">
        <TitleBar
          onSettingsClick={() => {
            setSettingsInitialCategory('general');
            setShowSettings(true);
          }}
          showBackButton={Boolean(currentProjectId || activeHomeTool)}
          onBackClick={activeHomeTool ? () => homeToolBackHandlerRef.current() : closeProject}
          contextTitle={activeHomeTool ? t('batchCrop.entry') : undefined}
        />

        <main className="relative min-h-0 flex-1 overflow-hidden">
          <StorageStatusNotice
            backupService={browserProjectBackupService}
            storageStatusService={browserStorageStatusService}
          />
          {currentProjectId ? (
            <Canvas />
          ) : activeHomeTool === 'batch-crop' ? (
            <BatchImageCropWorkbench
              backHandlerRef={homeToolBackHandlerRef}
              onExit={() => setActiveHomeTool(null)}
            />
          ) : (
            <ProjectManager
              onOpenBatchCrop={() => setActiveHomeTool('batch-crop')}
              backupService={browserProjectBackupService}
              importService={browserProjectImportService}
            />
          )}
        </main>

        <SettingsDialog
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          initialCategory={settingsInitialCategory}
        />
        <UpdateAvailableDialog
          isOpen={showUpdateDialog}
          onClose={() => setShowUpdateDialog(false)}
          latestVersion={latestVersion}
          currentVersion={currentVersion}
          onApplyIgnore={handleApplyIgnore}
        />
        <GlobalErrorDialog
          isOpen={Boolean(globalError || projectPersistenceError || settingsPersistenceError)}
          title={globalError?.title ?? t('project.storageUnavailableTitle')}
          message={
            globalError?.message
            ?? t('project.storageUnavailableMessage')
          }
          details={globalError?.details ?? projectPersistenceError ?? settingsPersistenceError ?? undefined}
          copyText={globalError?.copyText}
          actionLabel={globalError ? undefined : t('project.storageReload')}
          onAction={globalError ? undefined : () => window.location.reload()}
          onClose={() => {
            setGlobalError(null);
            clearProjectPersistenceError();
            clearSettingsPersistenceError();
          }}
        />
        {import.meta.env.DEV && <LogPanel />}
      </div>
    </ReactFlowProvider>
  );
}

export default App;
