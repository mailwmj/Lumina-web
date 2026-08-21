import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { ServerResponse } from 'node:http';

import {
  WEB_CANVAS_CAPABILITIES,
  WEB_CANVAS_PROTOCOL,
} from './protocol.js';
import { WebCanvasSession } from './session.js';

class TestResponse extends EventEmitter {
  readonly chunks: string[] = [];

  writeHead(): this {
    return this;
  }

  write(value: string): boolean {
    this.chunks.push(value);
    return true;
  }

  end(): this {
    this.emit('close');
    return this;
  }
}

function snapshot(writeAccess: boolean, revision = 'revision-1') {
  return {
    protocolVersion: 2,
    projectId: 'project-1',
    projectName: 'Current project',
    revision,
    nodes: [{ id: 'node-1', type: 'textAnnotationNode' }],
    edges: [],
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedImagePreviews: [],
    capabilities: { nodeTypes: [], operations: [], actions: [] },
    writeAccess,
  };
}

test('keeps a session-local project read-only until the browser explicitly enables bounded writes', async () => {
  const session = new WebCanvasSession({
    createToken: () => 'token',
    createSessionId: () => 'session-1',
  });
  const bootstrap = session.issueBootstrap(
    'http://127.0.0.1:49124',
    'http://127.0.0.1:49123',
  );
  session.connect(bootstrap.token, {
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  }, bootstrap.sessionId);
  session.openEvents(bootstrap.token, bootstrap.sessionId, new TestResponse() as unknown as ServerResponse);
  session.publish(bootstrap.token, snapshot(false), bootstrap.sessionId);

  try {
    await assert.rejects(
      session.callTool('canvas_propose_changes', {
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
    session.close();
  }
});

test('marks a pending write stale when canvas_open rotates its one-time token', async () => {
  const session = new WebCanvasSession({
    createToken: () => 'token',
    createSessionId: () => 'session-1',
  });
  const bootstrap = session.issueBootstrap(
    'http://127.0.0.1:49124',
    'http://127.0.0.1:49123',
  );
  session.connect(bootstrap.token, {
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  }, bootstrap.sessionId);
  session.openEvents(bootstrap.token, bootstrap.sessionId, new TestResponse() as unknown as ServerResponse);
  session.publish(bootstrap.token, snapshot(true), bootstrap.sessionId);

  try {
    const pending = session.callTool('canvas_propose_changes', {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Move the annotation',
      operations: [{
        type: 'move_node',
        nodeId: 'node-1',
        position: { x: 80, y: 40 },
      }],
    });
    session.issueBootstrap('http://127.0.0.1:49124', 'http://127.0.0.1:49123');

    const result = await pending as { status: string; error?: string };
    assert.equal(result.status, 'stale');
    assert.equal(result.error, 'session_rotated');
  } finally {
    session.close();
  }
});

test('expires the browser session at its bootstrap deadline', async () => {
  let now = 1_000;
  const session = new WebCanvasSession({
    now: () => now,
    createToken: () => 'token',
    createSessionId: () => 'session-1',
  });
  const bootstrap = session.issueBootstrap(
    'http://127.0.0.1:49124',
    'http://127.0.0.1:49123',
  );
  session.connect(bootstrap.token, {
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  }, bootstrap.sessionId);
  session.openEvents(bootstrap.token, bootstrap.sessionId, new TestResponse() as unknown as ServerResponse);
  session.publish(bootstrap.token, snapshot(true), bootstrap.sessionId);
  now = bootstrap.expiresAt;

  await assert.rejects(
    session.callTool('canvas_get_state', {}),
    { code: 'SESSION_EXPIRED' },
  );
});
