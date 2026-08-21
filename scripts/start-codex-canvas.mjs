import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

process.env.LUMINA_CANVAS_LOCAL_HOST = '1';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { createServer } = await import('vite');
const vite = await createServer({
  configFile: path.join(repositoryRoot, 'vite.config.ts'),
  root: repositoryRoot,
});
await vite.listen();
const address = vite.httpServer?.address();
if (!address || typeof address === 'string') {
  await vite.close();
  throw new Error('Lumina local canvas host did not expose a numeric loopback port.');
}

const origin = `http://127.0.0.1:${address.port}`;
const child = spawn(process.execPath, [
  path.join(repositoryRoot, 'canvas-agent', 'dist', 'index.js'),
  'web-mcp',
  '--canonical-origin',
  origin,
], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});

let closing = false;
const close = async (exitCode = 0) => {
  if (closing) {
    return;
  }
  closing = true;
  child.kill('SIGTERM');
  await vite.close();
  process.exitCode = exitCode;
};

child.once('exit', (code) => {
  void close(code ?? 1);
});
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
