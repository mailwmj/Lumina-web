import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './features/canvas/Canvas';
import { TitleBar } from './components/TitleBar';
import { LogPanel } from '@/lib/logger/LogPanel';
import { useLogPanelHotkey } from '@/lib/logger/useLogPanelHotkey';
import { SettingsDialog } from './components/SettingsDialog';
import { GlobalErrorDialog } from './components/GlobalErrorDialog';
import { ProjectManager } from './features/project/ProjectManager';
import { BatchImageCropWorkbench } from './features/batch-image-crop/BatchImageCropWorkbench';
import { useThemeStore } from './stores/themeStore';
import { useProjectStore } from './stores/projectStore';
import { useCanvasStore } from './stores/canvasStore';
import { useSettingsStore } from './stores/settingsStore';
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
import { UiButton } from './components/ui';
import { createBatchImageCropResultSink } from './features/batch-image-crop/application/batchImageCropProjectResults';
import type { BrowserSettingsDiagnosticsService } from './features/settings/application/browserSettingsDiagnosticsService';
import { readBrowserCapabilities } from './runtime/browserCapabilities';
import { subscribeToAppShellUpdates } from './runtime/appShell';
import { BrowserCompatibilityNotice } from './features/app/BrowserCompatibilityNotice';
import { WebAppUpdateNotice } from './features/app/WebAppUpdateNotice';
import { CodexWebCanvasBridge } from './features/canvas-agent/ui/CodexWebCanvasBridge';

interface AppProps {
  browserSettingsDiagnosticsService: BrowserSettingsDiagnosticsService | null;
}

