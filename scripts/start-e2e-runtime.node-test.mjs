import assert from 'node:assert/strict';
import test from 'node:test';

import { FileProjectLibraryError } from '../runtime/fileProjectLibrary.mjs';
import { runE2eRuntime, startE2eRuntime } from './start-e2e-runtime.mjs';

test('closes the E2E Runtime and removes its isolated fixture exactly once', async () => {
  const calls = [];
  const session = await startE2eRuntime({
    createTemporaryDirectory: async () => '/private/tmp/lumina-e2e-fixture',
    removeDirectory: async (directory) => calls.push(['remove', directory]),
    startRuntime: async () => ({
      status: 'started',
      metadata: { origin: 'http://127.0.0.1:48100' },
      runtime: { async close() { calls.push(['close']); } },
    }),
  });

  await session.close();
  await session.close();
  assert.deepEqual(calls, [
    ['close'],
    ['remove', '/private/tmp/lumina-e2e-fixture'],
  ]);
});

test('cleans the fixture and identifies managed-root startup failures as test-path failures', async () => {
  const calls = [];
  await assert.rejects(
    startE2eRuntime({
      createTemporaryDirectory: async () => '/private/tmp/lumina-e2e-fixture',
      removeDirectory: async (directory) => calls.push(['remove', directory]),
      startRuntime: async () => {
        throw new FileProjectLibraryError('path_escape', 'fixture path escaped');
      },
    }),
    /test fixture path failure, not project data corruption/u,
  );
  assert.deepEqual(calls, [['remove', '/private/tmp/lumina-e2e-fixture']]);
});

test('cleans the Runtime and fixture when the launcher exits abnormally', async () => {
  const calls = [];
  await assert.rejects(
    runE2eRuntime({
      createTemporaryDirectory: async () => '/private/tmp/lumina-e2e-fixture',
      removeDirectory: async (directory) => calls.push(['remove', directory]),
      startRuntime: async () => ({
        status: 'started',
        metadata: { origin: 'http://127.0.0.1:48100' },
        runtime: { async close() { calls.push(['close']); } },
      }),
      waitForShutdown: async () => { throw new Error('simulated launcher failure'); },
    }),
    /simulated launcher failure/u,
  );
  assert.deepEqual(calls, [
    ['close'],
    ['remove', '/private/tmp/lumina-e2e-fixture'],
  ]);
});

test('removes the fixture even when Runtime shutdown fails', async () => {
  const calls = [];
  const session = await startE2eRuntime({
    createTemporaryDirectory: async () => '/private/tmp/lumina-e2e-fixture',
    removeDirectory: async (directory) => calls.push(['remove', directory]),
    startRuntime: async () => ({
      status: 'started',
      metadata: { origin: 'http://127.0.0.1:48100' },
      runtime: { async close() { calls.push(['close']); throw new Error('close failed'); } },
    }),
  });
  await assert.rejects(session.close(), /close failed/u);
  assert.deepEqual(calls, [
    ['close'],
    ['remove', '/private/tmp/lumina-e2e-fixture'],
  ]);
});
