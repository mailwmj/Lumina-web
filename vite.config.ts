import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// @ts-expect-error process is a nodejs global
const gatewayOrigin = process.env.LUMINA_GATEWAY_ORIGIN || "http://127.0.0.1:8787";
const localCanvasHost = process.env.LUMINA_CANVAS_LOCAL_HOST === '1';

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

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
}));
