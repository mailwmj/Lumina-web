import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareInstaller } from './packageInstaller.mjs';

test('prepares a Windows clean-install payload with a hidden protocol launcher and a port-free bookmark', async () => {
  const fixture = await createFixture('LuminaRuntime.exe');
  try {
    const result = await prepareInstaller({
      platform: 'win32',
      arch: 'x64',
      version: '1.2.3',
      runtimeExecutable: fixture.runtimeExecutable,
      webRoot: fixture.webRoot,
      outputDirectory: fixture.outputDirectory,
    });
    const setup = await fs.readFile(path.join(result.stageDirectory, 'Lumina.iss'), 'utf8');
    const bookmark = await fs.readFile(path.join(result.stageDirectory, 'Lumina.url'), 'utf8');
    const payload = await relativeFiles(path.join(result.stageDirectory, 'app'));

    assert.equal(await pathExists(path.join(result.stageDirectory, 'app', 'LuminaRuntime.exe')), true);
    assert.equal(await pathExists(path.join(result.stageDirectory, 'app', 'web', 'index.html')), true);
    assert.match(setup, /Software\\Classes\\lumina/u);
    assert.match(setup, /LuminaProtocol\.vbs/u);
    assert.doesNotMatch(setup, /#define StagingRoot "\{#StagingRoot\}"/u);
    assert.doesNotMatch(setup, /\[Run\]/u);
    assert.match(setup, /OutputDir=\{#StagingRoot\}\\release/u);
    assert.match(setup, /Lumina could not register lumina:\/\/ links/u);
    assert.equal(bookmark, '[InternetShortcut]\r\nURL=lumina://open\r\n');
    assert.doesNotMatch(`${setup}\n${bookmark}`, /127\.0\.0\.1|localhost|:\d{2,5}/u);
    assertNoSourceCheckout(payload);
    assert.deepEqual(result.nativeRequirements, ['ISCC.exe', 'signtool.exe']);
  } finally {
    await fixture.close();
  }
});

test('prepares a macOS clean-install payload that registers lumina://open without a visible canvas app', async () => {
  const fixture = await createFixture('LuminaRuntime');
  try {
    const result = await prepareInstaller({
      platform: 'darwin',
      arch: 'arm64',
      version: '1.2.3',
      runtimeExecutable: fixture.runtimeExecutable,
      webRoot: fixture.webRoot,
      outputDirectory: fixture.outputDirectory,
    });
    const info = await fs.readFile(path.join(result.stageDirectory, 'payload', 'Applications', 'Lumina.app', 'Contents', 'Info.plist'), 'utf8');
    const bookmark = await fs.readFile(path.join(result.stageDirectory, 'payload', 'Applications', 'Lumina.webloc'), 'utf8');
    const postinstall = await fs.readFile(path.join(result.stageDirectory, 'scripts', 'postinstall'), 'utf8');
    const payload = await relativeFiles(path.join(result.stageDirectory, 'payload', 'Applications', 'Lumina.app'));

    assert.equal(await pathExists(path.join(result.stageDirectory, 'payload', 'Applications', 'Lumina.app', 'Contents', 'MacOS', 'LuminaRuntime')), true);
    assert.equal(await pathExists(path.join(result.stageDirectory, 'payload', 'Applications', 'Lumina.app', 'Contents', 'Resources', 'web', 'index.html')), true);
    assert.match(info, /<key>LSUIElement<\/key>\s*<true\/>/u);
    assert.match(info, /<string>lumina<\/string>/u);
    assert.match(bookmark, /<string>lumina:\/\/open<\/string>/u);
    assert.match(postinstall, /lsregister -f/u);
    assert.doesNotMatch(`${info}\n${bookmark}\n${postinstall}`, /127\.0\.0\.1|localhost|:\d{2,5}/u);
    assertNoSourceCheckout(payload);
    assert.deepEqual(result.nativeRequirements, ['codesign', 'pkgbuild', 'productbuild', 'xcrun notarytool']);
  } finally {
    await fixture.close();
  }
});

async function createFixture(runtimeFileName) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-installer-'));
  const webRoot = path.join(root, 'web');
  const outputDirectory = path.join(root, 'output');
  const runtimeExecutable = path.join(root, runtimeFileName);
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Lumina installer fixture</title>', 'utf8');
  await fs.writeFile(runtimeExecutable, 'compiled runtime fixture', 'utf8');
  return {
    outputDirectory,
    runtimeExecutable,
    webRoot,
    close: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function relativeFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (!entry.isDirectory()) return [entry.name];
    return (await relativeFiles(entryPath)).map((filePath) => path.join(entry.name, filePath));
  }));
  return nested.flat().map((filePath) => filePath.replaceAll('\\', '/')).sort();
}

function assertNoSourceCheckout(files) {
  assert.equal(files.some((filePath) => (
    filePath === 'package.json'
    || filePath === 'package-lock.json'
    || filePath.includes('/.git/')
    || filePath.startsWith('.git/')
    || filePath.includes('/node_modules/')
    || filePath.startsWith('node_modules/')
    || filePath.startsWith('src/')
    || filePath.startsWith('runtime/')
  )), false);
}
