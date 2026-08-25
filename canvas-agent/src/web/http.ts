import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { CanvasAgentError, type CanvasProposalStatus } from '../canvas/protocol.js';
import { parseWebCanvasHello } from './protocol.js';
import {
  WebCanvasSession,
  type WebCanvasBootstrap,
  type WebCanvasOpenResult,
  type RuntimeProjectAuthority,
} from './session.js';

const MAX_BODY_BYTES = 12 * 1024 * 1024;

export interface WebCanvasCompanion {
  server: http.Server;
  url: string;
  canonicalOrigin: string;
  session: WebCanvasSession;
  issueBootstrap(): WebCanvasBootstrap;
  ensureOpen(): WebCanvasOpenResult;
  close(): Promise<void>;
}

interface StartWebCanvasCompanionOptions {
  port?: number;
  canonicalOrigin: string;
  createToken?: () => string;
  projectService?: RuntimeProjectAuthority;
}

export async function startWebCanvasCompanion(
  options: StartWebCanvasCompanionOptions,
): Promise<WebCanvasCompanion> {
  const canonicalOrigin = parseCanonicalLocalOrigin(options.canonicalOrigin);
  const session = new WebCanvasSession({
    createToken: options.createToken,
    projectService: options.projectService,
  });
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
    canonicalOrigin,
    session,
    issueBootstrap: () => session.issueBootstrap(url, canonicalOrigin),
    ensureOpen: () => session.ensureOpen(url, canonicalOrigin),
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
  session: WebCanvasSession,
  canonicalOrigin: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!applyCors(request, response, canonicalOrigin)) {
    throw new CanvasAgentError('ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
  }
  const url = new URL(request.url ?? '/', canonicalOrigin);
  if (request.method === 'OPTIONS') {
    const requestedMethod = request.headers['access-control-request-method'];
    if (requestedMethod && requestedMethod !== 'GET' && requestedMethod !== 'POST') {
      throw new CanvasAgentError('METHOD_NOT_ALLOWED', 'Only GET and POST are supported.');
    }
    response.writeHead(204).end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/events') {
    session.openEvents(
      readBearerToken(request),
      readSessionId(url.searchParams.get('sessionId')),
      response,
    );
    return;
  }
  if (request.method !== 'POST') {
    throw new CanvasAgentError('METHOD_NOT_ALLOWED', 'Only GET events and POST commands are supported.');
  }

  const body = readRecord(await readJson(request));
  const sessionId = readSessionId(body.sessionId);
  const token = readBearerToken(request);
  if (url.pathname === '/v1/connect') {
    rejectUnknownFields(body, ['sessionId', 'protocol', 'capabilities']);
    session.connect(token, parseWebCanvasHello({
      protocol: body.protocol,
      capabilities: body.capabilities,
    }), sessionId);
  } else if (url.pathname === '/v1/state') {
    const { sessionId: _sessionId, ...snapshot } = body;
    session.publish(token, snapshot, sessionId);
  } else if (url.pathname === '/v1/result') {
    rejectUnknownFields(body, ['sessionId', 'proposalId', 'status', 'result', 'error']);
    session.resolveProposal(
      token,
      sessionId,
      readRequiredString(body.proposalId, 'proposalId'),
      readTerminalStatus(body.status),
      body.result,
      readOptionalString(body.error, 'error'),
    );
  } else if (url.pathname === '/v1/action-result') {
    rejectUnknownFields(body, ['sessionId', 'actionId', 'status', 'result', 'error']);
    session.resolveAction(
      token,
      sessionId,
      readRequiredString(body.actionId, 'actionId'),
      readTerminalStatus(body.status),
      body.result,
      readOptionalString(body.error, 'error'),
    );
  } else if (url.pathname === '/v1/editor-ready') {
    rejectUnknownFields(body, ['sessionId']);
    session.enableCodexEditing(token, sessionId);
  } else if (url.pathname === '/v1/delegation') {
    rejectUnknownFields(body, ['sessionId', 'actionId']);
    const delegation = session.createDelegation(
      token,
      sessionId,
      readRequiredString(body.actionId, 'actionId'),
    );
    sendJson(response, 200, { delegation });
    return;
  } else if (url.pathname === '/v1/disconnect') {
    rejectUnknownFields(body, ['sessionId']);
    session.disconnect(token, sessionId);
  } else {
    throw new CanvasAgentError('NOT_FOUND', 'Route not found.');
  }
  sendJson(response, 200, { ok: true });
}

function applyCors(request: IncomingMessage, response: ServerResponse, canonicalOrigin: string): boolean {
  if (request.headers.origin !== canonicalOrigin) {
    return false;
  }
  response.setHeader('Access-Control-Allow-Origin', canonicalOrigin);
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
  response.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
  response.setHeader('Cache-Control', 'no-store');
  return true;
}

function parseCanonicalLocalOrigin(value: string): string {
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
    throw new CanvasAgentError(
      'INVALID_CANONICAL_ORIGIN',
      'The canonical Origin must be an explicit http://127.0.0.1:<port> URL.'
    );
  }
}

function readBearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    throw new CanvasAgentError('UNAUTHORIZED', 'The canvas bridge token is invalid.');
  }
  return authorization.slice('Bearer '.length);
}

function readSessionId(value: unknown): string {
  return readRequiredString(value, 'sessionId');
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CanvasAgentError('INVALID_ARGUMENTS', `${field} is required.`);
  }
  return value;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new CanvasAgentError('INVALID_ARGUMENTS', `${field} must be a string.`);
  }
  return value;
}

function readTerminalStatus(value: unknown): Exclude<CanvasProposalStatus, 'pending'> {
  if (value === 'applied' || value === 'stale' || value === 'failed') {
    return value;
  }
  throw new CanvasAgentError('INVALID_ARGUMENTS', 'The action result status is invalid.');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new CanvasAgentError('REQUEST_TOO_LARGE', 'The request body is too large.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new CanvasAgentError('INVALID_JSON', 'The request body is not valid JSON.');
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanvasAgentError('INVALID_ARGUMENTS', 'The request body must be an object.');
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new CanvasAgentError('INVALID_ARGUMENTS', 'The request body contains unsupported fields.');
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
  const resolved = error instanceof CanvasAgentError
    ? error
    : new CanvasAgentError('INVALID_ARGUMENTS', error instanceof Error ? error.message : String(error));
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
  sendJson(response, status, { ok: false, error: resolved.toPayload() });
}
