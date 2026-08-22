import assert from 'node:assert/strict';
import test from 'node:test';

import { startInstalledCanvasMcp } from './installedRuntime.mjs';

test('starts the installed runtime once and uses its bridge at the registered Origin', async () => {
  const bridge = { id: 'started-runtime-bridge' };
  let closed = false;
  let attached = false;
  let receivedBridge;

  const result = await startInstalledCanvasMcp({
    startRuntime: async () => ({
      status: 'started',
      metadata: { origin: 'http://127.0.0.1:48123' },
      runtime: {
        bridge,
        close: async () => {
          closed = true;
        },
      },
    }),
    startBridge: async () => {
      attached = true;
      throw new Error('A started runtime must reuse its own bridge.');
    },
    startMcp: async (value, onClose) => {
      receivedBridge = value;
      await onClose();
    },
  });

  assert.deepEqual(result, {
    status: 'started',
    origin: 'http://127.0.0.1:48123',
  });
  assert.equal(receivedBridge, bridge);
  assert.equal(attached, false);
  assert.equal(closed, true);
});

test('reuses a running installation and attaches only a bridge to its stable Origin', async () => {
  const attachedBridge = {
    close: async () => {},
    id: 'attached-bridge',
  };
  const attachedOrigins = [];
  let receivedBridge;
  let closed = false;

  const result = await startInstalledCanvasMcp({
    startRuntime: async () => ({
      status: 'reused',
      metadata: { origin: 'http://127.0.0.1:48124' },
    }),
    startBridge: async ({ canonicalOrigin }) => {
      attachedOrigins.push(canonicalOrigin);
      return {
        ...attachedBridge,
        close: async () => {
          closed = true;
        },
      };
    },
    startMcp: async (value, onClose) => {
      receivedBridge = value;
      await onClose();
    },
  });

  assert.deepEqual(result, {
    status: 'reused',
    origin: 'http://127.0.0.1:48124',
  });
  assert.deepEqual(attachedOrigins, ['http://127.0.0.1:48124']);
  assert.equal(receivedBridge.id, 'attached-bridge');
  assert.equal(closed, true);
});

test('fails closed before creating a bridge when the registered runtime requires repair', async () => {
  let bridgeCreated = false;
  let mcpStarted = false;

  const result = await startInstalledCanvasMcp({
    startRuntime: async () => ({
      status: 'repair-required',
      reason: 'registered-port-occupied',
    }),
    startBridge: async () => {
      bridgeCreated = true;
      throw new Error('A repair-required runtime must not attach a bridge.');
    },
    startMcp: async () => {
      mcpStarted = true;
      throw new Error('A repair-required runtime must not start MCP.');
    },
  });

  assert.deepEqual(result, {
    status: 'failed',
    code: 'registered-port-occupied',
    message: 'Lumina cannot open because its saved local address is in use. Repair Lumina to keep your existing projects.',
  });
  assert.equal(bridgeCreated, false);
  assert.equal(mcpStarted, false);
});

test('fails closed before creating a bridge when an updated runtime is incompatible with the running bridge', async () => {
  let bridgeCreated = false;
  let mcpStarted = false;

  const result = await startInstalledCanvasMcp({
    startRuntime: async () => ({
      status: 'repair-required',
      reason: 'runtime-incompatible',
    }),
    startBridge: async () => {
      bridgeCreated = true;
      throw new Error('An incompatible runtime must not attach a bridge.');
    },
    startMcp: async () => {
      mcpStarted = true;
      throw new Error('An incompatible runtime must not start MCP.');
    },
  });

  assert.deepEqual(result, {
    status: 'failed',
    code: 'runtime-incompatible',
    message: 'Lumina cannot connect because the running local service is incompatible. Close Lumina, then reopen it or run Repair.',
  });
  assert.equal(bridgeCreated, false);
  assert.equal(mcpStarted, false);
});
