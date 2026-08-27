import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildInstalledRuntime, createRuntimeBuildPlan } from './package-local-runtime.mjs';

const execFileAsync = promisify(execFile);

const expectedCanvasTools = [
  'canvas_get_action_status',
  'canvas_get_capabilities',
  'canvas_get_change_status',
  'canvas_get_node_images',
  'canvas_get_selection',
  'canvas_get_state',
  'canvas_import_images',
  'canvas_open',
  'canvas_propose_changes',
  'canvas_run_nodes',
  'canvas_wait_for_nodes',
];

test('describes a Windows compiled runtime without requiring a user Node installation', () => {
  const plan = createRuntimeBuildPlan({
    platform: 'win32',
    arch: 'x64',
    outputDirectory: 'release/runtime',
  });

  assert.equal(plan.executable, path.resolve('release/runtime', 'win32-x64', 'LuminaRuntime.exe'));
  assert.equal(plan.seaConfig.main.endsWith('installedRuntime.bundle.cjs'), true);
  assert.equal(plan.requiresNativeBuildHost, true);
  assert.equal(plan.entrypoint.endsWith(path.join('runtime', 'installedRuntimeEntrypoint.mjs')), true);
});

test('rejects platforms and architectures that do not have a supported installer target', () => {
  assert.throws(
    () => createRuntimeBuildPlan({ platform: 'linux', arch: 'x64', outputDirectory: 'release/runtime' }),
    /Windows and macOS/,
  );
  assert.throws(
    () => createRuntimeBuildPlan({ platform: 'darwin', arch: 'ia32', outputDirectory: 'release/runtime' }),
    /x64 and arm64/,
  );
});

