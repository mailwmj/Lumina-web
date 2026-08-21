import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

test('rejects the retired native companion commands', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-agent-command-test-'));
  const configFile = path.join(tempDir, 'canvas-agent.json');
  const child = spawn(process.execPath, [
    path.join(PACKAGE_ROOT, 'dist', 'index.js'),
    'config',
    '--config',
    configFile,
  ], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  try {
    const [exitCode] = await once(child, 'exit');
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /web-mcp/);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
