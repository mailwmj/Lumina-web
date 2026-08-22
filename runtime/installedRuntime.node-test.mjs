/* global clearTimeout, process, setTimeout */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  openInstalledLumina,
  runInstalledRuntimeCli,
  serveInstalledLumina,
} from './installedRuntime.mjs';

test('opens the registered browser Origin after a protocol request starts the hidden runtime', async () => {
  const calls = [];
  const result = await openInstalledLumina({
    createReadyFile: async () => 'C:\\Temp\\lumina-ready.json',
    removeReadyFile: async (filePath) => calls.push(['remove-ready-file', filePath]),
    spawnRuntime: (command, arguments_, options) => {
      calls.push(['spawn-runtime', command, arguments_, options]);
      return { unref: () => calls.push(['unref']) };
    },
    waitForReady: async (filePath) => {
      calls.push(['wait-for-ready', filePath]);
      return {
        status: 'ready',
        origin: 'http://127.0.0.1:48123',
        runtimeStatus: 'started',
      };
    },
    openBrowser: async (origin) => calls.push(['open-browser', origin]),
    runtimeCommand: { command: 'LuminaRuntime.exe', arguments: [] },
  });

  assert.deepEqual(result, {
    status: 'opened',
    origin: 'http://127.0.0.1:48123',
    runtimeStatus: 'started',
  });
  assert.deepEqual(calls, [
    ['spawn-runtime', 'LuminaRuntime.exe', ['--serve', '--ready-file', 'C:\\Temp\\lumina-ready.json'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }],
    ['unref'],
    ['wait-for-ready', 'C:\\Temp\\lumina-ready.json'],
    ['open-browser', 'http://127.0.0.1:48123'],
    ['remove-ready-file', 'C:\\Temp\\lumina-ready.json'],
  ]);
});

test('reports a registered-port repair failure without opening another Origin', async () => {
  const errors = [];
  const result = await openInstalledLumina({
    createReadyFile: async () => '/tmp/lumina-ready.json',
    removeReadyFile: async () => {},
    spawnRuntime: () => ({ unref() {} }),
    waitForReady: async () => ({
      status: 'failed',
      code: 'registered-port-occupied',
      message: 'The registered Lumina address is already in use.',
    }),
    openBrowser: async () => assert.fail('a repair-required runtime must not open a replacement Origin'),
    showError: async (message) => errors.push(message),
    runtimeCommand: { command: 'LuminaRuntime', arguments: [] },
  });

  assert.deepEqual(result, {
    status: 'failed',
    code: 'registered-port-occupied',
    message: 'Lumina cannot open because its saved local address is in use. Repair Lumina to keep your existing projects.',
  });
  assert.deepEqual(errors, [result.message]);
});

test('the background runtime writes readiness for a reused installation and does not wait for shutdown', async () => {
  const readiness = [];
  let waitedForShutdown = false;
  const result = await serveInstalledLumina({
    startRuntime: async () => ({
      status: 'reused',
      metadata: { origin: 'http://127.0.0.1:48124' },
    }),
    writeReady: async (_filePath, value) => readiness.push(value),
    readyFile: '/tmp/lumina-ready.json',
    waitForShutdown: async () => {
      waitedForShutdown = true;
    },
  });

  assert.deepEqual(result, {
    status: 'reused',
    origin: 'http://127.0.0.1:48124',
  });
  assert.deepEqual(readiness, [{
    status: 'ready',
    origin: 'http://127.0.0.1:48124',
    runtimeStatus: 'reused',
  }]);
  assert.equal(waitedForShutdown, false);
});

test('the background runtime remains available until shutdown and then closes the started service', async () => {
  const readiness = [];
  let closed = false;
  const shutdown = setTimeout(() => process.emit('SIGTERM'), 10);
  try {
    const result = await serveInstalledLumina({
      startRuntime: async () => ({
        status: 'started',
        metadata: { origin: 'http://127.0.0.1:48125' },
        runtime: { close: async () => { closed = true; } },
      }),
      writeReady: async (_filePath, value) => readiness.push(value),
      readyFile: '/tmp/lumina-ready.json',
    });

    assert.deepEqual(result, { status: 'started', origin: 'http://127.0.0.1:48125' });
    assert.deepEqual(readiness, [{
      status: 'ready',
      origin: 'http://127.0.0.1:48125',
      runtimeStatus: 'started',
    }]);
    assert.equal(closed, true);
  } finally {
    clearTimeout(shutdown);
  }
});

test('a background startup failure keeps the user result generic while reporting the cause to diagnostics', async () => {
  const readiness = [];
  const diagnostics = [];
  const result = await serveInstalledLumina({
    startRuntime: async () => {
      throw new Error('bridge artifact is unavailable');
    },
    writeReady: async (_filePath, value) => readiness.push(value),
    readyFile: '/tmp/lumina-ready.json',
    reportDiagnostic: (error) => diagnostics.push(error.message),
  });

  assert.deepEqual(result, {
    status: 'failed',
    code: 'runtime-start-failed',
    message: 'Lumina could not start. Run the Lumina installer again and choose Repair.',
  });
  assert.deepEqual(readiness, [{
    status: 'failed',
    code: 'runtime-start-failed',
    message: result.message,
  }]);
  assert.deepEqual(diagnostics, ['bridge artifact is unavailable']);
});

test('the CLI accepts only lumina://open protocol requests', async () => {
  const opened = [];
  const invalid = await runInstalledRuntimeCli(['lumina://other'], {
    open: async () => opened.push('opened'),
    showError: async (message) => opened.push(message),
  });

  assert.deepEqual(invalid, {
    status: 'failed',
    code: 'invalid-protocol',
    message: 'This is not a valid Lumina link.',
  });
  assert.deepEqual(opened, ['This is not a valid Lumina link.']);
});
