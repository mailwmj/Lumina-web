import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

test('GitHub installer releases require the selected native targets and explicit evidence', () => {
  const workflow = readRepositoryFile('.github/workflows/build.yml');
  const packageJson = JSON.parse(readRepositoryFile('package.json'));

  assert.match(workflow, /push:\s*\n\s+tags:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /release_mode:/u);
  assert.match(workflow, /unsigned/u);
  assert.match(workflow, /verify-local-release:/u);
  assert.match(workflow, /npm run verify:local-release -- --channel beta/u);
  assert.match(workflow, /npm run verify:local-release -- --channel complete/u);
  assert.match(workflow, /platform:\s*win32\s*\n\s*arch:\s*x64/u);
  assert.match(workflow, /platform:\s*darwin\s*\n\s*arch:\s*arm64/u);
  assert.doesNotMatch(workflow, /platform:\s*win32\s*\n\s*arch:\s*arm64/u);
  assert.doesNotMatch(workflow, /platform:\s*darwin\s*\n\s*arch:\s*x64/u);
  assert.doesNotMatch(workflow, /self-hosted.*Windows.*ARM64/u);
  assert.match(workflow, /const expectedTargets = new Set\(\['win32-x64', 'darwin-arm64'\]\)/u);
  assert.match(workflow, /npm run package:installer -- --platform/u);
  assert.doesNotMatch(workflow, /package:installer:prepare/u);
  assert.match(workflow, /signtool\.exe verify/u);
  assert.match(workflow, /codesign --verify/u);
  assert.match(workflow, /stapler validate/u);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /softprops\/action-gh-release@v1/u);
  assert.match(workflow, /Record unsigned test artifact metadata/u);
  assert.match(workflow, /releaseMode: 'unsigned-test'/u);
  assert.match(workflow, /Create GitHub Release/u);
  assert.match(workflow, /not code-signed or notarized/u);
  assert.match(workflow, /SHA-256 mismatch/u);
  assert.match(workflow, /cat-file', '-t', `refs\/tags\/\$\{tag\}`/u);
  assert.match(workflow, /must be annotated/u);
  assert.match(workflow, /environment:\s*release-signing/u);
  assert.match(workflow, /entry\.name\.endsWith\('-metadata\.json'\)/u);
  assert.match(workflow, /release-assets\/\*\*\/\*-verification\.txt/u);
  assert.match(workflow, /release-assets\/\*\*\/\*-metadata\.json/u);
  assert.match(workflow, /needs: \[build-web, verify-local-release, package-installer\]/u);
  assert.equal(packageJson.scripts['test:github-installers'], 'node --test scripts/github-installer-release-contract.node-test.mjs');
});

test('release documentation keeps installation browser-first and documents protected signing setup', () => {
  const documentation = readRepositoryFile('docs/deployment/github-installers.md');

  assert.match(documentation, /lumina:\/\/open/u);
  assert.match(documentation, /Chrome/u);
  assert.match(documentation, /Codex/u);
  assert.match(documentation, /Node\.js/u);
  assert.match(documentation, /LUMINA_WINDOWS_CERTIFICATE_BASE64/u);
  assert.match(documentation, /LUMINA_MACOS_NOTARY_KEY_BASE64/u);
  assert.match(documentation, /lumina-release/u);
  assert.doesNotMatch(documentation, /-----BEGIN/u);
});
