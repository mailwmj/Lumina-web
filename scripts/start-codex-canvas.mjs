import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

process.env.LUMINA_CANVAS_LOCAL_HOST = '1';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createServer } = await import('vite');
const vite = await createServer({
  configFile: path.join(repositoryRoot, 'vite.config.ts'),
  root: repositoryRoot,
  logLevel: 'error',
});
const httpServer = vite.httpServer;
if (!httpServer) {
  await vite.close();
  throw new Error('Lumina local canvas host did not create an HTTP server.');
}
await new Promise((resolve, reject) => {
  const onError = (error) => {
    httpServer.off('listening', onListening);
    reject(error);
  };
  const onListening = () => {
    httpServer.off('error', onError);
    resolve();
  };
  httpServer.once('error', onError);
  httpServer.once('listening', onListening);
  void httpServer.listen(0, '127.0.0.1');
});
const address = httpServer.address();
if (!address || typeof address === 'string') {
  await vite.close();
  throw new Error('Lumina local canvas host did not expose a numeric loopback port.');
}

const origin = `http://127.0.0.1:${address.port}`;
const { startWebCanvasCompanion } = await import('../canvas-agent/dist/web/http.js');
const { startWebMcpServer } = await import('../canvas-agent/dist/web/mcp.js');
const companion = await startWebCanvasCompanion({ canonicalOrigin: origin });

let closing = false;
const close = async (exitCode = 0) => {
  if (closing) {
    return;
  }
  closing = true;
  await companion.close();
  await vite.close();
  process.exit(exitCode);
};

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
await startWebMcpServer(companion, () => void close());
