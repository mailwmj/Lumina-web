import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startLocalCanvasHost } from './localCanvasHost.js';

test('starts the local canvas host on an OS-assigned numeric loopback port and closes it with the session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-readonly-canvas-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Lumina local canvas</title>');
  const host = await startLocalCanvasHost(root);
  try {
    const origin = new URL(host.origin);
    assert.equal(origin.protocol, 'http:');
    assert.equal(origin.hostname, '127.0.0.1');
    assert.notEqual(origin.port, '');
    assert.notEqual(origin.port, '0');

    const response = await fetch(`${host.origin}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Lumina local canvas/);

    assert.equal((await fetch(`${host.origin}/../package.json`)).status, 404);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  await assert.rejects(fetch(`${host.origin}/`));
});
