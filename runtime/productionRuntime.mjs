import { fileURLToPath } from 'node:url';

import { startLocalGenerationGateway } from './gatewayProcess.mjs';
import { startLocalLuminaRuntime } from './localRuntime.mjs';

export async function startProductionLuminaRuntime(options = {}) {
  const webRoot = options.webRoot ?? defaultProductionWebRoot();
  return startLocalLuminaRuntime({
    ...options,
    webRoot,
    services: {
      startBridge: startProductionCanvasBridge,
      startGateway: startLocalGenerationGateway,
    },
  });
}

function defaultProductionWebRoot() {
  return fileURLToPath(new URL('../canvas-agent/web-dist', import.meta.url));
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
