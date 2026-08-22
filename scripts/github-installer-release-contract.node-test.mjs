import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

test('GitHub installer releases publish the supported unsigned beta targets with verified integrity metadata', () => {
  const workflow = readRepositoryFile('.github/workflows/build.yml');
  const packageJson = JSON.parse(readRepositoryFile('package.json'));

  assert.match(workflow, /push:\s*\n\s+tags:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /verify-local-release:/u);
  assert.match(workflow, /npm run verify:local-release -- --channel beta/u);
  assert.match(workflow, /platform:\s*win32\s*\n\s*arch:\s*x64/u);
  assert.doesNotMatch(workflow, /platform:\s*win32\s*\n\s*arch:\s*arm64/u);
  assert.match(workflow, /platform:\s*darwin\s*\n\s*arch:\s*x64/u);
  assert.match(workflow, /platform:\s*darwin\s*\n\s*arch:\s*arm64/u);
  const macosX64Start = workflow.indexOf('          - platform: darwin\n            arch: x64');
  const macosArm64Start = workflow.indexOf('          - platform: darwin\n            arch: arm64');
  const macosX64Row = workflow.slice(macosX64Start, macosArm64Start);
  const macosArm64Row = workflow.slice(macosArm64Start, workflow.indexOf('    runs-on:', macosArm64Start));
  assert.match(macosX64Row, /runner: '\["macos-15-intel"\]'/u);
  assert.match(macosArm64Row, /runner: '\["macos-15"\]'/u);
  assert.doesNotMatch(workflow, /macos-13/u);
  assert.doesNotMatch(workflow, /macos-14/u);
  assert.match(workflow, /npm run package:installer:unsigned -- --platform/u);
  assert.doesNotMatch(workflow, /environment:\s*release-signing/u);
  assert.doesNotMatch(workflow, /LUMINA_WINDOWS_CERTIFICATE_BASE64/u);
  assert.doesNotMatch(workflow, /LUMINA_MACOS_NOTARY_KEY_BASE64/u);
  assert.doesNotMatch(workflow, /signtool\.exe/u);
  assert.doesNotMatch(workflow, /codesign --verify/u);
  assert.doesNotMatch(workflow, /stapler validate/u);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /softprops\/action-gh-release@v1/u);
  assert.match(workflow, /RELEASE_ASSET_NAME/u);
  assert.match(workflow, /SHA-256 mismatch/u);
  assert.match(workflow, /cat-file', '-t', `refs\/tags\/\$\{tag\}`/u);
  assert.match(workflow, /must be annotated/u);
  assert.match(workflow, /entry\.name\.endsWith\('-metadata\.json'\)/u);
  assert.match(workflow, /release-assets\/\*\*\/\*-verification\.txt/u);
  assert.match(workflow, /release-assets\/\*\*\/\*-metadata\.json/u);
  assert.match(workflow, /needs: \[build-web, verify-local-release, package-installer\]/u);
  assert.match(workflow, /prerelease:\s*true/u);
  assert.match(workflow, /unsigned beta/u);
  const windowsVerificationStart = workflow.indexOf('      - name: Verify unsigned Windows beta');
  const macosVerificationStart = workflow.indexOf('      - name: Verify unsigned macOS beta');
  const windowsVerification = workflow.slice(windowsVerificationStart, macosVerificationStart);
  assert.match(windowsVerification, /shell: pwsh/u);
  assert.match(windowsVerification, /\[ordered\]@\{/u);
  assert.doesNotMatch(windowsVerification, /<<'NODE'/u);
  assert.equal(packageJson.scripts['test:github-installers'], 'node --test scripts/github-installer-release-contract.node-test.mjs');
});

test('release documentation keeps unsigned beta installation browser-first and labels platform trust limits', () => {
  const documentation = readRepositoryFile('docs/deployment/github-installers.md');

  assert.match(documentation, /lumina:\/\/open/u);
  assert.match(documentation, /Chrome/u);
  assert.match(documentation, /Codex/u);
  assert.match(documentation, /Node\.js/u);
  assert.match(documentation, /unsigned beta/u);
  assert.match(documentation, /SmartScreen/u);
  assert.match(documentation, /Gatekeeper/u);
  assert.match(documentation, /Windows x64/u);
  assert.match(documentation, /macOS x64/u);
  assert.match(documentation, /macOS arm64/u);
  assert.doesNotMatch(documentation, /Windows arm64/u);
  assert.doesNotMatch(documentation, /LUMINA_WINDOWS_CERTIFICATE_BASE64/u);
  assert.doesNotMatch(documentation, /LUMINA_MACOS_NOTARY_KEY_BASE64/u);
  assert.doesNotMatch(documentation, /-----BEGIN/u);
});
