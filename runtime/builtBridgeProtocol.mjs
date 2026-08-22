import { parseBridgeProtocol } from './bridgeProtocol.mjs';

export async function readBuiltCanvasBridgeProtocol(errorMessage = 'Lumina production runtime requires a valid built canvas bridge protocol.') {
  const module = await import(new URL('../canvas-agent/dist/web/protocol.js', import.meta.url));
  return parseBridgeProtocol(module.WEB_CANVAS_PROTOCOL, errorMessage);
}
