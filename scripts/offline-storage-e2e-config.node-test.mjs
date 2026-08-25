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
  const packageJson = JSON.parse(readFile('package.json'));
  const baseConfig = readFile('playwright.config.ts');
  const offlineStorageConfig = readFile('playwright.offline-storage.config.ts');
  const releaseContract = readFile('scripts/web-release-contract.mjs');

  assert.equal(
    packageJson.scripts['test:offline-storage-e2e'],
    'playwright test --config playwright.offline-storage.config.ts --workers=1',
  );
  assert.match(
    packageJson.scripts['test:web-only'],
    /scripts\/offline-storage-e2e-config\.node-test\.mjs/u,
  );
  assert.match(baseConfig, /npm run dev -- --host 127\.0\.0\.1 --port \$\{e2ePort\}/u);
  assert.match(baseConfig, /testIgnore:\s*'\*\*\/offline-storage\.e2e\.ts'/u);
  assert.match(
    baseConfig,
    /LUMINA_E2E_REUSE_EXISTING_SERVER === 'true'\s*\|\| \(process\.env\.LUMINA_E2E_REUSE_EXISTING_SERVER !== 'false' && !process\.env\.CI\)/u,
  );
  assert.match(offlineStorageConfig, /testMatch:\s*'offline-storage\.e2e\.ts'/u);
  assert.match(offlineStorageConfig, /testIgnore:\s*\[\]/u);
  assert.match(offlineStorageConfig, /npm run build && npm run preview/u);
  assert.match(offlineStorageConfig, /reuseExistingServer:\s*false/u);
  assert.doesNotMatch(
    releaseContract,
    /id: 'offline-storage-e2e-production-chromium',\s*command: \['npm', 'run', 'test:offline-storage-e2e'\]/u,
  );
  assert.match(releaseContract, /'playwright\.offline-storage\.config\.ts'/u);
  assert.match(releaseContract, /'scripts\/offline-storage-e2e-config\.node-test\.mjs'/u);
});
