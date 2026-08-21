import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function readRepositoryFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return readRepositoryFiles(entryPath);
    }
    return [entryPath];
  });
}

function readTextTree(directory) {
  return readRepositoryFiles(path.join(repositoryRoot, directory))
    .filter((filePath) => /\.(?:[cm]?[jt]sx?|json|ya?ml)$/u.test(filePath))
    .map((filePath) => fs.readFileSync(filePath, 'utf8'))
    .join('\n');
}

function readActiveDocumentation() {
  return [
    'README.md',
    'AGENTS.md',
    'docs/development-guides/provider-and-model-extension.md',
    'docs/development-guides/tos-media-storage.md',
    'docs/agents/external-agent-mcp.md',
    'docs/migration/v0.2.37-equivalence-matrix.md',
  ].map((filePath) => fs.readFileSync(path.join(repositoryRoot, filePath), 'utf8')).join('\n');
}

test('Web delivery has no desktop runtime or packaging boundary', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const packageLock = fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8');
  const applicationSource = readTextTree('src');
  const companionSource = readTextTree('canvas-agent/src');
  const workflowSource = readTextTree('.github');
  const activeDocumentation = readActiveDocumentation();
  const playwrightConfig = fs.readFileSync(path.join(repositoryRoot, 'playwright.config.ts'), 'utf8');
  const ignoredPaths = fs.readFileSync(path.join(repositoryRoot, '.gitignore'), 'utf8');

  assert.equal(fs.existsSync(path.join(repositoryRoot, 'src-tauri')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'src', 'commands')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'src', 'features', 'update')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'scripts', 'run-tauri.mjs')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'scripts', 'build-canvas-agent-sidecar.mjs')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'scripts', 'smoke-canvas-agent-sidecar.mjs')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'public', 'tauri.svg')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'src', 'features', 'canvas', 'infrastructure', 'tauriAiGateway.ts')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'src', 'features', 'canvas', 'infrastructure', 'tauriImageSplitGateway.ts')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'src', 'features', 'project', 'infrastructure', 'tauriProjectRepository.ts')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'src', 'features', 'media', 'infrastructure', 'tauriMediaProcessor.ts')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'src', 'features', 'batch-image-crop', 'infrastructure', 'tauriBatchImageCropGateway.ts')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'canvas-agent', 'src', 'config.ts')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'canvas-agent', 'src', 'server')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'canvas-agent', 'src', 'web')), true);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'canvas-agent', 'src', 'readonly', 'localCanvasHost.ts')), true);
  assert.equal(fs.existsSync(path.join(repositoryRoot, '.vscode', 'extensions.json')), false);

  assert.doesNotMatch(JSON.stringify(packageJson), /@tauri-apps|sidecar|run-tauri/iu);
  assert.doesNotMatch(packageLock, /@tauri-apps/iu);
  assert.doesNotMatch(applicationSource, /@tauri-apps|isTauri|src-tauri/iu);
  assert.doesNotMatch(applicationSource, /isDesktop|openDirectory/iu);
  assert.doesNotMatch(companionSource, /tauri\.localhost|Tauri/iu);
  assert.doesNotMatch(workflowSource, /tauri|\.dmg|\.exe|sidecar/iu);
  assert.match(workflowSource, /LUMINA_E2E_SERVER_COMMAND:\s*npm run preview/iu);
  assert.match(workflowSource, /run:\s*npm run test:e2e/iu);
  assert.match(playwrightConfig, /process\.env\.LUMINA_E2E_SERVER_COMMAND/iu);
  assert.doesNotMatch(ignoredPaths, /src-tauri|rustup|lumina-canvas-agent-/iu);
  assert.doesNotMatch(activeDocumentation, /\bTauri\b|src-tauri|\bRust\b|\bSQLite\b|\bcargo\b|\.dmg|\.exe|sidecar/iu);
});
