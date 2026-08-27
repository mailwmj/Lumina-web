import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL, fileURLToPath } from 'node:url';

import {
  assertSupportedNodeVersion,
  launchInstalledCanvasMcp,
  resolveInstalledRuntime,
} from './scripts/launch-installed-runtime.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPOSITORY_ROOT = path.resolve(PLUGIN_ROOT, '../..');

test('marketplace resolves the Codex in-app-browser Lumina manifest', () => {
  const marketplacePath = path.join(REPOSITORY_ROOT, '.agents', 'plugins', 'marketplace.json');
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  const registration = marketplace.plugins.find((plugin) => plugin.name === 'lumina-canvas');
  assert.ok(registration, 'marketplace must register lumina-canvas');
  assert.deepEqual(registration.source, {
    source: 'local',
    path: './plugins/lumina-canvas',
  });

  const marketplacePluginRoot = path.resolve(REPOSITORY_ROOT, registration.source.path);
  assert.equal(marketplacePluginRoot, path.resolve(PLUGIN_ROOT));
  const manifest = JSON.parse(fs.readFileSync(path.join(marketplacePluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.match(manifest.interface.shortDescription, /Codex's in-app browser/i);
  assert.match(manifest.interface.longDescription, /Codex's in-app browser/i);
  assert.doesNotMatch(manifest.interface.shortDescription, /connected Chrome/i);
  assert.doesNotMatch(manifest.interface.longDescription, /connected Chrome/i);
});

test('ships a discoverable restricted-write plugin manifest, MCP config, and open skills', () => {
  const manifest = readJson('.codex-plugin/plugin.json');
  const mcp = readJson('.mcp.json');
  assert.equal(manifest.name, 'lumina-canvas');
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.deepEqual(manifest.interface.capabilities, ['Read', 'Write']);
  assert.match(manifest.interface.shortDescription, /Codex's in-app browser/i);
  assert.match(manifest.interface.longDescription, /Codex's in-app browser/i);
  assert.doesNotMatch(manifest.interface.shortDescription, /connected Chrome/i);
  assert.doesNotMatch(manifest.interface.longDescription, /connected Chrome/i);
  assert.deepEqual(mcp.mcpServers['lumina-canvas'], {
    command: 'node',
    args: ['./scripts/launch-installed-runtime.mjs'],
    cwd: '.',
    env_vars: ['APPDATA', 'LOCALAPPDATA', 'HOME', 'USERPROFILE', 'LUMINA_RUNTIME_PATH', 'PATH'],
    startup_timeout_sec: 20,
  });
  const packageMetadata = JSON.parse(fs.readFileSync(path.resolve(PLUGIN_ROOT, '../../canvas-agent/package.json'), 'utf8'));
  assert.equal(packageMetadata.name, '@lumina-web/canvas-agent');
  assert.notEqual(packageMetadata.private, true);
  assert.deepEqual(packageMetadata.publishConfig, { access: 'public' });
  const openSkill = readText('skills/open-lumina-canvas/SKILL.md');
  assert.match(openSkill, /canvas_open/);
  assert.match(openSkill, /explicitly asks to open or use Lumina/i);
  assert.match(openSkill, /open the returned `url` in Codex's in-app browser/i);
  assert.match(openSkill, /Do not open or fall back to connected Chrome/i);
  assert.match(openSkill, /in-app browser is required/i);
  assert.match(openSkill, /do not create a session-local.*isolated browser project/i);
  assert.match(openSkill, /reload it once.*consumes the new fragment/i);
  const canvasSkill = readText('skills/lumina-canvas/SKILL.md');
  assert.match(canvasSkill, /canvas_get_state/);
  assert.match(canvasSkill, /canvas_propose_changes/);
  assert.match(canvasSkill, /canvas_run_nodes/);
  assert.match(canvasSkill, /Codex's in-app browser/i);
  assert.match(canvasSkill, /do not open or fall back to connected Chrome/i);
  assert.match(canvasSkill, /the project is read-only until its browser owner enables/i);
  assert.match(canvasSkill, /do not replay a write, import, or run request/i);
  const readme = readText('README.md');
  assert.match(readme, /Node\.js 18 或更高版本/u);
  assert.match(readme, /支持本地插件或 Marketplace 导入界面/u);
  assert.match(readme, /Codex 内置浏览器/u);
  assert.match(readme, /回退到已连接的 Chrome/u);
  assert.match(readme, /不会检查或修改 Codex 配置/u);
  assert.doesNotMatch(readme, /独立 Codex 浏览器.*项目库/u);
});

test('checks Node.js compatibility before looking for the installed Runtime', async () => {
  let accessed = false;
  assert.throws(
    () => assertSupportedNodeVersion('17.9.1'),
    /requires Node\.js >=18.*restart Codex/i,
  );
  await assert.rejects(
    launchInstalledCanvasMcp({
      nodeVersion: '16.20.2',
      access: async () => { accessed = true; },
    }),
    /requires Node\.js >=18.*restart Codex/i,
  );
  assert.equal(accessed, false);
});

test('launches only a compatible installed runtime for the Codex MCP session', async () => {
  const runtimePath = 'C:\\Users\\Test\\AppData\\Local\\Lumina\\LuminaRuntime.exe';
  const accessed = [];
  const launched = [];
  const child = new EventEmitter();
  child.unref = () => {};

  const result = await launchInstalledCanvasMcp({
    compatibilityLine: '0.2',
    platform: 'win32',
    runtimePath,
    access: async (filePath) => {
      accessed.push(filePath);
    },
    readFile: async () => JSON.stringify({ version: '0.2.99' }),
    spawn: (command, arguments_, options) => {
      launched.push([command, arguments_, options]);
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
  });

  assert.deepEqual(result, { status: 'closed', exitCode: 0 });
  assert.deepEqual(accessed, [runtimePath]);
  assert.deepEqual(launched, [[runtimePath, ['--canvas-mcp'], {
    stdio: 'inherit',
    windowsHide: true,
  }]]);
});

test('uses the legacy Lumina-web directory when the canonical install is absent', async () => {
  const localAppData = 'C:\\Users\\Test\\AppData\\Local';
  const canonicalPath = path.win32.join(localAppData, 'Lumina', 'LuminaRuntime.exe');
  const legacyPath = path.win32.join(localAppData, 'Lumina-web', 'LuminaRuntime.exe');
  const accessed = [];

  const resolved = await resolveInstalledRuntime({
    compatibilityLine: '0.2',
    platform: 'win32',
    environment: { LOCALAPPDATA: localAppData },
    access: async (filePath) => {
      accessed.push(filePath);
      if (filePath === canonicalPath) {
        const error = new Error('missing canonical runtime');
        error.code = 'ENOENT';
        throw error;
      }
    },
    readFile: async (filePath) => {
      assert.equal(filePath, path.win32.join(localAppData, 'Lumina-web', 'runtime-version.json'));
      return JSON.stringify({ version: '0.2.38' });
    },
    readLocatorFile: missingLocator,
  });

  assert.equal(resolved, legacyPath);
  assert.deepEqual(accessed, [canonicalPath, legacyPath, legacyPath]);
});

test('uses the Windows installer locator for an arbitrary install directory', async () => {
  const appData = 'C:\\Users\\Test\\AppData\\Roaming';
  const runtimePath = 'D:\\Creative Tools\\Lumina\\LuminaRuntime.exe';
  const locatorPath = path.win32.join(appData, 'Lumina', 'runtime', 'runtime-location.txt');

  const resolved = await resolveInstalledRuntime({
    compatibilityLine: '0.2',
    platform: 'win32',
    environment: { APPDATA: appData },
    access: async (filePath) => assert.equal(filePath, runtimePath),
    readFile: async (filePath) => {
      assert.equal(filePath, path.win32.join(path.win32.dirname(runtimePath), 'runtime-version.json'));
      return JSON.stringify({ version: '0.2.38' });
    },
    readLocatorFile: async (filePath) => {
      assert.equal(filePath, locatorPath);
      return `${runtimePath}\r\n`;
    },
  });

  assert.equal(resolved, runtimePath);
});

test('uses the macOS installer locator for an app installed on another volume', async () => {
  const runtimePath = '/Volumes/Creative/Applications/Lumina.app/Contents/MacOS/LuminaRuntime';
  const locatorPath = '/Library/Application Support/Lumina/runtime/runtime-location.txt';

  const resolved = await resolveInstalledRuntime({
    compatibilityLine: '0.2',
    platform: 'darwin',
    environment: {},
    homeDirectory: '/Users/test',
    access: async (filePath) => assert.equal(filePath, runtimePath),
    readFile: async (filePath) => {
      assert.equal(filePath, '/Volumes/Creative/Applications/Lumina.app/Contents/MacOS/runtime-version.json');
      return JSON.stringify({ version: '0.2.38' });
    },
    readLocatorFile: async (filePath) => {
      assert.equal(filePath, locatorPath);
      return `${runtimePath}\n`;
    },
  });

  assert.equal(resolved, runtimePath);
});

test('fails closed with repair guidance when the installed runtime version is incompatible', async () => {
  await assert.rejects(
    () => resolveInstalledRuntime({
      compatibilityLine: '0.2',
      platform: 'win32',
      environment: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
      access: async () => {},
      readFile: async () => JSON.stringify({ version: '0.3.0' }),
      readLocatorFile: missingLocator,
    }),
    /incompatible.*Repair Lumina/i,
  );
});

test('distinguishes a missing Runtime executable from missing version metadata', async () => {
  await assert.rejects(
    () => resolveInstalledRuntime({
      compatibilityLine: '0.2',
      platform: 'darwin',
      access: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
      readLocatorFile: missingLocator,
    }),
    /Runtime executable is missing or cannot be accessed.*Install or Repair Lumina/i,
  );
  await assert.rejects(
    () => resolveInstalledRuntime({
      compatibilityLine: '0.2',
      platform: 'darwin',
      access: async () => {},
      readFile: async () => '{broken',
      readLocatorFile: missingLocator,
    }),
    /version metadata is missing or invalid.*Repair Lumina/i,
  );
});

test('fails closed with repair guidance when the plugin manifest is incomplete', async () => {
  await assert.rejects(
    () => resolveInstalledRuntime({
      compatibilityLine: undefined,
      platform: 'win32',
      environment: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
      access: async () => {},
      readFile: async () => '{not-json',
      readLocatorFile: missingLocator,
    }),
    /plugin is incomplete.*Repair Lumina/i,
  );
});

test('does not package credentials or unrestricted canvas operations', () => {
  const contents = readTree(PLUGIN_ROOT);
  assert.doesNotMatch(contents, /sk-[a-z0-9_-]{20,}/i);
  assert.doesNotMatch(contents, new RegExp(`canvas_(?:${['delete_project', 'read_credentials', 'create_result'].join('|')})`));
  assert.doesNotMatch(contents, /api[_-]?key\s*[:=]\s*["'][^"']+/i);
});

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

async function missingLocator() {
  const error = new Error('runtime locator is absent');
  error.code = 'ENOENT';
  throw error;
}

function readText(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), 'utf8');
}

function readTree(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? [readTree(path.join(directory, entry.name))]
      : [fs.readFileSync(path.join(directory, entry.name), 'utf8')])
    .join('\n');
}
