import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL, fileURLToPath } from 'node:url';

import {
  launchInstalledCanvasMcp,
  resolveInstalledRuntime,
} from './scripts/launch-installed-runtime.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url));

test('ships a discoverable restricted-write plugin manifest, MCP config, and open skills', () => {
  const manifest = readJson('.codex-plugin/plugin.json');
  const mcp = readJson('.mcp.json');
  assert.equal(manifest.name, 'lumina-canvas');
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.deepEqual(manifest.interface.capabilities, ['Read', 'Write']);
  assert.deepEqual(mcp.mcpServers['lumina-canvas'], {
    command: 'node',
    args: ['./scripts/launch-installed-runtime.mjs'],
    cwd: '.',
    env_vars: ['LOCALAPPDATA', 'HOME', 'USERPROFILE', 'LUMINA_RUNTIME_PATH', 'PATH'],
    startup_timeout_sec: 20,
  });
  const packageMetadata = JSON.parse(fs.readFileSync(path.resolve(PLUGIN_ROOT, '../../canvas-agent/package.json'), 'utf8'));
  assert.equal(packageMetadata.name, '@lumina-web/canvas-agent');
  assert.notEqual(packageMetadata.private, true);
  assert.deepEqual(packageMetadata.publishConfig, { access: 'public' });
  const openSkill = readText('skills/open-lumina-canvas/SKILL.md');
  assert.match(openSkill, /canvas_open/);
  assert.match(openSkill, /explicitly asks to open or use Lumina/i);
  assert.match(openSkill, /open or focus/);
  assert.match(openSkill, /connected Chrome/i);
  assert.match(openSkill, /Connect Chrome.*Stop there/i);
  assert.doesNotMatch(openSkill, /in-app browser/i);
  const canvasSkill = readText('skills/lumina-canvas-readonly/SKILL.md');
  assert.match(canvasSkill, /canvas_get_state/);
  assert.match(canvasSkill, /canvas_propose_changes/);
  assert.match(canvasSkill, /canvas_run_nodes/);
  assert.match(canvasSkill, /the project is read-only until its browser owner enables/i);
  assert.match(canvasSkill, /do not replay a write, import, or run request/i);
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

test('fails closed with repair guidance when the installed runtime version is incompatible', async () => {
  await assert.rejects(
    () => resolveInstalledRuntime({
      compatibilityLine: '0.2',
      platform: 'win32',
      environment: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
      access: async () => {},
      readFile: async () => JSON.stringify({ version: '0.3.0' }),
    }),
    /incompatible.*Repair Lumina/i,
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
