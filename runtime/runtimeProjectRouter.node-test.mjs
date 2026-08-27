/* global fetch */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startLocalLuminaRuntime } from './localRuntime.mjs';
import {
  closeStartedRuntime,
  findAvailableLocalRuntimePort,
  TEST_BRIDGE_PROTOCOL,
} from './localRuntimeTestSupport.mjs';
import { startRuntimeProjectService } from './runtimeProjectService.mjs';

function createMemoryLibrary() {
  const projects = new Map();
  const assets = new Map();
  return {
    async open() {},
    async close() {},
    async listProjects() {
      return [...projects.values()].map(({ id, name, createdAt, updatedAt, nodeCount }) => ({
        id, name, createdAt, updatedAt, nodeCount,
      }));
    },
    async openProject(projectId) {
      if (projectId === 'force-private-error') {
        throw new Error('C:\\Users\\private\\Lumina\\library\\head.json');
      }
      return projects.get(projectId) ?? null;
    },
    async saveSnapshot(record) { projects.set(record.id, structuredClone(record)); return record; },
    async updateViewport(projectId, viewportJson) {
      const record = projects.get(projectId);
      if (!record) return null;
      const next = { ...record, viewportJson };
      projects.set(projectId, next);
      return next;
    },
    async renameProject(projectId, name, updatedAt) {
      const record = projects.get(projectId);
      if (!record) return null;
      const next = { ...record, name, updatedAt };
      projects.set(projectId, next);
      return next;
    },
    async deleteProject(projectId) { return projects.delete(projectId); },
    async writeAsset(input) {
      const chunks = [];
      const reader = input.blob.stream().getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(Buffer.from(next.value));
      }
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.byteLength, input.blob.size);
      const metadata = {
        assetId: input.assetId,
        projectId: input.projectId,
        kind: input.kind,
        mimeType: input.blob.type,
        byteCount: bytes.byteLength,
        createdAt: input.createdAt,
        sourceKind: input.sourceKind,
        width: input.width,
        height: input.height,
        durationMs: input.durationMs,
        sourceMetadata: input.sourceMetadata,
      };
      assets.set(input.assetId, { bytes, metadata });
      return metadata;
    },
    async readAsset(assetId) {
      const asset = assets.get(assetId);
      return asset ? new Blob([asset.bytes], { type: asset.metadata.mimeType }) : null;
    },
    async getAssetMetadata(assetId) { return assets.get(assetId)?.metadata ?? null; },
    async deleteAsset(assetId) { return assets.delete(assetId); },
  };
}

function projectRecord(id) {
  return {
    id,
    name: 'Runtime HTTP fixture',
    createdAt: 1,
    updatedAt: 2,
    nodeCount: 0,
    schemaVersion: 1,
    nodesJson: '{"nodes":[],"imagePool":[]}',
    edgesJson: '[]',
    viewportJson: '{"x":0,"y":0,"zoom":1}',
    historyJson: '{"past":[],"future":[]}',
  };
}

