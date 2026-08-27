import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

import { computeAppShellRevision } from './scripts/appShellRevision.mjs';

const gatewayOrigin = process.env.LUMINA_GATEWAY_ORIGIN || "http://127.0.0.1:8787";
const localCanvasHost = process.env.LUMINA_CANVAS_LOCAL_HOST === '1';

// https://vite.dev/config/
export default defineConfig(async () => {
  const appShellRevision = await computeAppShellRevision(__dirname);
  return {
    plugins: [
      react(),
      {
        name: 'lumina-app-shell-revision-manifest',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'app-shell-revision.json',
            source: JSON.stringify({ revision: appShellRevision }),
          });
        },
      },
    ],
    define: {
      'import.meta.env.VITE_APP_SHELL_REVISION': JSON.stringify(appShellRevision),
    },

    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },

    clearScreen: false,
    server: {
      port: localCanvasHost ? 0 : 5173,
      strictPort: localCanvasHost,
      host: localCanvasHost ? '127.0.0.1' : undefined,
      proxy: {
        // Browser generation calls stay same-origin in development; the gateway
        // process owns the upstream allowlist and credential boundary.
        "/api/generation": {
          target: gatewayOrigin,
          changeOrigin: false,
          secure: false,
        },
      },
    },
  };
});
