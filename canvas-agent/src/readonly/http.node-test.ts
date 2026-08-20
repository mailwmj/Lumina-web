import assert from 'node:assert/strict';
import test from 'node:test';

import {
  READONLY_CANVAS_CAPABILITIES,
  READONLY_CANVAS_PROTOCOL,
  type ReadonlyCanvasSnapshot,
} from './protocol.js';
import { CANONICAL_LUMINA_ORIGIN, startReadonlyCanvasCompanion } from './http.js';

function snapshot(): ReadonlyCanvasSnapshot {
  return {
    protocol: READONLY_CANVAS_PROTOCOL,
    capabilities: READONLY_CANVAS_CAPABILITIES,
    state: {
      project: { id: 'project-1', name: 'Current project', revision: 'r3' },
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    selection: { nodeIds: [] },
  };
}

test('binds only loopback and enforces Origin, PNA, token, method, and request-size boundaries', async () => {
  const companion = await startReadonlyCanvasCompanion({ port: 0, createToken: () => 'token' });
  const bootstrap = companion.issueBootstrap();
  try {
    assert.match(companion.url, /^http:\/\/127\.0\.0\.1:/);

    const preflight = await fetch(`${companion.url}/v1/connect`, {
      method: 'OPTIONS',
      headers: {
        Origin: CANONICAL_LUMINA_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(preflight.headers.get('access-control-allow-origin'), CANONICAL_LUMINA_ORIGIN);

    const forbiddenOrigin = await fetch(`${companion.url}/v1/connect`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(forbiddenOrigin.status, 403);

    const sse = await fetch(`${companion.url}/events`, {
      headers: { Origin: CANONICAL_LUMINA_ORIGIN, Accept: 'text/event-stream' },
    });
    assert.equal(sse.status, 405);

    const unauthorized = await fetch(`${companion.url}/v1/connect`, {
      method: 'POST',
      headers: { Origin: CANONICAL_LUMINA_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: bootstrap.sessionId,
        protocol: READONLY_CANVAS_PROTOCOL,
        capabilities: READONLY_CANVAS_CAPABILITIES,
      }),
    });
    assert.equal(unauthorized.status, 401);

    const unsupportedConnectField = await fetch(`${companion.url}/v1/connect`, {
      method: 'POST',
      headers: {
        Origin: CANONICAL_LUMINA_ORIGIN,
        Authorization: `Bearer ${bootstrap.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: bootstrap.sessionId,
        protocol: READONLY_CANVAS_PROTOCOL,
        capabilities: READONLY_CANVAS_CAPABILITIES,
        unsupported: true,
      }),
    });
    assert.equal(unsupportedConnectField.status, 400);

    const tooLarge = await fetch(`${companion.url}/v1/connect`, {
      method: 'POST',
      headers: {
        Origin: CANONICAL_LUMINA_ORIGIN,
        Authorization: `Bearer ${bootstrap.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ padding: 'x'.repeat(300_000) }),
    });
    assert.equal(tooLarge.status, 413);

    const rejectedPost = await fetch(`${companion.url}/api/tools`, {
      method: 'POST',
      headers: {
        Origin: CANONICAL_LUMINA_ORIGIN,
        Authorization: `Bearer ${bootstrap.token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(rejectedPost.status, 404);
  } finally {
    await companion.close();
  }
});

test('accepts a negotiated browser snapshot and rejects a disconnected session', async () => {
  const companion = await startReadonlyCanvasCompanion({ port: 0, createToken: () => 'token' });
  const bootstrap = companion.issueBootstrap();
  try {
    const headers = {
      Origin: CANONICAL_LUMINA_ORIGIN,
      Authorization: `Bearer ${bootstrap.token}`,
      'Content-Type': 'application/json',
    };
    const connected = await fetch(`${companion.url}/v1/connect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ protocol: READONLY_CANVAS_PROTOCOL, capabilities: READONLY_CANVAS_CAPABILITIES }),
    });
    assert.equal(connected.status, 200);

    const published = await fetch(`${companion.url}/v1/state`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...snapshot(), sessionId: bootstrap.sessionId }),
    });
    assert.equal(published.status, 200);
    assert.deepEqual(companion.session.readState(), snapshot().state);

    const wrongToken = await fetch(`${companion.url}/v1/state`, {
      method: 'POST',
      headers: {
        ...headers,
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ ...snapshot(), sessionId: bootstrap.sessionId }),
    });
    assert.equal(wrongToken.status, 401);

    const disconnected = await fetch(`${companion.url}/v1/disconnect`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(disconnected.status, 200);
    assert.throws(() => companion.session.readState(), { code: 'NO_ACTIVE_CANVAS' });
  } finally {
    await companion.close();
  }
});
