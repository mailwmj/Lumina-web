import { defineConfig, devices } from '@playwright/test';

const e2ePort = process.env.LUMINA_E2E_PORT ?? '4174';
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;
const e2eServerCommand = process.env.LUMINA_E2E_SERVER_COMMAND
  ?? `npm run dev -- --host 127.0.0.1 --port ${e2ePort}`;
const e2eBrowser = process.env.LUMINA_E2E_BROWSER ?? 'chrome';
const reuseExistingServer = process.env.LUMINA_E2E_REUSE_EXISTING_SERVER === 'true'
  || (process.env.LUMINA_E2E_REUSE_EXISTING_SERVER !== 'false' && !process.env.CI);

if (!['chrome', 'edge', 'chromium'].includes(e2eBrowser)) {
  throw new Error('LUMINA_E2E_BROWSER must be chrome, edge, or chromium.');
}

const browserUse = e2eBrowser === 'chromium'
  ? { browserName: 'chromium' as const }
  : {
      browserName: 'chromium' as const,
      channel: e2eBrowser === 'edge' ? 'msedge' : 'chrome',
    };

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'line',
  use: {
    baseURL: e2eBaseUrl,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    ...browserUse,
  },
  webServer: {
    command: e2eServerCommand,
    url: e2eBaseUrl,
    reuseExistingServer,
    timeout: 120_000,
  },
});
