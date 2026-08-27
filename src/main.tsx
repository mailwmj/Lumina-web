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
import { createBrowserSettingsDiagnosticsService } from './features/settings/application/browserSettingsDiagnosticsService';
import { runtimeProjectClient } from './runtime/runtimeProjectClient';
import { captureCanvasBootstrap } from './features/canvas-agent/infrastructure/canvasBootstrap';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const browserSettingsDiagnosticsService = createBrowserSettingsDiagnosticsService();

void registerAppShellServiceWorker({
  version: import.meta.env.VITE_APP_VERSION || packageVersion,
});
void runtimeProjectClient.initialize().catch(() => undefined);
window.addEventListener('pagehide', () => {
  void runtimeProjectClient.close().catch(() => undefined);
}, { once: true });
captureCanvasBootstrap(window.location, window.history);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App browserSettingsDiagnosticsService={browserSettingsDiagnosticsService} />
    </QueryClientProvider>
  </React.StrictMode>,
);
