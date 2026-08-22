import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'production-local-runtime.e2e.ts',
  fullyParallel: false,
  reporter: 'line',
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    channel: 'chrome',
  },
});
