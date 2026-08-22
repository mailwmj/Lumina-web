/* global URL */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { startLocalGenerationGateway } from './gatewayProcess.mjs';
import { startLocalLuminaRuntime } from './localRuntime.mjs';
import { isPackagedRuntime } from './packagedRuntime.mjs';

export async function startProductionLuminaRuntime(options = {}) {
  const webRoot = options.webRoot ?? await defaultProductionWebRoot();
  return startLocalLuminaRuntime({
    ...options,
    webRoot,
    services: {
      startBridge: startProductionCanvasBridge,
      startGateway: startLocalGenerationGateway,
    },
  });
}

async function defaultProductionWebRoot() {
  if (await isPackagedRuntime()) {
    return packagedRuntimeWebRoot({ executablePath: process.execPath, platform: process.platform });
  }
  return fileURLToPath(new URL('../canvas-agent/web-dist', import.meta.url));
}

export function packagedRuntimeWebRoot({ executablePath, platform }) {
  const executableDirectory = path.dirname(executablePath);
  return platform === 'darwin'
    ? path.join(executableDirectory, '..', 'Resources', 'web')
    : path.join(executableDirectory, 'web');
}

async function startProductionCanvasBridge({ canonicalOrigin }) {
  let module;
  try {
    module = await import('../canvas-agent/dist/web/http.js');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('Lumina production runtime requires built canvas-agent artifacts.');
    }
    throw error;
  }
  return module.startWebCanvasCompanion({ canonicalOrigin });
}
