import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startLocalLuminaRuntime } from './localRuntime.mjs';
import {
  closeStartedRuntime,
  findAvailableLocalRuntimePort,
  TEST_BRIDGE_PROTOCOL,
} from './localRuntimeTestSupport.mjs';

test('migrates and preserves one installation identity through upgrade, repair, and reinstall', async () => {
  const fixture = await createFixture();
  const port = await findAvailableLocalRuntimePort();
  const legacyMetadata = {
    installationId: 'c5ab10db-991d-48e0-9e2f-d4e75a4bd906',
    origin: `http://127.0.0.1:${port}`,
    port,
    runtimeVersion: '0.1.9',
  };
  await fs.writeFile(
    path.join(fixture.metadataDirectory, 'runtime-metadata.json'),
    JSON.stringify(legacyMetadata),
    'utf8',
  );

  let runtime;
  try {
    runtime = await startFixtureRuntime(fixture, '0.2.0', port);
    assert.equal(runtime.status, 'started');
    assert.deepEqual(runtime.metadata, expectedMetadata(legacyMetadata, '0.2.0'));
    await runtime.runtime.close();
    runtime = undefined;

    runtime = await startFixtureRuntime(fixture, '0.2.0', port);
    assert.equal(runtime.status, 'started');
    assert.equal(runtime.metadata.installationId, legacyMetadata.installationId);
    assert.equal(runtime.metadata.origin, legacyMetadata.origin);
    assert.equal(runtime.metadata.port, legacyMetadata.port);
    assert.equal(runtime.metadata.protocolEntry, 'lumina://open');
    await runtime.runtime.close();
    runtime = undefined;

    runtime = await startFixtureRuntime(fixture, '0.2.1', port);
    assert.equal(runtime.status, 'started');
    assert.deepEqual(runtime.metadata, expectedMetadata(legacyMetadata, '0.2.1'));
    assert.deepEqual(JSON.parse(await fs.readFile(
      path.join(fixture.metadataDirectory, 'runtime-metadata.json'),
      'utf8',
    )), runtime.metadata);
  } finally {
    await closeStartedRuntime(runtime);
    await fixture.close();
  }
});

test('does not reuse an active installation after a runtime compatibility-line or bridge-build change', async () => {
  const fixture = await createFixture();
  const port = await findAvailableLocalRuntimePort();
  const first = await startFixtureRuntime(fixture, '0.2.0', port);
  assert.equal(first.status, 'started');
  try {
    const versionMismatch = await startFixtureRuntime(fixture, '0.3.0', port);
    assert.deepEqual(versionMismatch, {
      status: 'repair-required',
      reason: 'runtime-incompatible',
      metadata: first.metadata,
    });

    const buildMismatch = await startLocalLuminaRuntime({
      metadataDirectory: fixture.metadataDirectory,
      webRoot: fixture.webRoot,
      runtimeVersion: '0.2.1',
      bridgeProtocol: { ...TEST_BRIDGE_PROTOCOL, build: 'lumina-canvas-web-v2' },
      portCandidates: [port],
    });
    assert.deepEqual(buildMismatch, {
      status: 'repair-required',
      reason: 'runtime-incompatible',
      metadata: first.metadata,
    });
  } finally {
    await closeStartedRuntime(first);
    await fixture.close();
  }
});

function startFixtureRuntime(fixture, runtimeVersion, port) {
  return startLocalLuminaRuntime({
    metadataDirectory: fixture.metadataDirectory,
    webRoot: fixture.webRoot,
    runtimeVersion,
    bridgeProtocol: TEST_BRIDGE_PROTOCOL,
    portCandidates: [port],
  });
}

function expectedMetadata(legacyMetadata, runtimeVersion) {
  return {
    installationId: legacyMetadata.installationId,
    origin: legacyMetadata.origin,
    port: legacyMetadata.port,
    runtimeVersion,
    schemaVersion: 2,
    protocolEntry: 'lumina://open',
    bridgeProtocol: TEST_BRIDGE_PROTOCOL,
  };
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-installation-metadata-'));
  const webRoot = path.join(root, 'web');
  const metadataDirectory = path.join(root, 'runtime');
  await fs.mkdir(webRoot);
  await fs.mkdir(metadataDirectory);
  await fs.writeFile(
    path.join(webRoot, 'index.html'),
    '<!doctype html><title>Lumina installation metadata fixture</title>',
    'utf8',
  );
  return {
    metadataDirectory,
    webRoot,
    close: () => fs.rm(root, { recursive: true, force: true }),
  };
}
