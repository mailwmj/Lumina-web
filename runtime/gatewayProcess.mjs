import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { parseLoopbackOrigin } from './loopbackOrigin.mjs';

const GATEWAY_READY_TIMEOUT_MS = 5_000;
const GATEWAY_READY_MESSAGE_TYPE = 'lumina.gateway.ready';
const gatewayServer = fileURLToPath(new URL('../gateway/server.mjs', import.meta.url));

export async function startLocalGenerationGateway({ canonicalOrigin }) {
  const origin = parseLoopbackOrigin(
    canonicalOrigin,
    'Lumina local runtime requires an explicit loopback canonical Origin.',
  );
  const child = spawn(process.execPath, [gatewayServer], {
    env: {
      ...process.env,
      LUMINA_GATEWAY_ORIGIN: origin,
      LUMINA_GATEWAY_PORT: '0',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let port;
  try {
    port = await waitForGatewayPort(child);
  } catch (error) {
    await stopGateway(child);
    throw error;
  }

  let closePromise;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => {
      closePromise ??= stopGateway(child);
      return closePromise;
    },
  };
}

function waitForGatewayPort(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error('Lumina GenerationGateway did not become ready.'));
    }, GATEWAY_READY_TIMEOUT_MS);
    const onMessage = (message) => {
      if (
        message?.type === GATEWAY_READY_MESSAGE_TYPE
        && Number.isInteger(message.port)
        && message.port > 0
        && message.port <= 65_535
      ) {
        finish(null, message.port);
      }
    };
    const onExit = () => {
      finish(new Error('Lumina GenerationGateway exited before becoming ready.'));
    };
    const onError = () => {
      finish(new Error('Lumina GenerationGateway could not start.'));
    };
    const finish = (error, port) => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) {
        reject(error);
      } else {
        resolve(port);
      }
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function stopGateway(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}
