import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readFile(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

test('offline storage E2E uses a scoped production preview without changing the base server', () => {
  const baseConfig = readFile('playwright.config.ts');
  const offlineStorageConfig = readFile('playwright.offline-storage.config.ts');

  assert.match(baseConfig, /npm run dev -- --host 127\.0\.0\.1 --port \$\{e2ePort\}/u);
  assert.match(
    baseConfig,
    /LUMINA_E2E_REUSE_EXISTING_SERVER === 'true'\s*\|\| \(process\.env\.LUMINA_E2E_REUSE_EXISTING_SERVER !== 'false' && !process\.env\.CI\)/u,
  );
  assert.match(offlineStorageConfig, /testMatch:\s*'offline-storage\.e2e\.ts'/u);
  assert.match(offlineStorageConfig, /npm run build && npm run preview/u);
  assert.match(offlineStorageConfig, /reuseExistingServer:\s*false/u);
});
