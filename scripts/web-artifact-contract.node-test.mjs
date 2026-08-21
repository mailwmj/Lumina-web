import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const forbiddenArtifactExtensions = /\.(?:app|dll|dmg|exe|msi|node)$/iu;
const forbiddenDesktopReferences = /@tauri-apps|src-tauri|tauri\.localhost/iu;

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listFiles(entryPath);
    }
    return [entryPath];
  });
}

function relativeFiles(directory) {
  return listFiles(directory)
    .map((filePath) => path.relative(directory, filePath).replaceAll('\\', '/'))
    .sort();
}

function releaseTextFiles(directory) {
  return listFiles(directory).filter((filePath) => /\.(?:css|html|js|json|svg)$/iu.test(filePath));
}

test('production Web artifacts are static, companion-packaged, and free of desktop runtime references', () => {
  const webDist = path.join(repositoryRoot, 'dist');
  const companionDist = path.join(repositoryRoot, 'canvas-agent', 'web-dist');

  assert.equal(fs.existsSync(path.join(webDist, 'index.html')), true);
  assert.equal(fs.existsSync(path.join(companionDist, 'index.html')), true);
  assert.deepEqual(relativeFiles(companionDist), relativeFiles(webDist));

  const artifactFiles = [...listFiles(webDist), ...listFiles(companionDist)];
  for (const filePath of artifactFiles) {
    assert.doesNotMatch(path.basename(filePath), forbiddenArtifactExtensions);
    assert.ok(fs.statSync(filePath).size > 0, `${filePath} must not be empty.`);
  }

  const artifactText = [...releaseTextFiles(webDist), ...releaseTextFiles(companionDist)]
    .map((filePath) => fs.readFileSync(filePath, 'utf8'))
    .join('\n');
  assert.doesNotMatch(artifactText, forbiddenDesktopReferences);
});
