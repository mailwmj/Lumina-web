import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import { type CanvasAgentConfig } from '../config.js';
import {
  CanvasAgentError,
  canvasAgentToolSchemas,
  type CanvasProposalStatus,
  isCanvasAgentToolName,
} from '../canvas/protocol.js';
import { CanvasSession } from '../canvas/session.js';

const MAX_BODY_BYTES = 12 * 1024 * 1024;

export function startHttpServer(config: CanvasAgentConfig): http.Server {
  const session = new CanvasSession();
  const configuredUrl = new URL(config.url);
  const port = configuredUrl.port ? Number(configuredUrl.port) : 80;
  const server = http.createServer((request, response) => {
    void routeRequest(session, config, request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.error(`Lumina Canvas Agent: ${config.url}`);
  });
  return server;
}

async function routeRequest(
  session: CanvasSession,
  config: CanvasAgentConfig,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? '/', config.url);
  if (!applyCors(request, response, config)) {
    throw new CanvasAgentError('ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    const includeActiveProject = request.headers.authorization === `Bearer ${config.token}`;
    sendJson(response, 200, session.health(includeActiveProject));
    return;
  }
  requireAuthorization(request, config.token);

  if (request.method === 'GET' && url.pathname === '/events') {
    session.openEvents(url.searchParams.get('clientId') ?? '', response);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/canvas/state') {
    session.updateState(url.searchParams.get('clientId') ?? '', await readJson(request));
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/canvas/result') {
    const body = await readJson(request) as Record<string, unknown>;
    const proposalId = typeof body.proposalId === 'string' ? body.proposalId : '';
    const status = body.status;
    if (!isTerminalProposalStatus(status)) {
      throw new CanvasAgentError('INVALID_PROPOSAL_STATUS', 'The proposal result status is invalid.');
    }
    const proposal = session.resolveProposal(
      url.searchParams.get('clientId') ?? '',
      proposalId,
      status,
      body.result,
      typeof body.error === 'string' ? body.error : undefined
    );
    sendJson(response, 200, { ok: true, result: proposal });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/canvas/action-result') {
    const body = await readJson(request) as Record<string, unknown>;
    const actionId = typeof body.actionId === 'string' ? body.actionId : '';
    const status = body.status;
    if (!isTerminalProposalStatus(status)) {
      throw new CanvasAgentError('INVALID_ACTION_STATUS', 'The canvas action result status is invalid.');
    }
    const action = session.resolveAction(
      url.searchParams.get('clientId') ?? '',
      actionId,
      status,
      body.result,
      typeof body.error === 'string' ? body.error : undefined
    );
    sendJson(response, 200, { ok: true, result: action });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/tools') {
    const body = await readJson(request) as Record<string, unknown>;
    if (!isCanvasAgentToolName(body.name)) {
      throw new CanvasAgentError('UNKNOWN_TOOL', `Unknown canvas tool: ${String(body.name)}`);
    }
    const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input)
      ? body.input as Record<string, unknown>
      : {};
    const parsedInput = canvasAgentToolSchemas[body.name].safeParse(input);
    if (!parsedInput.success) {
      throw new CanvasAgentError(
        'INVALID_ARGUMENTS',
        'The canvas tool arguments are invalid.',
        parsedInput.error.issues
      );
    }
    sendJson(response, 200, {
      ok: true,
      result: await session.callTool(body.name, parsedInput.data),
    });
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Route not found.' },
  });
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  config: CanvasAgentConfig
): boolean {
  const origin = request.headers.origin;
  if (origin && !config.origins.includes(origin)) {
    return false;
  }
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Cache-Control', 'no-store');
  return true;
}

function requireAuthorization(request: IncomingMessage, token: string): void {
  if (request.headers.authorization !== `Bearer ${token}`) {
    throw new CanvasAgentError('UNAUTHORIZED', 'The Canvas Agent token is invalid.');
  }
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
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new CanvasAgentError('INVALID_JSON', 'The request body is not valid JSON.');
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
  if (response.headersSent) {
    response.end();
    return;
  }
  const resolved = error instanceof CanvasAgentError
    ? error
    : new CanvasAgentError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  const status = resolved.code === 'UNAUTHORIZED'
    ? 401
    : resolved.code === 'ORIGIN_NOT_ALLOWED'
      ? 403
      : resolved.code === 'NOT_FOUND'
        ? 404
        : 400;
  sendJson(response, status, { ok: false, error: resolved.toPayload() });
}

function isTerminalProposalStatus(value: unknown): value is Exclude<CanvasProposalStatus, 'pending'> {
  return value === 'applied'
    || value === 'stale'
    || value === 'failed';
}