function App({ browserSettingsDiagnosticsService }: AppProps) {
  const { t } = useTranslation();
  useLogPanelHotkey();
  const { theme } = useThemeStore();
  const accentColor = useSettingsStore((state) => state.accentColor);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<SettingsCategory>('general');
  const [isWebAppUpdateReady, setIsWebAppUpdateReady] = useState(false);
  const [globalError, setGlobalError] = useState<GlobalErrorDialogDetail | null>(null);
  const [activeHomeTool, setActiveHomeTool] = useState<'batch-crop' | null>(null);
  const [batchCropProjectId, setBatchCropProjectId] = useState<string | null>(null);
  const homeToolBackHandlerRef = useRef<() => void>(() => undefined);
  const browserCapabilities = useMemo(() => readBrowserCapabilities(), []);

  const isHydrated = useProjectStore((state) => state.isHydrated);
  const hydrate = useProjectStore((state) => state.hydrate);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const currentProject = useProjectStore((state) => state.currentProject);
  const closeProject = useProjectStore((state) => state.closeProject);
  const createProject = useProjectStore((state) => state.createProject);
  const hydrationError = useProjectStore((state) => state.hydrationError);
  const hydrationErrorCode = useProjectStore((state) => state.hydrationErrorCode);
  const projectPersistenceError = useProjectStore((state) => state.persistenceError);
  const projectPersistenceErrorCode = useProjectStore((state) => state.persistenceErrorCode);
  const clearProjectPersistenceError = useProjectStore((state) => state.clearPersistenceError);
  const settingsPersistenceError = useSettingsStore((state) => state.persistenceError);
  const clearSettingsPersistenceError = useSettingsStore((state) => state.clearPersistenceError);
  const canvasNodes = useCanvasStore((state) => state.nodes);
  const canvasEdges = useCanvasStore((state) => state.edges);
  const canvasViewport = useCanvasStore((state) => state.currentViewport);
  const selectedCanvasNodeIds = useMemo(
    () => canvasNodes.flatMap((node) => node.selected ? [node.id] : []),
    [canvasNodes],
  );
  const hydrationNeedsUpdate = hydrationErrorCode === 'runtime_api_incompatible';
  const persistenceNeedsUpdate = projectPersistenceErrorCode === 'runtime_api_incompatible';
  const batchCropResultSink = useMemo(
    () => batchCropProjectId ? createBatchImageCropResultSink(batchCropProjectId) : null,
    [batchCropProjectId],
  );
  const openBatchCrop = useCallback(() => {
    const projectId = createProject(t('batchCrop.projectName'));
    useCanvasStore.getState().setCanvasData([], [], { past: [], future: [] });
    setBatchCropProjectId(projectId);
    setActiveHomeTool('batch-crop');
  }, [createProject, t]);

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
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
      return;
    }
    return subscribeToAppShellUpdates(navigator.serviceWorker, () => {
      setIsWebAppUpdateReady(true);
    });
  }, []);

  const codexCanvasBridge = (
    <CodexWebCanvasBridge
      projectId={currentProject?.id ?? null}
      projectName={currentProject?.name ?? ''}
      nodes={canvasNodes}
      edges={canvasEdges}
      selectedNodeIds={selectedCanvasNodeIds}
      viewport={canvasViewport}
    />
  );

  const appContent = !isHydrated ? (
    <div className="flex h-full w-full items-center justify-center bg-bg-dark px-6">
      {hydrationError ? (
        <div className="w-full max-w-lg space-y-4 border border-[var(--ui-border-soft)] bg-surface-dark p-6">
          <h1 className="text-base font-semibold text-text-dark">
            {t(hydrationNeedsUpdate ? 'project.runtimeUpdateRequiredTitle' : 'project.runtimeUnavailableTitle')}
          </h1>
          <p className="text-sm leading-6 text-text-muted">
            {t(hydrationNeedsUpdate ? 'project.runtimeUpdateRequiredMessage' : 'project.runtimeUnavailableMessage')}
          </p>
          <details className="text-xs text-text-muted">
            <summary className="cursor-pointer">{t('project.runtimeErrorDetails')}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words">{hydrationError}</pre>
          </details>
          <UiButton
            variant="primary"
            onClick={hydrationNeedsUpdate ? () => window.location.reload() : () => void hydrate()}
          >
            {t(hydrationNeedsUpdate ? 'project.runtimeUpdateReload' : 'project.storageRetry')}
          </UiButton>
        </div>
      ) : null}
    </div>
  ) : (
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
          <BrowserCompatibilityNotice capabilities={browserCapabilities} />
          <WebAppUpdateNotice
            isReady={isWebAppUpdateReady}
            onReload={() => window.location.reload()}
          />
          {activeHomeTool === 'batch-crop' && batchCropResultSink ? (
            <BatchImageCropWorkbench
              backHandlerRef={homeToolBackHandlerRef}
              onExit={() => {
                setActiveHomeTool(null);
                setBatchCropProjectId(null);
              }}
              projectId={batchCropProjectId ?? undefined}
              resultSink={batchCropResultSink}
            />
          ) : currentProjectId ? (
            <Canvas />
          ) : (
            <ProjectManager onOpenBatchCrop={openBatchCrop} />
          )}
        </main>

        <SettingsDialog
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          initialCategory={settingsInitialCategory}
          browserSettingsDiagnosticsService={browserSettingsDiagnosticsService}
        />
        <GlobalErrorDialog
          isOpen={Boolean(globalError || projectPersistenceError || settingsPersistenceError)}
          title={globalError?.title ?? t(
            persistenceNeedsUpdate ? 'project.runtimeUpdateRequiredTitle' : 'project.storageUnavailableTitle',
          )}
          message={
            globalError?.message
            ?? t(
              persistenceNeedsUpdate
                ? 'project.runtimeUpdateRequiredMessage'
                : 'project.storageUnavailableMessage',
            )
          }
          details={globalError?.details ?? projectPersistenceError ?? settingsPersistenceError ?? undefined}
          copyText={globalError?.copyText}
          actionLabel={globalError ? undefined : t(
            persistenceNeedsUpdate ? 'project.runtimeUpdateReload' : 'project.storageReload',
          )}
          onAction={globalError ? undefined : () => window.location.reload()}
          onClose={() => {
            setGlobalError(null);
            clearProjectPersistenceError();
            clearSettingsPersistenceError();
          }}
        />
        {import.meta.env.DEV && <LogPanel />}
      </div>
  );

  return (
    <ReactFlowProvider>
      {appContent}
      {codexCanvasBridge}
    </ReactFlowProvider>
  );
}

export default App;
