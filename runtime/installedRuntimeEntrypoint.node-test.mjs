/* global URL, setTimeout */
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
    return child;
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
