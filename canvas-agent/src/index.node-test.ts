import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

test('serve mode exits after its Lumina parent process is gone', { timeout: 7_000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-parent-test-'));
  const configFile = path.join(tempDir, 'canvas-agent.json');
  fs.writeFileSync(configFile, JSON.stringify({
    url: 'http://127.0.0.1:0',
    token: 'test-token-that-is-long-enough-for-the-local-bridge',
    origins: [],
  }));

  const departedParent = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(departedParent.pid);
  await once(departedParent, 'exit');

  const child = spawn(process.execPath, [
    path.join(PACKAGE_ROOT, 'dist', 'index.js'),
    'serve',
    '--config',
    configFile,
    '--parent-pid',
    String(departedParent.pid),
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
    assert.equal(exitCode, 0, stderr);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
