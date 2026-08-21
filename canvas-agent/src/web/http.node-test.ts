import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEB_CANVAS_CAPABILITIES,
  WEB_CANVAS_PROTOCOL,
} from './protocol.js';
import { startWebCanvasCompanion } from './http.js';

const CANONICAL_ORIGIN = 'http://127.0.0.1:49123';

function snapshot(writeAccess = false) {
  return {
    protocolVersion: 2,
    projectId: 'project-1',
    projectName: 'Current project',
    revision: 'revision-1',
    nodes: [{ id: 'node-1', type: 'textAnnotationNode' }],
    edges: [],
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedImagePreviews: [],
    capabilities: { nodeTypes: [], operations: [], actions: [] },
    writeAccess,
  };
}

test('accepts a session-bound browser state over exact-Origin loopback HTTP', async () => {
  const companion = await startWebCanvasCompanion({
    canonicalOrigin: CANONICAL_ORIGIN,
    createToken: () => 'token',
  });
  const bootstrap = companion.issueBootstrap();
  const headers = {
    Origin: CANONICAL_ORIGIN,
    Authorization: `Bearer ${bootstrap.token}`,
    'Content-Type': 'application/json',
  };
  const eventsController = new AbortController();
  try {
    const preflight = await fetch(`${companion.url}/v1/events`, {
      method: 'OPTIONS',
      headers: {
        Origin: CANONICAL_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), CANONICAL_ORIGIN);
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

    const connected = await fetch(`${companion.url}/v1/connect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: bootstrap.sessionId,
        protocol: WEB_CANVAS_PROTOCOL,
        capabilities: WEB_CANVAS_CAPABILITIES,
      }),
    });
    assert.equal(connected.status, 200);

    const events = await fetch(`${companion.url}/v1/events?sessionId=${bootstrap.sessionId}`, {
      headers: { Origin: CANONICAL_ORIGIN, Authorization: `Bearer ${bootstrap.token}` },
      signal: eventsController.signal,
    });
    assert.equal(events.status, 200);

    const published = await fetch(`${companion.url}/v1/state`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...snapshot(), sessionId: bootstrap.sessionId }),
    });
    assert.equal(published.status, 200);
    await assert.rejects(
      companion.session.callTool('canvas_propose_changes', {
        projectId: 'project-1',
        baseRevision: 'revision-1',
        summary: 'Move the annotation',
        operations: [{
          type: 'move_node',
          nodeId: 'node-1',
          position: { x: 80, y: 40 },
        }],
      }),
      { code: 'PROJECT_WRITE_NOT_AUTHORIZED' },
    );
  } finally {
    eventsController.abort();
    await companion.close();
  }
});
