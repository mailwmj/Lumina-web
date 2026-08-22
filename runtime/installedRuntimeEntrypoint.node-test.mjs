/* global URL, clearTimeout, setTimeout */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openInstalledLumina } from './installedRuntime.mjs';

const entrypoint = fileURLToPath(new URL('./installedRuntimeEntrypoint.mjs', import.meta.url));

test('the installed-runtime entrypoint starts once and reuses the registered service for a second launcher', { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-installed-entrypoint-'));
  const metadataDirectory = path.join(root, 'runtime');
  const firstReady = path.join(root, 'first-ready.json');
  const secondReady = path.join(root, 'second-ready.json');
  let first;
  let second;
  try {
    first = launch(['--serve', '--ready-file', firstReady, '--metadata-directory', metadataDirectory]);
    const firstStatus = await waitForReady(firstReady);
    assert.equal(firstStatus.status, 'ready');
    assert.match(firstStatus.origin, /^http:\/\/127\.0\.0\.1:48\d{3}$/u);
    assert.equal(firstStatus.runtimeStatus, 'started');

    second = launch(['--serve', '--ready-file', secondReady, '--metadata-directory', metadataDirectory]);
    const secondStatus = await waitForReady(secondReady);
    assert.deepEqual(secondStatus, {
      status: 'ready',
      origin: firstStatus.origin,
      runtimeStatus: 'reused',
    });
    assert.equal(await exitCode(second), 0);
    second = undefined;
  } finally {
    await stop(first);
    await stop(second);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the protocol launcher opens the same registered Origin after starting and reusing the runtime', { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-installed-protocol-'));
  const metadataDirectory = path.join(root, 'runtime');
  const launches = [];
  const opened = [];
  try {
    const first = await openInstalledLumina({
      metadataDirectory,
      openBrowser: async (origin) => opened.push(origin),
      spawnRuntime: captureRuntime(launches),
    });
    const second = await openInstalledLumina({
      metadataDirectory,
      openBrowser: async (origin) => opened.push(origin),
      spawnRuntime: captureRuntime(launches),
    });

    assert.equal(first.status, 'opened');
    assert.match(first.origin, /^http:\/\/127\.0\.0\.1:48\d{3}$/u);
    assert.equal(first.runtimeStatus, 'started');
    assert.equal(second.status, 'opened');
    assert.equal(second.origin, first.origin);
    assert.equal(second.runtimeStatus, 'reused');
    assert.deepEqual(opened, [first.origin, first.origin]);
    assert.equal(launches.length, 2);
    assert.equal(await launches[1].exited, 0);
  } finally {
    await Promise.all(launches.map(stopLaunch));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the installed MCP entrypoint keeps its bridge open and reuses the registered Chrome Origin', { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-installed-mcp-entrypoint-'));
  const appData = path.join(root, 'app-data');
  let first;
  let second;
  try {
    first = launchCanvasMcp(appData);
    await first.initialize();
    const firstOpen = await first.open();
    const firstOrigin = new URL(firstOpen.canonicalOrigin);
    assert.match(firstOrigin.origin, /^http:\/\/127\.0\.0\.1:48\d{3}$/u);
    await assertBridgeIsReachable(firstOpen, first.stderr);

    second = launchCanvasMcp(appData);
    await second.initialize();
    const secondOpen = await second.open();
    assert.equal(secondOpen.canonicalOrigin, firstOpen.canonicalOrigin);
    await assertBridgeIsReachable(secondOpen, second.stderr);

    await endCanvasMcp(second);
    second = undefined;
    await endCanvasMcp(first);
    first = undefined;
  } finally {
    await stop(second?.child);
    await stop(first?.child);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function launch(arguments_) {
  return spawn(process.execPath, [entrypoint, ...arguments_], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

function captureRuntime(launches) {
  return (command, arguments_, options) => {
    const child = spawn(command, arguments_, {
      ...options,
      detached: false,
      stdio: 'ignore',
    });
    const launch = {
      child,
      exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    };
    launches.push(launch);
    return { once: child.once.bind(child) };
  };
}

function launchCanvasMcp(appData) {
  const child = spawn(process.execPath, [entrypoint, '--canvas-mcp'], {
    cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    env: { ...process.env, APPDATA: appData },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const responses = createResponseReader(child.stdout);
  let nextId = 1;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    get stderr() {
      return stderr;
    },
    async initialize() {
      const response = await sendMcpRequest(child, responses, nextId++, {
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'lumina-installed-mcp-test', version: '1.0.0' },
        },
      });
      assert.equal(response.error, undefined, stderr);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    },
    async open() {
      const response = await sendMcpRequest(child, responses, nextId++, {
        method: 'tools/call',
        params: { name: 'canvas_open', arguments: {} },
      });
      assert.equal(response.error, undefined, stderr);
      const text = response.result?.content?.[0]?.text;
      assert.ok(text, stderr);
      return JSON.parse(text);
    },
  };
}

async function endCanvasMcp(connection) {
  const child = connection?.child;
  if (!child || child.exitCode !== null) return;
  const exit = once(child, 'exit');
  child.stdin.end();
  const [code] = await waitForExit(exit, connection.stderr);
  assert.equal(code, 0, connection.stderr);
}

function waitForExit(exit, stderr) {
  let timeout;
  return Promise.race([
    exit,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Lumina MCP did not exit after stdio closed: ${stderr}`)), 2_000);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function assertBridgeIsReachable(opened, stderr) {
  assert.equal(opened.status, 'awaiting_browser', stderr);
  const url = new URL(opened.url);
  const bootstrap = JSON.parse(decodeURIComponent(url.hash.slice('#lumina-canvas='.length)));
  const response = await fetch(`${bootstrap.endpoint}/v1/connect`, {
    method: 'OPTIONS',
    headers: {
      Origin: opened.canonicalOrigin,
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(response.status, 204, stderr);
}

function sendMcpRequest(child, responses, id, request) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...request })}\n`);
  return responses.waitFor(id);
}

function createResponseReader(stream) {
  let buffer = '';
  const responses = new Map();
  const waiters = new Map();
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const response = JSON.parse(line);
        if (typeof response.id === 'number') {
          const waiter = waiters.get(response.id);
          if (waiter) {
            waiters.delete(response.id);
            waiter(response);
          } else {
            responses.set(response.id, response);
          }
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });
  return {
    waitFor(id) {
      const existing = responses.get(id);
      if (existing) {
        responses.delete(id);
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => waiters.set(id, resolve));
    },
  };
}

async function waitForReady(filePath) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('Lumina installed runtime did not write a readiness result.');
}

async function exitCode(child) {
  if (child.exitCode !== null) return child.exitCode;
  const [code] = await once(child, 'exit');
  return code;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

async function stopLaunch(launch) {
  if (launch.child.exitCode === null) {
    launch.child.kill('SIGTERM');
  }
  await launch.exited;
}
