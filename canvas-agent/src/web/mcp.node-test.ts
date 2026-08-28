import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WEB_CANVAS_PROTOCOL } from './protocol.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('web MCP launches a local canvas host with the full restricted canvas tool surface', { timeout: 8_000 }, async () => {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-web-mcp-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Lumina Canvas</title>');
  const child = spawn(process.execPath, [
    path.join(PACKAGE_ROOT, 'dist', 'index.js'),
    'web-mcp',
    '--web-root',
    webRoot,
  ], {
    cwd: PACKAGE_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const responses = createResponseReader(child.stdout);
  try {
    send(child.stdin, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'lumina-readonly-test', version: '1.0.0' },
      },
    });
    const initialized = await responses.waitFor(1);
    assert.equal(initialized.error, undefined, stderr);
    const instructions = (initialized.result as { instructions?: string }).instructions ?? '';
    assert.match(instructions, /Codex's in-app browser/i);
    assert.match(instructions, /open the returned URL in Codex's in-app browser/i);
    assert.match(instructions, /do not open or fall back to connected Chrome/i);
    assert.doesNotMatch(instructions, /ask the user to connect Chrome/i);
    assert.match(instructions, /automatically enables bounded non-billing writes/i);
    assert.match(instructions, /remains read-only when another editor owns/i);
    assert.match(instructions, /canvas_list_projects/i);
    assert.match(instructions, /canvas_create_project/i);
    assert.match(instructions, /canvas_open_project/i);
    assert.match(instructions, /canvas_run_video_nodes/i);
    assert.match(instructions, /canvas_get_video_results/i);
    assert.match(instructions, /do not replay a write or generation request/i);
    send(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send(child.stdin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await responses.waitFor(2);
    assert.deepEqual(
      ((listed.result as { tools?: Array<{ name?: string }> }).tools ?? []).map((tool) => tool.name).sort(),
      [
        'canvas_create_project',
        'canvas_get_action_status',
        'canvas_get_capabilities',
        'canvas_get_change_status',
        'canvas_get_node_images',
        'canvas_get_selection',
        'canvas_get_state',
        'canvas_get_video_results',
        'canvas_import_images',
        'canvas_list_projects',
        'canvas_open',
        'canvas_open_project',
        'canvas_propose_changes',
        'canvas_run_nodes',
        'canvas_run_video_nodes',
        'canvas_wait_for_nodes',
      ],
    );

    send(child.stdin, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'canvas_open', arguments: {} },
    });
    const opened = await responses.waitFor(3);
    const text = ((opened.result as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text;
    assert.ok(text, stderr);
    const payload = JSON.parse(text) as {
      status?: string;
      canonicalOrigin?: string;
      url?: string;
      browserTarget?: string;
    };
    assert.equal(payload.status, 'awaiting_browser');
    assert.equal(payload.browserTarget, 'codex-in-app-browser');
    const origin = new URL(payload.canonicalOrigin ?? '');
    assert.equal(origin.protocol, 'http:');
    assert.equal(origin.hostname, '127.0.0.1');
    assert.notEqual(origin.port, '');
    assert.notEqual(origin.port, '0');
    assert.match(payload.url ?? '', new RegExp(`^${escapeRegExp(origin.origin)}\\/#lumina-canvas=`));
    assert.equal((await fetch(`${origin.origin}/`)).status, 200);

    send(child.stdin, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'canvas_open', arguments: {} },
    });
    const reopened = await responses.waitFor(4);
    const reopenedText = ((reopened.result as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text;
    assert.ok(reopenedText, stderr);
    const reopenedPayload = JSON.parse(reopenedText) as { status?: string; url?: string; browserTarget?: string };
    assert.equal(reopenedPayload.status, 'awaiting_browser');
    assert.equal(reopenedPayload.url, payload.url);
    assert.equal(reopenedPayload.browserTarget, 'codex-in-app-browser');

    const bootstrap = JSON.parse(decodeURIComponent(
      new URL(payload.url ?? '').hash.slice('#lumina-canvas='.length),
    )) as { bridge?: string; endpoint: string; sessionId: string; token: string };
    assert.equal(bootstrap.bridge, 'web');
    const preflight = await fetch(`${bootstrap.endpoint}/v1/connect`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin.origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin.origin);
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

    const connected = await fetch(`${bootstrap.endpoint}/v1/connect`, {
      method: 'POST',
      headers: {
        Origin: origin.origin,
        Authorization: `Bearer ${bootstrap.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: bootstrap.sessionId,
        protocol: WEB_CANVAS_PROTOCOL,
        capabilities: [
          'canvas.read.state',
          'canvas.read.selection',
          'canvas.read.capabilities',
          'canvas.read.change-status',
          'canvas.write.changes',
          'canvas.write.import-images',
          'canvas.run.images',
          'canvas.read.node_images',
          'canvas.wait.nodes',
          'canvas.read.action-status',
        ],
      }),
    });
    assert.equal(connected.status, 200);

    send(child.stdin, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'canvas_open', arguments: {} },
    });
    const connectedOpen = await responses.waitFor(5);
    const connectedText = ((connectedOpen.result as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text;
    assert.ok(connectedText, stderr);
    assert.deepEqual(JSON.parse(connectedText), {
      status: 'awaiting_project',
      canonicalOrigin: origin.origin,
    });
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    fs.rmSync(webRoot, { recursive: true, force: true });
  }
});

test('web MCP refuses caller-supplied canonical Origins', { timeout: 8_000 }, async () => {
  const child = spawn(process.execPath, [
    path.join(PACKAGE_ROOT, 'dist', 'index.js'),
    'web-mcp',
    '--canonical-origin',
    'http://127.0.0.1:49123',
  ], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));

  assert.notEqual(code, 0);
  assert.match(stderr, /always creates its own session-local canonical Origin/);
});

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

function send(stream: NodeJS.WritableStream, message: unknown): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

function createResponseReader(stream: NodeJS.ReadableStream) {
  let buffer = '';
  const responses = new Map<number, JsonRpcResponse>();
  const waiters = new Map<number, (value: JsonRpcResponse) => void>();
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const message = JSON.parse(line) as JsonRpcResponse;
        if (typeof message.id === 'number') {
          const waiter = waiters.get(message.id);
          if (waiter) {
            waiters.delete(message.id);
            waiter(message);
          } else {
            responses.set(message.id, message);
          }
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });
  return {
    waitFor(id: number): Promise<JsonRpcResponse> {
      const existing = responses.get(id);
      if (existing) {
        responses.delete(id);
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => waiters.set(id, resolve));
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
