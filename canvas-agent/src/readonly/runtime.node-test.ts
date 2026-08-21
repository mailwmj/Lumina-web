import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { READONLY_CANVAS_CAPABILITIES, READONLY_CANVAS_PROTOCOL } from './protocol.js';
import { startReadonlyCanvasRuntime } from './runtime.js';

test('ending the local canvas runtime invalidates the companion session and local Origin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-readonly-runtime-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Lumina</title>');
  const runtime = await startReadonlyCanvasRuntime(root);
  const bootstrap = runtime.issueBootstrap();
  try {
    runtime.session.connect(bootstrap.token, {
      protocol: READONLY_CANVAS_PROTOCOL,
      capabilities: READONLY_CANVAS_CAPABILITIES,
    });
    runtime.session.publish(bootstrap.token, {
      protocol: READONLY_CANVAS_PROTOCOL,
      capabilities: READONLY_CANVAS_CAPABILITIES,
      state: {
        project: { id: 'project-1', name: 'Current project', revision: 'r1' },
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      selection: { nodeIds: [] },
    });
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.throws(() => runtime.session.readState(), { code: 'NO_ACTIVE_CANVAS' });
  await assert.rejects(fetch(`${runtime.canonicalOrigin}/`));
});
