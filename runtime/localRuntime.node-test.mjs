/* global fetch, URL */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LOCAL_RUNTIME_PORTS, startLocalLuminaRuntime } from './localRuntime.mjs';

test('starts on a product-controlled loopback port and persists its stable installation origin', async () => {
  const fixture = await createFixture();
  const port = await findAvailablePort();
  const result = await startLocalLuminaRuntime({
    metadataDirectory: fixture.metadataDirectory,
    webRoot: fixture.webRoot,
    runtimeVersion: 'test-runtime-1.0.0',
    portCandidates: [port],
  });
  assert.equal(result.status, 'started');
  let closed = false;
  try {
    assert.ok(LOCAL_RUNTIME_PORTS.includes(port));
    assert.equal(result.metadata.port, port);
    assert.equal(result.metadata.origin, `http://127.0.0.1:${port}`);
    assert.equal(result.metadata.runtimeVersion, 'test-runtime-1.0.0');
    assert.match(result.metadata.installationId, /^[0-9a-f-]{36}$/i);

    const persisted = JSON.parse(await fs.readFile(
      path.join(fixture.metadataDirectory, 'runtime-metadata.json'),
      'utf8',
    ));
    assert.deepEqual(persisted, result.metadata);

    const health = await fetch(`${result.metadata.origin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: 'healthy',
      ...result.metadata,
    });

    const canvas = await fetch(`${result.metadata.origin}/`);
    assert.equal(canvas.status, 200);
    assert.match(await canvas.text(), /Lumina local runtime fixture/);

    await result.runtime.close();
    closed = true;
    await assert.rejects(fetch(`${result.metadata.origin}/health`));
  } finally {
    if (!closed) {
      await closeStartedRuntime(result);
    }
    await fixture.close();
  }
});

test('reuses the active runtime for the same installation instead of creating another origin', async () => {
  const fixture = await createFixture();
  const port = await findAvailablePort();
  const first = await startLocalLuminaRuntime({
    metadataDirectory: fixture.metadataDirectory,
    webRoot: fixture.webRoot,
    runtimeVersion: 'test-runtime-1.0.0',
    portCandidates: [port],
  });
  assert.equal(first.status, 'started');
  try {
    const second = await startLocalLuminaRuntime({
      metadataDirectory: fixture.metadataDirectory,
      webRoot: fixture.webRoot,
      runtimeVersion: 'test-runtime-1.0.0',
      portCandidates: [port],
    });
    assert.equal(second.status, 'reused');
    assert.equal(second.metadata.origin, first.metadata.origin);
    assert.equal(second.runtime, first.runtime);
  } finally {
    await closeStartedRuntime(first);
    await fixture.close();
  }
});

test('serializes concurrent first starts from separate launchers to one installation origin', async () => {
  const fixture = await createFixture();
  const ports = await findAvailablePorts(2);
  const separateLauncher = await import(`${new URL('./localRuntime.mjs', import.meta.url)}?launcher=${Date.now()}`);
  const results = await Promise.all([
    startLocalLuminaRuntime({
      metadataDirectory: fixture.metadataDirectory,
      webRoot: fixture.webRoot,
      runtimeVersion: 'test-runtime-1.0.0',
      portCandidates: ports,
    }),
    separateLauncher.startLocalLuminaRuntime({
      metadataDirectory: fixture.metadataDirectory,
      webRoot: fixture.webRoot,
      runtimeVersion: 'test-runtime-1.0.0',
      portCandidates: ports,
    }),
  ]);
  const started = results.find((result) => result.status === 'started');
  try {
    assert.equal(results.filter((result) => result.status === 'started').length, 1);
    assert.equal(results.filter((result) => result.status === 'reused').length, 1);
    assert.ok(started);
    assert.equal(results[0].metadata.origin, results[1].metadata.origin);
  } finally {
    await Promise.all(results.map((result) => closeStartedRuntime(result)));
    await fixture.close();
  }
});

test('reports the product version when a launcher does not inject one', async () => {
  const fixture = await createFixture();
  const port = await findAvailablePort();
  const packageMetadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const result = await startLocalLuminaRuntime({
    metadataDirectory: fixture.metadataDirectory,
    webRoot: fixture.webRoot,
    portCandidates: [port],
  });
  assert.equal(result.status, 'started');
  try {
    assert.equal(result.metadata.runtimeVersion, packageMetadata.version);
    assert.equal((await (await fetch(`${result.metadata.origin}/health`)).json()).runtimeVersion, packageMetadata.version);
  } finally {
    await closeStartedRuntime(result);
    await fixture.close();
  }
});

test('tries the next candidate when the first installation port is occupied', async () => {
  const fixture = await createFixture();
  const [blockedPort, selectedPort] = await findAvailablePorts(2);
  const blocker = await listen(blockedPort);
  try {
    const result = await startLocalLuminaRuntime({
      metadataDirectory: fixture.metadataDirectory,
      webRoot: fixture.webRoot,
      runtimeVersion: 'test-runtime-1.0.0',
      portCandidates: [blockedPort, selectedPort],
    });
    assert.equal(result.status, 'started');
    try {
      assert.equal(result.metadata.port, selectedPort);
      assert.equal(result.metadata.origin, `http://127.0.0.1:${selectedPort}`);
    } finally {
      await closeStartedRuntime(result);
    }
  } finally {
    await closeServer(blocker);
    await fixture.close();
  }
});

