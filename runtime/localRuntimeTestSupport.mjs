import { createServer } from 'node:http';

import { LOCAL_RUNTIME_PORTS } from './localRuntime.mjs';
import { closeLocalRuntimeHost } from './localRuntimeHost.mjs';

export const TEST_BRIDGE_PROTOCOL = Object.freeze({
  major: 1,
  minor: 0,
  build: 'lumina-canvas-web-v1',
});

export async function findAvailableLocalRuntimePort() {
  return (await findAvailableLocalRuntimePorts(1))[0];
}

export async function findAvailableLocalRuntimePorts(count) {
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

export function listenOnLoopback(port) {
  const server = createServer((_request, response) => response.writeHead(204).end());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export const closeTestServer = closeLocalRuntimeHost;

export async function closeStartedRuntime(result) {
  if (result?.status === 'started') {
    await result.runtime.close();
  }
}

async function canListen(port) {
  try {
    const server = await listenOnLoopback(port);
    await closeTestServer(server);
    return true;
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      return false;
    }
    throw error;
  }
}
