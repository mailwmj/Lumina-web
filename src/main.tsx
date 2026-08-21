import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./i18n";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";
import "react-image-crop/dist/ReactCrop.css";
import { registerAppShellServiceWorker } from './runtime/appShell';
import { version as packageVersion } from '../package.json';
import { createBrowserProjectBackupService } from './features/assets/application/browserProjectBackup';
import { createBrowserProjectImportService } from './features/assets/application/browserProjectImport';
import { createBrowserSettingsDiagnosticsService } from './features/settings/application/browserSettingsDiagnosticsService';
import { createProjectRepository } from './features/project/application/createProjectRepository';
import type { BrowserStorageStatusService } from './features/assets/application/browserStorageStatus';
import {
  readBrowserStorageStatus,
  STORAGE_CAPACITY_ERROR_EVENT,
} from './runtime/browserStorage';
import { getRuntimeAssetRepository } from './runtime/mediaRuntime';
import { captureReadonlyCanvasBootstrap } from "./features/canvas-agent/infrastructure/readonlyCanvasBootstrap";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const browserStorageStatusService: BrowserStorageStatusService = {
  read: (requestPersistence) => readBrowserStorageStatus(undefined, { requestPersistence }),
  subscribeToCapacityErrors: (listener) => {
    window.addEventListener(STORAGE_CAPACITY_ERROR_EVENT, listener);
    return () => window.removeEventListener(STORAGE_CAPACITY_ERROR_EVENT, listener);
  },
};
const browserProjectBackupService = createBrowserProjectBackupService(
  getRuntimeAssetRepository(),
  createProjectRepository(),
);
const browserProjectImportService = createBrowserProjectImportService();
const browserSettingsDiagnosticsService = createBrowserSettingsDiagnosticsService();

void registerAppShellServiceWorker({
  version: import.meta.env.VITE_APP_VERSION || packageVersion,
});
captureReadonlyCanvasBootstrap(window.location, window.history);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App
        browserProjectBackupService={browserProjectBackupService}
        browserProjectImportService={browserProjectImportService}
        browserStorageStatusService={browserStorageStatusService}
        browserSettingsDiagnosticsService={browserSettingsDiagnosticsService}
      />
    </QueryClientProvider>
  </React.StrictMode>,
);
