import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

const offlineStoragePort = process.env.LUMINA_OFFLINE_STORAGE_E2E_PORT ?? '4175';
const offlineStorageBaseUrl = `http://127.0.0.1:${offlineStoragePort}`;

export default defineConfig({
  ...baseConfig,
  testMatch: 'offline-storage.e2e.ts',
  testIgnore: [],
  use: {
    ...baseConfig.use,
    baseURL: offlineStorageBaseUrl,
  },
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${offlineStoragePort}`,
    url: offlineStorageBaseUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