async function createRuntime() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-runtime-project-router-'));
  const webRoot = path.join(root, 'web');
  const metadataDirectory = path.join(root, 'metadata');
  await fs.mkdir(webRoot);
  await fs.mkdir(metadataDirectory);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Runtime router</title>');
  const port = await findAvailableLocalRuntimePort();
  const result = await startLocalLuminaRuntime({
    bridgeProtocol: TEST_BRIDGE_PROTOCOL,
    metadataDirectory,
    portCandidates: [port],
    runtimeVersion: 'runtime-router-test',
    webRoot,
    services: {
      startProjectService: () => startRuntimeProjectService({ library: createMemoryLibrary() }),
    },
  });
  assert.equal(result.status, 'started');
  return {
    result,
    origin: result.metadata.origin,
    close: async () => {
      await closeStartedRuntime(result);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function jsonRequest(runtime, pathname, options = {}) {
  const response = await fetch(`${runtime.origin}${pathname}`, {
    ...options,
    headers: {
      Origin: runtime.origin,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  return response;
}

async function createSession(runtime) {
  const response = await jsonRequest(runtime, '/api/runtime/session', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const session = await response.json();
  assert.match(session.token, /^[A-Za-z0-9_-]{16,128}$/u);
  return session.token;
}

async function acquireLease(runtime, sessionToken, projectId) {
  const response = await jsonRequest(runtime, '/api/runtime/editor/acquire', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ projectId, force: false }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

test('serves a same-origin session and project-scoped lease protected project API without path capabilities', async () => {
  const runtime = await createRuntime();
  try {
    const foreign = await fetch(`${runtime.origin}/api/runtime/session`, {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:48199', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).error, 'origin_not_allowed');

    const id = '../../opaque-project';
    const cookie = await createSession(runtime);
    const leaseToken = await acquireLease(runtime, cookie, id);
    const record = projectRecord(id);
    const saved = await jsonRequest(runtime, '/api/runtime/project', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${cookie}`, 'X-Lumina-Editor-Lease': leaseToken },
      body: JSON.stringify(record),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).project, record);

    const listed = await fetch(`${runtime.origin}/api/runtime/projects`, {
      headers: { Authorization: `Bearer ${cookie}` },
    });
    assert.equal(listed.status, 200);
    const listPayload = await listed.json();
    assert.equal(listPayload.projects[0].id, id);
    assert.equal(JSON.stringify(listPayload).includes('snapshotPath'), false);
    assert.equal(JSON.stringify(listPayload).includes('library'), false);

    const opened = await jsonRequest(runtime, '/api/runtime/project/open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cookie}` },
      body: JSON.stringify({ projectId: id }),
    });
    assert.equal(opened.status, 200);
    assert.deepEqual((await opened.json()).project, record);

    const withoutLease = await jsonRequest(runtime, '/api/runtime/project/name', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${cookie}` },
      body: JSON.stringify({ projectId: id, name: 'Rejected', updatedAt: 3 }),
    });
    assert.equal(withoutLease.status, 409);
    assert.equal((await withoutLease.json()).error, 'editor_lease_invalid');

    const otherCookie = await createSession(runtime);
    const busy = await jsonRequest(runtime, '/api/runtime/editor/acquire', {
      method: 'POST',
      headers: { Authorization: `Bearer ${otherCookie}` },
      body: JSON.stringify({ projectId: id, force: false }),
    });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error, 'editor_busy');
  } finally {
    await runtime.close();
  }
});

test('streams bounded asset request bodies and returns only admitted metadata and bytes', async () => {
  const runtime = await createRuntime();
  try {
    const record = projectRecord('asset-project');
    const cookie = await createSession(runtime);
    const leaseToken = await acquireLease(runtime, cookie, record.id);
    await jsonRequest(runtime, '/api/runtime/project', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${cookie}`, 'X-Lumina-Editor-Lease': leaseToken },
      body: JSON.stringify(record),
    });

    const metadata = {
      assetId: '../opaque-asset',
      projectId: record.id,
      kind: 'image',
      sourceKind: 'import',
      mimeType: 'image/png',
      createdAt: 4,
      width: 1,
      height: 1,
      durationMs: null,
      sourceMetadata: { fileName: 'fixture.png' },
    };
    const encodedMetadata = Buffer.from(JSON.stringify(metadata)).toString('base64url');
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const written = await fetch(`${runtime.origin}/api/runtime/asset`, {
      method: 'PUT',
      headers: {
        Origin: runtime.origin,
        Authorization: `Bearer ${cookie}`,
        'Content-Type': 'image/png',
        'X-Lumina-Asset-Metadata': encodedMetadata,
        'X-Lumina-Editor-Lease': leaseToken,
      },
      body: bytes,
    });
    assert.equal(written.status, 201);
    assert.equal((await written.json()).metadata.byteCount, bytes.byteLength);

    const read = await fetch(`${runtime.origin}/api/runtime/asset?assetId=${encodeURIComponent(metadata.assetId)}`, {
      headers: { Authorization: `Bearer ${cookie}` },
    });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await read.arrayBuffer())], [...bytes]);

    const invalidMetadata = await fetch(`${runtime.origin}/api/runtime/asset`, {
      method: 'PUT',
      headers: {
        Origin: runtime.origin,
        Authorization: `Bearer ${cookie}`,
        'Content-Type': 'image/png',
        'X-Lumina-Asset-Metadata': Buffer.from('{"assetId":"a"}').toString('base64url'),
        'X-Lumina-Editor-Lease': leaseToken,
      },
      body: bytes,
    });
    assert.equal(invalidMetadata.status, 400);
  } finally {
    await runtime.close();
  }
});

test('rejects a declared oversized JSON request before reading its body', async () => {
  const runtime = await createRuntime();
  try {
    const cookie = await createSession(runtime);
    const leaseToken = await acquireLease(runtime, cookie, 'oversized-project');
    const response = await new Promise((resolve, reject) => {
      const request = http.request(`${runtime.origin}/api/runtime/project`, {
        method: 'PUT',
        headers: {
          Origin: runtime.origin,
          Authorization: `Bearer ${cookie}`,
          'Content-Type': 'application/json',
          'Content-Length': '999999999',
          'X-Lumina-Editor-Lease': leaseToken,
        },
      }, (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () => resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          status: incoming.statusCode,
        }));
      });
      request.once('error', reject);
      request.end();
    });
    assert.equal(response.status, 413);
    assert.equal(JSON.parse(response.body).error, 'request_too_large');
  } finally {
    await runtime.close();
  }
});

test('maps internal failures to stable path-free Runtime errors', async () => {
  const runtime = await createRuntime();
  try {
    const cookie = await createSession(runtime);
    const response = await jsonRequest(runtime, '/api/runtime/project/open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cookie}` },
      body: JSON.stringify({ projectId: 'force-private-error' }),
    });
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), {
      error: 'runtime_error',
      message: 'The Runtime project operation failed.',
    });
    assert.equal(text.includes('Users'), false);
    assert.equal(text.includes('head.json'), false);
  } finally {
    await runtime.close();
  }
});

test('starts the project service before the bridge and closes it after dependents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-runtime-service-order-'));
  const webRoot = path.join(root, 'web');
  const metadataDirectory = path.join(root, 'metadata');
  await fs.mkdir(webRoot);
  await fs.mkdir(metadataDirectory);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html>');
  const calls = [];
  const projectService = {
    createBrowserSession() {},
    async close() { calls.push('project:close'); },
  };
  const port = await findAvailableLocalRuntimePort();
  let result;
  try {
    result = await startLocalLuminaRuntime({
      bridgeProtocol: TEST_BRIDGE_PROTOCOL,
      metadataDirectory,
      portCandidates: [port],
      runtimeVersion: 'runtime-order-test',
      webRoot,
      services: {
        async startProjectService() { calls.push('project:start'); return projectService; },
        async startBridge(options) {
          assert.equal(options.projectService, projectService);
          calls.push('bridge:start');
          return { async close() { calls.push('bridge:close'); } };
        },
      },
    });
    assert.deepEqual(calls, ['project:start', 'bridge:start']);
    await result.runtime.close();
    result = undefined;
    assert.deepEqual(calls, ['project:start', 'bridge:start', 'bridge:close', 'project:close']);
  } finally {
    await closeStartedRuntime(result);
    await fs.rm(root, { recursive: true, force: true });
  }
});
