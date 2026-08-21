import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export interface LocalCanvasHost {
  origin: string;
  close(): Promise<void>;
}

export async function startLocalCanvasHost(assetDirectory: string): Promise<LocalCanvasHost> {
  const root = await fs.realpath(assetDirectory);
  await fs.access(path.join(root, 'index.html'));
  const server = http.createServer((request, response) => {
    void serveAsset(root, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function serveAsset(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const requestedPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(requestedPath).replace(/^\/+/, '') || 'index.html';
  } catch {
    response.writeHead(400).end();
    return;
  }
  const filePath = path.resolve(root, relativePath);
  if (!isWithinRoot(root, filePath)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const resolvedPath = await fs.realpath(filePath);
    if (!isWithinRoot(root, resolvedPath)) {
      response.writeHead(404).end();
      return;
    }
    const content = await fs.readFile(resolvedPath);
    response.writeHead(200, {
      'Content-Type': contentType(resolvedPath),
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(404).end();
  }
}

function isWithinRoot(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff2': return 'font/woff2';
    default: return 'text/html; charset=utf-8';
  }
}