test('the native macOS arm64 SEA runtime starts, persists projects, and exposes the complete canvas MCP tool surface', {
  skip: process.platform === 'darwin' && process.arch === 'arm64'
    ? false
    : 'requires a native macOS arm64 build host',
  timeout: 30_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'lumina-runtime-sea-'));
  const outputDirectory = path.join(root, 'runtime');
  let child;
  let runtimeChild;
  try {
    const plan = await buildInstalledRuntime({
      platform: 'darwin',
      arch: 'arm64',
      outputDirectory,
    });
    const contentsDirectory = path.join(root, 'Lumina.app', 'Contents');
    const executable = path.join(contentsDirectory, 'MacOS', 'LuminaRuntime');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.copyFile(plan.executable, executable);
    await fs.chmod(executable, 0o755);
    await execFileAsync('codesign', ['--verify', '--strict', executable]);
    const signature = await execFileAsync('codesign', ['--display', '--verbose=2', executable]);
    assert.match(signature.stderr, /Signature=adhoc/u);
    const macho = await execFileAsync('otool', ['-l', executable]);
    assert.match(macho.stdout, /segname NODE_SEA/u);
    t.diagnostic('SEA signature: ad-hoc and codesign --verify --strict passed');
    t.diagnostic('SEA Mach-O segment: NODE_SEA');
    await fs.writeFile(path.join(path.dirname(executable), 'runtime-version.json'), JSON.stringify({
      version: '0.2.41',
      bridgeProtocol: {
        major: 2,
        minor: 0,
        build: 'lumina-canvas-web-v2',
      },
    }), 'utf8');
    const webRoot = path.join(contentsDirectory, 'Resources', 'web');
    await fs.mkdir(webRoot, { recursive: true });
    await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Lumina</title>', 'utf8');

    const runtimeEnvironment = {
      ...process.env,
      HOME: path.join(root, 'home'),
      LUMINA_RUNTIME_DIAGNOSTICS: '1',
    };
    const readyFile = path.join(root, 'runtime-ready.json');
    runtimeChild = spawn(executable, ['--serve', '--ready-file', readyFile], {
      cwd: root,
      env: runtimeEnvironment,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const runtimeDiagnostics = captureStderr(runtimeChild);
    const readiness = await waitForReady(runtimeChild, readyFile, runtimeDiagnostics);
    assert.equal(readiness.status, 'ready', runtimeDiagnostics());
    assert.equal(readiness.runtimeStatus, 'started', runtimeDiagnostics());
    const health = await (await fetch(`${readiness.origin}/health`)).json();
    assert.equal(health.status, 'healthy');
    assert.equal(health.origin, readiness.origin);
    assert.equal(typeof health.installationId, 'string');
    t.diagnostic(`SEA health Origin: ${health.origin}`);

    const session = await runtimeRequest(readiness.origin, '/api/runtime/session', { method: 'POST' });
    const lease = await runtimeRequest(readiness.origin, '/api/runtime/editor/acquire', {
      method: 'POST',
      sessionToken: session.token,
      body: { projectId: 'project-sea-restart', force: false },
    });
    await runtimeRequest(readiness.origin, '/api/runtime/project', {
      method: 'PUT',
      sessionToken: session.token,
      leaseToken: lease.token,
      body: projectRecord('project-sea-restart'),
    });

    await stop(runtimeChild);
    runtimeChild = spawn(executable, ['--serve', '--ready-file', path.join(root, 'runtime-restarted.json')], {
      cwd: root,
      env: runtimeEnvironment,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const restartedDiagnostics = captureStderr(runtimeChild);
    const restarted = await waitForReady(
      runtimeChild,
      path.join(root, 'runtime-restarted.json'),
      restartedDiagnostics,
    );
    assert.equal(restarted.status, 'ready', restartedDiagnostics());
    assert.equal(restarted.origin, readiness.origin, restartedDiagnostics());
    const restartedSession = await runtimeRequest(restarted.origin, '/api/runtime/session', { method: 'POST' });
    const opened = await runtimeRequest(restarted.origin, '/api/runtime/project/open', {
      method: 'POST',
      sessionToken: restartedSession.token,
      body: { projectId: 'project-sea-restart' },
    });
    assert.equal(opened.project.name, 'SEA restart fixture');
    t.diagnostic(`SEA restart restored project: ${opened.project.id}`);

    child = spawn(executable, ['--canvas-mcp'], {
      cwd: root,
      env: runtimeEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rpc = createJsonRpcClient(child);
    const initialized = await rpc.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'lumina-sea-regression-test', version: '1.0.0' },
    });
    assert.equal(initialized.error, undefined, rpc.stderr());
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const listed = await rpc.request('tools/list', {});
    assert.equal(listed.error, undefined, rpc.stderr());
    const tools = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(tools, expectedCanvasTools);
    t.diagnostic(`SEA MCP tools/list (${tools.length}): ${tools.join(', ')}`);
  } finally {
    await stop(child);
    await stop(runtimeChild);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function runtimeRequest(origin, pathname, options) {
  const response = await fetch(`${origin}${pathname}`, {
    method: options.method,
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'X-Lumina-Runtime-Api-Version': '2',
      ...(options.sessionToken ? { Authorization: `Bearer ${options.sessionToken}` } : {}),
      ...(options.leaseToken ? { 'X-Lumina-Editor-Lease': options.leaseToken } : {}),
    },
    body: JSON.stringify(options.body ?? {}),
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}

function projectRecord(id) {
  return {
    id,
    name: 'SEA restart fixture',
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

function captureStderr(child) {
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return () => stderr;
}

async function waitForReady(child, readyFile, diagnostics) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Lumina SEA exited before becoming ready: ${diagnostics()}`);
    }
    try {
      return JSON.parse(await fs.readFile(readyFile, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Lumina SEA did not become ready: ${diagnostics()}`);
}

function createJsonRpcClient(child) {
  let buffer = '';
  let nextId = 1;
  let stderr = '';
  const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const response = JSON.parse(line);
        const waiter = waiters.get(response.id);
        if (waiter) {
          waiters.delete(response.id);
          waiter.resolve(response);
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });
  child.once('exit', (code, signal) => {
    const error = new Error(`Lumina SEA exited before replying (code ${code}, signal ${signal}): ${stderr}`);
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  });
  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`Lumina SEA did not reply to ${method}: ${stderr}`));
        }, 10_000);
        waiters.set(id, {
          resolve: (response) => {
            clearTimeout(timeout);
            resolve(response);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    stderr: () => stderr,
  };
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (child.stdin) {
    child.stdin.end();
  } else {
    child.kill('SIGTERM');
  }
  const timeout = setTimeout(() => child.kill('SIGTERM'), 2_000);
  await exited;
  clearTimeout(timeout);
}
