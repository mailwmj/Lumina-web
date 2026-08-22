/* global fetch, URL */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { packagedRuntimeWebRoot, startProductionLuminaRuntime } from './productionRuntime.mjs';
import { closeStartedRuntime, findAvailableLocalRuntimePort } from './localRuntimeTestSupport.mjs';

test('uses each installed application layout for its packaged Web bundle', () => {
  assert.equal(
    packagedRuntimeWebRoot({
      executablePath: path.join('Lumina.app', 'Contents', 'MacOS', 'LuminaRuntime'),
      platform: 'darwin',
    }),
    path.join('Lumina.app', 'Contents', 'Resources', 'web'),
  );
  assert.equal(
    packagedRuntimeWebRoot({
      executablePath: path.join('Lumina', 'LuminaRuntime.exe'),
      platform: 'win32',
    }),
    path.join('Lumina', 'web'),
  );
});

test('serves a production Web bundle with the same-origin Gateway and bridge across a runtime restart', async () => {
  const fixture = await createFixture();
  const port = await findAvailableLocalRuntimePort();
  const startOptions = {
    metadataDirectory: fixture.metadataDirectory,
    portCandidates: [port],
    runtimeVersion: 'test-runtime-1.0.0',
    webRoot: fixture.webRoot,
  };
  let first;
  let restarted;
  try {
    first = await startProductionLuminaRuntime(startOptions);
    assert.equal(first.status, 'started');
    assert.equal(first.metadata.origin, `http://127.0.0.1:${port}`);

    const canvas = await fetch(`${first.metadata.origin}/`);
    assert.equal(canvas.status, 200);
    assert.match(await canvas.text(), /Lumina production bundle fixture/);

    const foreignOrigin = await gatewayRequest(first.metadata.origin, 'http://127.0.0.1:48199');
    assert.equal(foreignOrigin.status, 403);
    assert.equal((await foreignOrigin.json()).error, 'origin_not_allowed');

    const sameOrigin = await gatewayRequest(first.metadata.origin, first.metadata.origin);
    assert.equal(sameOrigin.status, 401);
    assert.equal((await sameOrigin.json()).error, 'api_key_required');

    const opened = first.runtime.bridge.ensureOpen();
    assert.equal(opened.status, 'awaiting_browser');
    assert.equal(opened.bootstrap.canonicalOrigin, first.metadata.origin);
    const connected = await connectBridge(opened.bootstrap);
    assert.equal(connected.status, 200);
    assert.equal(first.runtime.bridge.ensureOpen().status, 'awaiting_project');

    await first.runtime.close();
    first = undefined;

    restarted = await startProductionLuminaRuntime(startOptions);
    assert.equal(restarted.status, 'started');
    assert.equal(restarted.metadata.origin, `http://127.0.0.1:${port}`);
    assert.match(await (await fetch(`${restarted.metadata.origin}/`)).text(), /Lumina production bundle fixture/);
    assert.deepEqual((await fs.readdir(fixture.metadataDirectory)).sort(), ['runtime-metadata.json']);
  } finally {
    await closeStartedRuntime(first);
    await closeStartedRuntime(restarted);
    await fixture.close();
  }
});

async function gatewayRequest(origin, requestOrigin) {
  return fetch(`${origin}/api/generation/jobs`, {
    method: 'POST',
    headers: {
      Origin: requestOrigin,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
}

async function connectBridge(bootstrap) {
  return fetch(`${bootstrap.endpoint}/v1/connect`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bootstrap.token}`,
      'Content-Type': 'application/json',
      Origin: bootstrap.canonicalOrigin,
    },
    body: JSON.stringify({
      sessionId: bootstrap.sessionId,
      protocol: { major: 1, minor: 0, build: 'lumina-canvas-web-v1' },
      capabilities: ['canvas.read.state'],
    }),
  });
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-production-runtime-'));
  const webRoot = path.join(root, 'production-web');
  const metadataDirectory = path.join(root, 'runtime');
  await fs.mkdir(webRoot);
  await fs.mkdir(metadataDirectory);
  await fs.writeFile(
    path.join(webRoot, 'index.html'),
    '<!doctype html><title>Lumina production bundle fixture</title>',
    'utf8',
  );
  return {
    metadataDirectory,
    webRoot,
    close: () => fs.rm(root, { recursive: true, force: true }),
  };
}
