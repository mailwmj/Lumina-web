/* global URL */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { parseLoopbackOrigin } from './loopbackOrigin.mjs';
import { createRuntimeProjectRouter } from './runtimeProjectRouter.mjs';

export function startLocalRuntimeHost(webRoot, port) {
  let metadata = null;
  let gatewayOrigin = null;
  let runtimeProjectRouter = null;
  const server = http.createServer({ maxHeaderSize: 72 * 1024 }, (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (isRuntimeProjectRequest(requestUrl.pathname)) {
      if (!runtimeProjectRouter) {
        response.writeHead(503, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
        }).end(JSON.stringify({
          error: 'runtime_unavailable',
          message: 'The Runtime project service is starting.',
        }));
        return;
      }
      void runtimeProjectRouter(request, response);
      return;
    }
    if (isGatewayRequest(requestUrl.pathname)) {
      proxyGatewayRequest(gatewayOrigin, request, response);
      return;
    }
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
        setGatewayOrigin: (nextGatewayOrigin) => {
          gatewayOrigin = parseLoopbackOrigin(
            nextGatewayOrigin,
            'Lumina local runtime requires a loopback GenerationGateway origin.',
          );
        },
        setProjectService: (projectService, canonicalOrigin) => {
          runtimeProjectRouter = createRuntimeProjectRouter({
            projectService,
            canonicalOrigin,
          });
        },
      });
    });
  });
}

export function closeLocalRuntimeHost(server) {
  server.closeAllConnections();
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

function isRuntimeProjectRequest(pathname) {
  return pathname === '/api/runtime' || pathname.startsWith('/api/runtime/');
}

function isGatewayRequest(pathname) {
  return pathname === '/api/generation' || pathname.startsWith('/api/generation/');
}

function proxyGatewayRequest(gatewayOrigin, request, response) {
  if (!gatewayOrigin) {
    response.writeHead(503, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    }).end(JSON.stringify({ error: 'gateway_unavailable', message: 'The GenerationGateway is starting.' }));
    return;
  }

  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, gatewayOrigin);
  const proxy = http.request(target, {
    headers: { ...request.headers, host: target.host },
    method: request.method,
  }, (upstream) => {
    response.writeHead(upstream.statusCode ?? 502, upstream.headers);
    upstream.pipe(response);
  });
  proxy.once('error', () => {
    if (!response.headersSent) {
      response.writeHead(502, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      }).end(JSON.stringify({ error: 'gateway_unavailable', message: 'The GenerationGateway is unavailable.' }));
      return;
    }
    response.destroy();
  });
  request.pipe(proxy);
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
