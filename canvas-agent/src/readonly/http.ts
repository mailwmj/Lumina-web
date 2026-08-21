import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { parseReadonlyCanvasHello } from './protocol.js';
import {
  ReadonlyCanvasError,
  ReadonlyCanvasSession,
  type ReadonlyCanvasBootstrap,
} from './session.js';

const MAX_BODY_BYTES = 256 * 1024;

export interface ReadonlyCanvasCompanion {
  server: http.Server;
  url: string;
  canonicalOrigin: string;
  session: ReadonlyCanvasSession;
  issueBootstrap(): ReadonlyCanvasBootstrap;
  close(): Promise<void>;
}

interface StartReadonlyCanvasCompanionOptions {
  port?: number;
  canonicalOrigin: string;
  createToken?: () => string;
}

export async function startReadonlyCanvasCompanion(
  options: StartReadonlyCanvasCompanionOptions,
): Promise<ReadonlyCanvasCompanion> {
  const canonicalOrigin = parseCanonicalLocalOrigin(options.canonicalOrigin);
  const session = new ReadonlyCanvasSession({ createToken: options.createToken });
  let closePromise: Promise<void> | null = null;
  const server = http.createServer((request, response) => {
    void routeRequest(session, canonicalOrigin, request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  return {
    server,
    url,
    session,
    canonicalOrigin,
    issueBootstrap: () => session.issueBootstrap(url, canonicalOrigin),
    close: () => {
      closePromise ??= new Promise<void>((resolve, reject) => {
        session.close();
        server.closeAllConnections();
        server.close((error) => error ? reject(error) : resolve());
      });
      return closePromise;
    },
  };
}

async function routeRequest(
  session: ReadonlyCanvasSession,
  canonicalOrigin: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!applyCors(request, response, canonicalOrigin)) {
    throw new ReadonlyCanvasError('ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
  }
  if (request.headers.accept?.includes('text/event-stream')) {
    throw new ReadonlyCanvasError('METHOD_NOT_ALLOWED', 'SSE is not supported by the read-only companion.');
  }
  if (request.method === 'OPTIONS') {
    if (request.headers['access-control-request-method']
      && request.headers['access-control-request-method'] !== 'POST') {
      throw new ReadonlyCanvasError('METHOD_NOT_ALLOWED', 'Only POST is supported.');
    }
    response.writeHead(204).end();
    return;
  }
  if (request.method !== 'POST') {
    throw new ReadonlyCanvasError('METHOD_NOT_ALLOWED', 'Only POST is supported.');
  }

  const path = new URL(request.url ?? '/', canonicalOrigin).pathname;
  if (!['/v1/connect', '/v1/state', '/v1/disconnect'].includes(path)) {
    throw new ReadonlyCanvasError('NOT_FOUND', 'Route not found.');
  }
  const token = readBearerToken(request);
  const body = await readJson(request);
  const record = readRecord(body);
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;

  if (path === '/v1/connect') {
    rejectUnknownFields(record, ['sessionId', 'protocol', 'capabilities']);
    session.connect(token, parseReadonlyCanvasHello({
      protocol: record.protocol,
      capabilities: record.capabilities,
    }), sessionId);
  } else if (path === '/v1/state') {
    const { sessionId: _sessionId, ...snapshot } = record;
    session.publish(token, snapshot, sessionId);
  } else {
    rejectUnknownFields(record, ['sessionId']);
    session.disconnect(token, sessionId);
  }
  sendJson(response, 200, { ok: true });
}

function applyCors(request: IncomingMessage, response: ServerResponse, canonicalOrigin: string): boolean {
  if (request.headers.origin !== canonicalOrigin) {
    return false;
  }
  response.setHeader('Access-Control-Allow-Origin', canonicalOrigin);
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
  response.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
  response.setHeader('Cache-Control', 'no-store');
  return true;
}

export function parseCanonicalLocalOrigin(value: string): string {
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== 'http:'
      || origin.hostname !== '127.0.0.1'
      || !origin.port
      || origin.username
      || origin.password
      || origin.pathname !== '/'
      || origin.search
      || origin.hash
    ) {
      throw new Error();
    }
    return origin.origin;
  } catch {
    throw new ReadonlyCanvasError(
      'INVALID_CANONICAL_ORIGIN',
      'The canonical Origin must be an explicit http://127.0.0.1:<port> URL.',
    );
  }
}

function readBearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    throw new ReadonlyCanvasError('UNAUTHORIZED', 'The canvas bridge token is invalid.');
  }
  return authorization.slice('Bearer '.length);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ReadonlyCanvasError('REQUEST_TOO_LARGE', 'The request body is too large.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ReadonlyCanvasError('INVALID_JSON', 'The request body is not valid JSON.');
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReadonlyCanvasError('INVALID_ARGUMENTS', 'The request body must be an object.');
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new ReadonlyCanvasError('INVALID_ARGUMENTS', 'The request body contains unsupported fields.');
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: unknown): void {
  const resolved = error instanceof ReadonlyCanvasError
    ? error
    : new ReadonlyCanvasError('INVALID_ARGUMENTS', error instanceof Error ? error.message : String(error));
  const status = resolved.code === 'UNAUTHORIZED'
    ? 401
    : resolved.code === 'ORIGIN_NOT_ALLOWED'
      ? 403
      : resolved.code === 'NOT_FOUND'
        ? 404
        : resolved.code === 'METHOD_NOT_ALLOWED'
          ? 405
          : resolved.code === 'REQUEST_TOO_LARGE'
            ? 413
            : 400;
  sendJson(response, status, { ok: false, error: { code: resolved.code, message: resolved.message } });
}
