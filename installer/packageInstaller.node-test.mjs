import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareInstaller } from './packageInstaller.mjs';

const defaultBridgeProtocol = { major: 1, minor: 0, build: 'lumina-canvas-web-v1' };

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
      bridgeProtocol: defaultBridgeProtocol,
      pluginRoot: fixture.pluginRoot,
    });
    const setup = await fs.readFile(path.join(result.stageDirectory, 'Lumina.iss'), 'utf8');
    const bookmark = await fs.readFile(path.join(result.stageDirectory, 'Lumina.url'), 'utf8');
    const runtimeVersion = JSON.parse(await fs.readFile(
      path.join(result.stageDirectory, 'app', 'runtime-version.json'),
      'utf8',
    ));
    const payload = await relativeFiles(path.join(result.stageDirectory, 'app'));
    const windowsIcon = await fs.readFile(path.join(result.stageDirectory, 'Lumina.ico'));

    assert.equal(await pathExists(path.join(result.stageDirectory, 'app', 'LuminaRuntime.exe')), true);
    assert.equal(windowsIcon.readUInt16LE(0), 0);
    assert.equal(windowsIcon.readUInt16LE(2), 1);
    assert.equal(await pathExists(path.join(result.stageDirectory, 'app', 'LuminaProtocol.vbs')), true);
    assert.equal(await pathExists(path.join(result.stageDirectory, 'app', 'web', 'index.html')), true);
    assertCodexPluginPayload(payload);
    assert.match(setup, /Software\\Classes\\lumina/u);
    assert.match(setup, /LuminaProtocol\.vbs/u);
    assert.match(setup, /Source: "\{#StagingRoot\}\\app\\\*"; DestDir: "\{app\}"/u);
    assert.match(setup, /ValueData: "wscript\.exe ""\{app\}\\LuminaProtocol\.vbs/u);
    assert.match(setup, /runtime-location\.txt/u);
    assert.match(setup, /ExpandConstant\('\{app\}\\LuminaRuntime\.exe'\)/u);
    assert.match(setup, /SaveStringToFile/u);
    assert.doesNotMatch(setup, /#define StagingRoot "\{#StagingRoot\}"/u);
    assert.doesNotMatch(setup, /\[Run\]/u);
    assert.match(setup, /OutputDir=\{#StagingRoot\}\\release/u);
    assert.match(setup, /SetupIconFile=\{#StagingRoot\}\\Lumina\.ico/u);
    assert.match(setup, /IconFilename: "\{app\}\\LuminaRuntime\.exe"/u);
    assert.match(setup, /Lumina could not register lumina:\/\/ links/u);
    assert.equal(bookmark, '[InternetShortcut]\r\nURL=lumina://open\r\n');
    assert.deepEqual(runtimeVersion, {
      version: '1.2.3',
      bridgeProtocol: defaultBridgeProtocol,
    });
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
      bridgeProtocol: defaultBridgeProtocol,
      pluginRoot: fixture.pluginRoot,
    });
    const info = await fs.readFile(path.join(result.stageDirectory, 'payload', 'Applications', 'Lumina.app', 'Contents', 'Info.plist'), 'utf8');
    const bookmark = await fs.readFile(path.join(result.stageDirectory, 'payload', 'Applications', 'Lumina.webloc'), 'utf8');
    const postinstall = await fs.readFile(path.join(result.stageDirectory, 'scripts', 'postinstall'), 'utf8');
    const preinstall = await fs.readFile(path.join(result.stageDirectory, 'scripts', 'preinstall'), 'utf8');
    const payload = await relativeFiles(path.join(result.stageDirectory, 'payload', 'Applications', 'Lumina.app'));
    const macIcon = await fs.readFile(path.join(
      result.stageDirectory,
      'payload',
      'Applications',
      'Lumina.app',
      'Contents',
      'Resources',
      'Lumina.icns',
    ));

    assert.equal(await pathExists(path.join(result.stageDirectory, 'payload', 'Applications', 'Lumina.app', 'Contents', 'MacOS', 'LuminaRuntime')), true);
    assert.equal(macIcon.toString('ascii', 0, 4), 'icns');
    assert.equal(macIcon.readUInt32BE(4), macIcon.length);
    assert.equal(await pathExists(path.join(result.stageDirectory, 'payload', 'Applications', 'Lumina.app', 'Contents', 'Resources', 'web', 'index.html')), true);
    assert.equal(await pathExists(path.join(result.stageDirectory, 'payload', 'Applications', 'Lumina.app', 'Contents', 'Resources', 'Lumina-Codex-Plugin', '.codex-plugin', 'plugin.json')), true);
    assertCodexPluginPayload(payload, 'Contents/Resources/Lumina-Codex-Plugin');
    assert.match(info, /<key>LSUIElement<\/key>\s*<true\/>/u);
    assert.match(info, /<key>CFBundleIconFile<\/key>\s*<string>Lumina\.icns<\/string>/u);
    assert.match(info, /<string>lumina<\/string>/u);
    assert.match(bookmark, /<string>lumina:\/\/open<\/string>/u);
    assert.match(postinstall, /lsregister -f/u);
    assert.match(postinstall, /runtime-location\.txt/u);
    assert.match(postinstall, /\$\{target_volume%\/\}\/Applications\/Lumina\.app/u);
    assert.match(preinstall, /runtime-location\.txt/u);
    assert.doesNotMatch(`${info}\n${bookmark}\n${postinstall}`, /127\.0\.0\.1|localhost|:\d{2,5}/u);
    assertNoSourceCheckout(payload);
    assert.deepEqual(result.nativeRequirements, ['codesign', 'pkgbuild', 'productbuild', 'xcrun notarytool']);
  } finally {
    await fixture.close();
  }
});

test('records the built bridge protocol in the installer runtime manifest', async () => {
  const fixture = await createFixture('LuminaRuntime.exe', '2.4.0');
  const bridgeProtocol = { major: 2, minor: 4, build: 'lumina-canvas-web-v2' };
  try {
    const result = await prepareInstaller({
      platform: 'win32',
      arch: 'x64',
      version: '2.4.0',
      runtimeExecutable: fixture.runtimeExecutable,
      webRoot: fixture.webRoot,
      outputDirectory: fixture.outputDirectory,
      bridgeProtocol,
      pluginRoot: fixture.pluginRoot,
    });

    assert.deepEqual(JSON.parse(await fs.readFile(
      path.join(result.stageDirectory, 'app', 'runtime-version.json'),
      'utf8',
    )), {
      version: '2.4.0',
      bridgeProtocol,
    });
  } finally {
    await fixture.close();
  }
});

test('rejects a plugin outside the Runtime compatibility line', async () => {
  const fixture = await createFixture('LuminaRuntime.exe', '9.0.0');
  try {
    await assert.rejects(
      prepareInstaller({
        platform: 'win32',
        arch: 'x64',
        version: '1.2.3',
        runtimeExecutable: fixture.runtimeExecutable,
        webRoot: fixture.webRoot,
        outputDirectory: fixture.outputDirectory,
        bridgeProtocol: defaultBridgeProtocol,
        pluginRoot: fixture.pluginRoot,
      }),
      /major\/minor compatibility line/u,
    );
  } finally {
    await fixture.close();
  }
});

test('keeps browser data cleanup outside normal Windows and macOS installer lifecycle scripts', async () => {
  const windowsFixture = await createFixture('LuminaRuntime.exe');
  const macFixture = await createFixture('LuminaRuntime');
  try {
    const windows = await prepareInstaller({
      platform: 'win32',
      arch: 'x64',
      version: '1.2.3',
      runtimeExecutable: windowsFixture.runtimeExecutable,
      webRoot: windowsFixture.webRoot,
      outputDirectory: windowsFixture.outputDirectory,
      bridgeProtocol: defaultBridgeProtocol,
      pluginRoot: windowsFixture.pluginRoot,
    });
    const mac = await prepareInstaller({
      platform: 'darwin',
      arch: 'arm64',
      version: '1.2.3',
      runtimeExecutable: macFixture.runtimeExecutable,
      webRoot: macFixture.webRoot,
      outputDirectory: macFixture.outputDirectory,
      bridgeProtocol: defaultBridgeProtocol,
      pluginRoot: macFixture.pluginRoot,
    });
    const windowsScript = await fs.readFile(path.join(windows.stageDirectory, 'Lumina.iss'), 'utf8');
    const macPostinstall = await fs.readFile(path.join(mac.stageDirectory, 'scripts', 'postinstall'), 'utf8');
    const macPreinstall = await fs.readFile(path.join(mac.stageDirectory, 'scripts', 'preinstall'), 'utf8');

    assert.equal(await pathExists(path.join(windows.stageDirectory, 'app', 'runtime-metadata.json')), false);
    assert.equal(await pathExists(path.join(mac.stageDirectory, 'payload', 'Applications', 'Lumina.app', 'Contents', 'MacOS', 'runtime-metadata.json')), false);
    assert.doesNotMatch(windowsScript, /\[UninstallDelete\]|AppData\\Roaming|Chrome|IndexedDB/u);
    assert.doesNotMatch(`${macPreinstall}\n${macPostinstall}`, /\brm\b|Chrome|IndexedDB/u);
  } finally {
    await windowsFixture.close();
    await macFixture.close();
  }
});

test('renders update, repair, and reinstall lifecycle guards without replacing the registered Origin', async () => {
  const windowsFixture = await createFixture('LuminaRuntime.exe');
  const macFixture = await createFixture('LuminaRuntime');
  try {
    const windows = await prepareInstaller({
      platform: 'win32',
      arch: 'x64',
      version: '1.2.4',
      runtimeExecutable: windowsFixture.runtimeExecutable,
      webRoot: windowsFixture.webRoot,
      outputDirectory: windowsFixture.outputDirectory,
      bridgeProtocol: defaultBridgeProtocol,
      pluginRoot: windowsFixture.pluginRoot,
    });
    const mac = await prepareInstaller({
      platform: 'darwin',
      arch: 'arm64',
      version: '1.2.4',
      runtimeExecutable: macFixture.runtimeExecutable,
      webRoot: macFixture.webRoot,
      outputDirectory: macFixture.outputDirectory,
      bridgeProtocol: defaultBridgeProtocol,
      pluginRoot: macFixture.pluginRoot,
    });
    const windowsScript = await fs.readFile(path.join(windows.stageDirectory, 'Lumina.iss'), 'utf8');
    const macPreinstall = await fs.readFile(path.join(mac.stageDirectory, 'scripts', 'preinstall'), 'utf8');

    assert.match(windowsScript, /CloseApplications=yes/u);
    assert.match(windowsScript, /CloseApplicationsFilter=LuminaRuntime\.exe/u);
    assert.match(windowsScript, /RestartApplications=no/u);
    assert.match(macPreinstall, /pkill -TERM -f/u);
    assert.match(macPreinstall, /LuminaRuntime/u);
    assert.doesNotMatch(`${windowsScript}\n${macPreinstall}`, /runtime-metadata\.json|127\.0\.0\.1|localhost/u);
  } finally {
    await windowsFixture.close();
    await macFixture.close();
  }
});

async function createFixture(runtimeFileName, pluginVersion = '1.2.0') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-installer-'));
  const webRoot = path.join(root, 'web');
  const outputDirectory = path.join(root, 'output');
  const pluginRoot = path.join(root, 'plugin');
  const runtimeExecutable = path.join(root, runtimeFileName);
  await fs.mkdir(webRoot);
  await fs.mkdir(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  await fs.mkdir(path.join(pluginRoot, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(pluginRoot, 'skills', 'lumina-canvas'), { recursive: true });
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Lumina installer fixture</title>', 'utf8');
  await fs.writeFile(runtimeExecutable, 'compiled runtime fixture', 'utf8');
  await fs.writeFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'lumina-canvas',
    version: pluginVersion,
  }), 'utf8');
  await fs.writeFile(path.join(pluginRoot, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'lumina-canvas': {
        command: 'node',
        args: ['./scripts/launch-installed-runtime.mjs'],
      },
    },
  }), 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Lumina Canvas plugin fixture\n', 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'launch-installed-runtime.mjs'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'skills', 'lumina-canvas', 'SKILL.md'), '# Lumina fixture skill\n', 'utf8');
  return {
    outputDirectory,
    pluginRoot,
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

function assertCodexPluginPayload(files, pluginPrefix = 'Lumina-Codex-Plugin') {
  const prefix = `${pluginPrefix}/`;
  assert.deepEqual(files.filter((filePath) => filePath.startsWith(prefix)), [
    `${pluginPrefix}/.codex-plugin/plugin.json`,
    `${pluginPrefix}/.mcp.json`,
    `${pluginPrefix}/README.md`,
    `${pluginPrefix}/scripts/launch-installed-runtime.mjs`,
    `${pluginPrefix}/skills/lumina-canvas/SKILL.md`,
  ]);
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
