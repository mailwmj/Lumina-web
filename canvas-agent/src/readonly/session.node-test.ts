import assert from 'node:assert/strict';
import test from 'node:test';

import {
  READONLY_CANVAS_CAPABILITIES,
  READONLY_CANVAS_PROTOCOL,
  type ReadonlyCanvasSnapshot,
} from './protocol.js';
import { ReadonlyCanvasSession } from './session.js';

function snapshot(
  projectId = 'project-1',
  revision = 'r3',
): ReadonlyCanvasSnapshot {
  return {
    protocol: READONLY_CANVAS_PROTOCOL,
    capabilities: READONLY_CANVAS_CAPABILITIES,
    state: {
      project: { id: projectId, name: 'Current project', revision },
      nodes: [{ id: 'node-1', type: 'imageEditNode', position: { x: 12, y: 16 }, data: { prompt: 'A lamp' } }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    selection: { nodeIds: ['node-1'] },
  };
}

test('rotates bootstrap tokens and only permits the newest, non-expired browser session', () => {
  let now = 1_000;
  const session = new ReadonlyCanvasSession({
    now: () => now,
    createToken: (() => ['first-token', 'second-token'][Math.floor((now - 1_000) / 1_000)] ?? 'third-token'),
  });
  const first = session.issueBootstrap('http://127.0.0.1:17372');
  now += 1_000;
  const second = session.issueBootstrap('http://127.0.0.1:17372');

  assert.throws(() => session.connect(first.token, {
    protocol: READONLY_CANVAS_PROTOCOL,
    capabilities: READONLY_CANVAS_CAPABILITIES,
  }), { code: 'UNAUTHORIZED' });
  assert.deepEqual(session.connect(second.token, {
    protocol: READONLY_CANVAS_PROTOCOL,
    capabilities: READONLY_CANVAS_CAPABILITIES,
  }).capabilities, READONLY_CANVAS_CAPABILITIES);
  assert.throws(() => session.connect(second.token, {
    protocol: READONLY_CANVAS_PROTOCOL,
    capabilities: READONLY_CANVAS_CAPABILITIES,
  }), { code: 'UNAUTHORIZED' });

  now = second.expiresAt + 1;
  assert.throws(() => session.readState(), { code: 'SESSION_EXPIRED' });
});

test('keeps a single active project, exposes only negotiated reads, and drops state on disconnect', () => {
  const session = new ReadonlyCanvasSession({ createToken: () => 'token' });
  const bootstrap = session.issueBootstrap('http://127.0.0.1:17372');
  session.connect(bootstrap.token, {
    protocol: READONLY_CANVAS_PROTOCOL,
    capabilities: READONLY_CANVAS_CAPABILITIES,
  });
  session.publish(bootstrap.token, snapshot());

  assert.deepEqual(session.readState(), snapshot().state);
  assert.deepEqual(session.readSelection(), snapshot().selection);
  assert.deepEqual(session.readCapabilities(), READONLY_CANVAS_CAPABILITIES);
  assert.throws(() => session.publish(bootstrap.token, snapshot('project-2')), { code: 'ACTIVE_PROJECT_MISMATCH' });

  session.disconnect(bootstrap.token);
  assert.throws(() => session.readState(), { code: 'NO_ACTIVE_CANVAS' });
});

test('rejects invalid protocol payloads before state reaches MCP', () => {
  const session = new ReadonlyCanvasSession({ createToken: () => 'token' });
  const bootstrap = session.issueBootstrap('http://127.0.0.1:17372');
  session.connect(bootstrap.token, {
    protocol: READONLY_CANVAS_PROTOCOL,
    capabilities: READONLY_CANVAS_CAPABILITIES,
  });

  const invalid = snapshot() as ReadonlyCanvasSnapshot & { secret: string };
  invalid.secret = 'not-allowed';
  assert.throws(() => session.publish(bootstrap.token, invalid), { code: 'INVALID_SNAPSHOT' });
});
