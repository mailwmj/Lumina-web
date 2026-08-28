import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

test('GitHub installer releases publish unsigned native targets with verified artifact metadata', () => {
  const workflow = readRepositoryFile('.github/workflows/build.yml');
  const packageJson = JSON.parse(readRepositoryFile('package.json'));

  assert.match(workflow, /push:\s*\n\s+tags:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /verify-local-release:/u);
  assert.match(workflow, /npm run verify:local-release -- --channel beta/u);
  assert.match(workflow, /platform:\s*win32\s*\n\s*arch:\s*x64/u);
  assert.match(workflow, /platform:\s*darwin\s*\n\s*arch:\s*arm64/u);
  assert.doesNotMatch(workflow, /platform:\s*win32\s*\n\s*arch:\s*arm64/u);
  assert.doesNotMatch(workflow, /platform:\s*darwin\s*\n\s*arch:\s*x64/u);
  assert.doesNotMatch(workflow, /self-hosted.*Windows.*ARM64/u);
  assert.match(workflow, /const expectedTargets = new Set\(\['win32-x64', 'darwin-arm64'\]\)/u);
  assert.match(workflow, /npm run package:installer -- --platform/u);
  assert.match(workflow, /LUMINA_EMBEDDED_TOS_ACCESS_KEY:\s*\$\{\{\s*secrets\.LUMINA_TOS_ACCESS_KEY\s*\}\}/u);
  assert.match(workflow, /LUMINA_EMBEDDED_TOS_SECRET_KEY:\s*\$\{\{\s*secrets\.LUMINA_TOS_SECRET_KEY\s*\}\}/u);
  assert.doesNotMatch(workflow, /package:installer:prepare/u);
  assert.match(workflow, /--unsigned/u);
  assert.doesNotMatch(workflow, /release_mode:/u);
  assert.doesNotMatch(workflow, /RELEASE_SIGNING_MODE/u);
  assert.doesNotMatch(workflow, /release-signing/u);
  assert.doesNotMatch(workflow, /LUMINA_(?:WINDOWS_CERTIFICATE|MACOS_.*(?:CERTIFICATE|SIGN_IDENTITY|NOTARY))/u);
  assert.doesNotMatch(workflow, /signtool\.exe|codesign --verify|stapler validate/u);
  assert.doesNotMatch(workflow, /npm run verify:(?:web-release|local-release) -- --channel complete/u);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /include-hidden-files:\s*true/u);
  assert.match(workflow, /plugins\/lumina-canvas/u);
  assert.match(workflow, /Verify Lumina-owned Codex plugin payload/u);
  assert.match(workflow, /\.codex-plugin\/plugin\.json/u);
  assert.match(workflow, /skills\/open-lumina-canvas\/SKILL\.md/u);
  assert.match(workflow, /plugin\.node-test\.mjs/u);
  assert.match(workflow, /softprops\/action-gh-release@v1/u);
  assert.match(workflow, /Record unsigned release metadata/u);
  assert.match(workflow, /releaseMode: 'unsigned'/u);
  assert.match(workflow, /Create GitHub Release/u);
  assert.match(workflow, /body:\s*\|\s*\n\s*Lumina unsigned installer release\. Windows x64 and macOS arm64 packages/u);
  assert.match(workflow, /not code-signed or notarized/u);
  assert.match(workflow, /SHA-256 mismatch/u);
  assert.match(workflow, /cat-file', '-t', `refs\/tags\/\$\{tag\}`/u);
  assert.match(workflow, /must be annotated/u);
  assert.match(workflow, /entry\.name\.endsWith\('-metadata\.json'\)/u);
  assert.match(workflow, /release-assets\/\*\*\/\*-verification\.txt/u);
  assert.match(workflow, /release-assets\/\*\*\/\*-metadata\.json/u);
  assert.match(workflow, /needs: \[build-web, verify-local-release, package-installer\]/u);
  assert.equal(packageJson.scripts['test:github-installers'], 'node --test scripts/github-installer-release-contract.node-test.mjs');
});

test('release documentation keeps installation browser-first and documents unsigned GitHub releases', () => {
  const documentation = readRepositoryFile('docs/deployment/github-installers.md');

  assert.match(documentation, /lumina:\/\/open/u);
  assert.match(documentation, /Chrome/u);
  assert.match(documentation, /Codex/u);
  assert.match(documentation, /Node\.js/u);
  assert.match(documentation, /Lumina-Codex-Plugin/u);
  assert.match(documentation, /不会修改 Codex/u);
  assert.match(documentation, /所有 GitHub 安装包均使用无签名模式发布/u);
  assert.match(documentation, /未代码签名、未公证/u);
  assert.doesNotMatch(documentation, /LUMINA_WINDOWS_CERTIFICATE_BASE64|LUMINA_MACOS_NOTARY_KEY_BASE64|lumina-release/u);
  assert.doesNotMatch(documentation, /-----BEGIN/u);
});
