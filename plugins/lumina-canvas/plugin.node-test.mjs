import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL, fileURLToPath } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url));

test('ships a discoverable read-only plugin manifest, MCP config, and open skills', () => {
  const manifest = readJson('.codex-plugin/plugin.json');
  const mcp = readJson('.mcp.json');
  assert.equal(manifest.name, 'lumina-canvas');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.deepEqual(mcp.mcpServers['lumina-canvas'], {
    command: 'npx',
    args: ['-y', '@lumina-web/canvas-agent@latest', 'web-mcp'],
  });
  const packageMetadata = JSON.parse(fs.readFileSync(path.resolve(PLUGIN_ROOT, '../../canvas-agent/package.json'), 'utf8'));
  assert.equal(packageMetadata.name, '@lumina-web/canvas-agent');
  assert.notEqual(packageMetadata.private, true);
  assert.deepEqual(packageMetadata.publishConfig, { access: 'public' });
  assert.match(readText('skills/open-lumina-canvas/SKILL.md'), /canvas_open/);
  assert.match(readText('skills/lumina-canvas-readonly/SKILL.md'), /canvas_get_state/);
});

test('does not package credentials or a write MCP surface', () => {
  const contents = readTree(PLUGIN_ROOT);
  assert.doesNotMatch(contents, /sk-[a-z0-9_-]{20,}/i);
  assert.doesNotMatch(contents, /canvas_(?:propose_changes|import_images|run_nodes)/);
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
