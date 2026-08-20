import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import type { CanvasAgentConfig } from '../config.js';
import { CANVAS_AGENT_PROTOCOL_VERSION, type CanvasSnapshot } from '../canvas/protocol.js';
import { startHttpServer } from './http.js';

const TOKEN = 'test-token-that-is-long-enough-for-the-local-bridge';

function snapshot(revision: string): CanvasSnapshot {
  return {
    protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION,
    projectId: 'project-1',
    projectName: 'Project',
    revision,
    nodes: [{ id: 'node-1', type: 'textAnnotationNode' }],
    edges: [],
    selectedNodeIds: ['node-1'],
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedImagePreviews: [],
    capabilities: { nodeTypes: [] },
  };
}

test('serves an authenticated live canvas and stale proposal lifecycle over loopback HTTP', async () => {
  const config: CanvasAgentConfig = {
    url: 'http://127.0.0.1:0',
    token: TOKEN,
    origins: [],
  };
  const server = startHttpServer(config);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const eventsController = new AbortController();

  try {
    const unauthorized = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'canvas_get_state', input: {} }),
    });
    assert.equal(unauthorized.status, 401);

    const invalidArguments = await fetch(`${baseUrl}/api/tools`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'canvas_propose_changes',
        input: { summary: 'missing project and revision' },
      }),
    });
    assert.equal(invalidArguments.status, 400);
    assert.equal(
      ((await invalidArguments.json()) as { error?: { code?: string } }).error?.code,
      'INVALID_ARGUMENTS'
    );

    const events = await fetch(`${baseUrl}/events?clientId=client-1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: eventsController.signal,
    });
    assert.equal(events.status, 200);
    assert.ok(events.body);
    const eventReader = events.body.getReader();

    await post(baseUrl, '/canvas/state?clientId=client-1', snapshot('revision-1'));
    const state = await callTool(baseUrl, 'canvas_get_state', {});
    assert.equal((state as CanvasSnapshot).revision, 'revision-1');

    const publicHealth = await fetch(`${baseUrl}/health`).then((response) => response.json()) as {
      readiness: string;
      activeProject?: unknown;
    };
    assert.equal(publicHealth.readiness, 'ready');
    assert.equal(publicHealth.activeProject, undefined);
    const authenticatedHealth = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((response) => response.json()) as {
      activeProject?: { id: string; name: string };
    };
    assert.deepEqual(authenticatedHealth.activeProject, {
      id: 'project-1',
      name: 'Project',
    });

    const proposal = await callTool(baseUrl, 'canvas_propose_changes', {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Move a node',
      operations: [{
        type: 'move_node',
        nodeId: 'node-1',
        position: { x: 120, y: 80 },
      }],
    }) as { proposalId: string; status: string };
    assert.equal(proposal.status, 'pending');

    await post(baseUrl, '/canvas/state?clientId=client-1', snapshot('revision-2'));
    const status = await callTool(baseUrl, 'canvas_get_change_status', {
      proposalId: proposal.proposalId,
    }) as { status: string };
    assert.equal(status.status, 'stale');

    const actionCall = callTool(baseUrl, 'canvas_get_node_images', {
      projectId: 'project-1',
      nodeIds: ['node-1'],
      maxDimension: 768,
    });
    const actionEvent = await readSseEvent(eventReader, 'action_request');
    assert.equal((actionEvent.request as { type?: string })?.type, 'get_node_images');
    await post(baseUrl, '/canvas/action-result?clientId=client-1', {
      actionId: actionEvent.actionId,
      status: 'applied',
      result: { projectId: 'project-1', images: [{ nodeId: 'node-1', status: 'empty' }] },
    });
    const actionResult = await actionCall as { status: string; result?: unknown };
    assert.equal(actionResult.status, 'applied');
    assert.deepEqual(actionResult.result, {
      projectId: 'project-1',
      images: [{ nodeId: 'node-1', status: 'empty' }],
    });
  } finally {
    eventsController.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function callTool(baseUrl: string, name: string, input: unknown): Promise<unknown> {
  const response = await post(baseUrl, '/api/tools', { name, input });
  const body = await response.json() as { ok: boolean; result: unknown };
  assert.equal(body.ok, true);
  return body.result;
}

async function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.ok, true);
  return response;
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expectedType: string
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    assert.equal(done, false, `event stream ended before ${expectedType}`);
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const typeLine = block.split('\n').find((line) => line.startsWith('event: '));
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
      if (typeLine?.slice('event: '.length) === expectedType && dataLine) {
        return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
      }
      separatorIndex = buffer.indexOf('\n\n');
    }
  }
}