test('requires repair when an unrelated process occupies the registered port', async () => {
  const fixture = await createFixture();
  const [registeredPort, alternatePort] = await findAvailablePorts(2);
  const metadata = {
    installationId: 'c5ab10db-991d-48e0-9e2f-d4e75a4bd906',
    origin: `http://127.0.0.1:${registeredPort}`,
    port: registeredPort,
    runtimeVersion: 'test-runtime-0.9.0',
  };
  await fs.writeFile(
    path.join(fixture.metadataDirectory, 'runtime-metadata.json'),
    JSON.stringify(metadata),
    'utf8',
  );
  const blocker = await listen(registeredPort);
  try {
    const result = await startLocalLuminaRuntime({
      metadataDirectory: fixture.metadataDirectory,
      webRoot: fixture.webRoot,
      runtimeVersion: 'test-runtime-1.0.0',
      portCandidates: [registeredPort, alternatePort],
    });
    assert.deepEqual(result, {
      status: 'repair-required',
      reason: 'registered-port-occupied',
      metadata,
    });
    assert.deepEqual(JSON.parse(await fs.readFile(
      path.join(fixture.metadataDirectory, 'runtime-metadata.json'),
      'utf8',
    )), metadata);
  } finally {
    await closeServer(blocker);
  }

  const repaired = await startLocalLuminaRuntime({
    metadataDirectory: fixture.metadataDirectory,
    webRoot: fixture.webRoot,
    runtimeVersion: 'test-runtime-1.0.0',
    portCandidates: [registeredPort, alternatePort],
  });
  assert.equal(repaired.status, 'started');
  try {
    assert.equal(repaired.metadata.origin, metadata.origin);
    assert.equal(repaired.metadata.port, registeredPort);
  } finally {
    await closeStartedRuntime(repaired);
    await fixture.close();
  }
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-local-runtime-'));
  const webRoot = path.join(root, 'web');
  const metadataDirectory = path.join(root, 'runtime');
  await fs.mkdir(webRoot);
  await fs.mkdir(metadataDirectory);
  await fs.writeFile(
    path.join(webRoot, 'index.html'),
    '<!doctype html><title>Lumina local runtime fixture</title>',
    'utf8',
  );
  return {
    metadataDirectory,
    webRoot,
    close: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function findAvailablePort() {
  return (await findAvailablePorts(1))[0];
}

async function findAvailablePorts(count) {
  const available = [];
  for (const port of LOCAL_RUNTIME_PORTS) {
    if (await canListen(port)) {
      available.push(port);
      if (available.length === count) {
        return available;
      }
    }
  }
  throw new Error(`Expected ${count} available Lumina runtime ports.`);
}

async function canListen(port) {
  try {
    const server = await listen(port);
    await closeServer(server);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
      return false;
    }
    throw error;
  }
}

function listen(port) {
  const server = createServer((_request, response) => response.writeHead(204).end());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function closeStartedRuntime(result) {
  if (result?.status === 'started') {
    await result.runtime.close();
  }
}
