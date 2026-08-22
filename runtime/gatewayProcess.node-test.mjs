/* global process */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const gatewayServer = fileURLToPath(new URL('../gateway/server.mjs', import.meta.url));

test('announces its assigned loopback port through structured IPC', async () => {
  const gateway = spawn(process.execPath, [gatewayServer], {
    env: {
      ...process.env,
      LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:48100',
      LUMINA_GATEWAY_PORT: '0',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const message = await waitForGatewayReady(gateway);
    assert.equal(message?.type, 'lumina.gateway.ready');
    assert.ok(Number.isInteger(message?.port));
    assert.ok(message.port > 0 && message.port <= 65_535);
  } finally {
    await stopGateway(gateway);
  }
});

function waitForGatewayReady(gateway) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Gateway did not announce readiness.')), 1_000);
    const onMessage = (message) => finish(null, message);
    const onExit = () => finish(new Error('Gateway exited before announcing readiness.'));
    const finish = (error, message) => {
      clearTimeout(timeout);
      gateway.off('message', onMessage);
      gateway.off('exit', onExit);
      if (error) {
        reject(error);
      } else {
        resolve(message);
      }
    };
    gateway.once('message', onMessage);
    gateway.once('exit', onExit);
  });
}

async function stopGateway(gateway) {
  if (gateway.exitCode !== null || gateway.signalCode !== null) {
    return;
  }
  const exited = once(gateway, 'exit');
  gateway.kill('SIGTERM');
  await exited;
}
