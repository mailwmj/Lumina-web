/* global URL */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

export function startLocalRuntimeHost(webRoot, port) {
  let metadata = null;
  const server = http.createServer((request, response) => {
    void serveRequest(webRoot, metadata, request, response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        server,
        publishMetadata: (nextMetadata) => {
          metadata = nextMetadata;
        },
      });
    });
  });
}

export function closeLocalRuntimeHost(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function serveRequest(webRoot, metadata, request, response) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/health') {
    if (!metadata) {
      response.writeHead(503, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    }).end(JSON.stringify({ status: 'healthy', ...metadata }));
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let requestedPath;
  try {
    requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  } catch {
    response.writeHead(400).end();
    return;
  }
  const filePath = path.resolve(webRoot, requestedPath);
  if (!isWithinRoot(webRoot, filePath)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const resolvedPath = await fs.realpath(filePath);
    if (!isWithinRoot(webRoot, resolvedPath)) {
      response.writeHead(404).end();
      return;
    }
    const content = await fs.readFile(resolvedPath);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentType(resolvedPath),
    }).end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(404).end();
  }
}

function isWithinRoot(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function contentType(filePath) {
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
