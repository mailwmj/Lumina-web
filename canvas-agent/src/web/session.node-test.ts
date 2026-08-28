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

function snapshot(writeAccess: boolean, projectId = 'project-1', projectName = 'Current project') {
  return {
    protocolVersion: 3,
    projectId,
    projectName,
    nodes: [{ id: 'node-1', type: 'textAnnotationNode' }],
    edges: [],
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedImagePreviews: [],
    capabilities: { nodeTypes: [], operations: [], actions: [] },
    writeAccess,
  };
}

test('lists projects before one is open and safely rebinds the same browser page after creation', async () => {
  const revocations: Array<{ sessionId: string; projectId: string }> = [];
  const session = new WebCanvasSession({
    createToken: () => 'token',
    createSessionId: () => 'session-1',
    projectService: {
      renewCodexLease(_sessionId, projectId) {
        return { mode: 'codex', projectId, expiresAt: Date.now() + 30_000 };
      },
      createCodexDelegation(_sessionId, _projectId, actionId) {
        return { token: 'delegation-token', actionId, expiresAt: Date.now() + 10_000 };
      },
      revokeCodexLease(sessionId, projectId) {
        revocations.push({ sessionId, projectId });
        return true;
      },
    },
  });
  const bootstrap = session.issueBootstrap(
    'http://127.0.0.1:49124',
    'http://127.0.0.1:49123',
  );
  session.connect(bootstrap.token, {
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  }, bootstrap.sessionId);
  const response = new TestResponse();
  session.openEvents(bootstrap.token, bootstrap.sessionId, response as unknown as ServerResponse);

  const pendingList = session.callTool('canvas_list_projects', {});
  const listActionId = readLastActionId(response);
  session.resolveAction(bootstrap.token, bootstrap.sessionId, listActionId, 'applied', {
    projects: [{ id: 'project-1', name: 'Current project', nodeCount: 1 }],
  });
  assert.equal((await pendingList as { status: string }).status, 'applied');

  session.publish(bootstrap.token, snapshot(true), bootstrap.sessionId);
  session.enableCodexEditing(bootstrap.token, bootstrap.sessionId);
  const pendingCreate = session.callTool('canvas_create_project', { name: 'Agent project' });
  const createActionId = readLastActionId(response);
  session.resolveAction(bootstrap.token, bootstrap.sessionId, createActionId, 'applied', {
    project: { id: 'project-2', name: 'Agent project', nodeCount: 0 },
  });
  session.publish(
    bootstrap.token,
    snapshot(false, 'project-2', 'Agent project'),
    bootstrap.sessionId,
  );

  assert.equal((await pendingCreate as { status: string }).status, 'applied');
  assert.equal(
    (await session.callTool('canvas_get_state', {}) as { projectId: string }).projectId,
    'project-2',
  );
  assert.deepEqual(revocations, [{ sessionId: 'session-1', projectId: 'project-1' }]);
  await assert.rejects(
    session.callTool('canvas_propose_changes', {
      projectId: 'project-2',
      summary: 'Create the first node',
      operations: [{ type: 'create_node', clientId: 'node', nodeType: 'textAnnotationNode' }],
    }),
    { code: 'PROJECT_WRITE_NOT_AUTHORIZED' },
  );
  session.close();
});

test('accepts only the created project reported by an applied rebind action', async () => {
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
  const response = new TestResponse();
  session.openEvents(bootstrap.token, bootstrap.sessionId, response as unknown as ServerResponse);
  session.publish(bootstrap.token, snapshot(false), bootstrap.sessionId);

  try {
    const pendingCreate = session.callTool('canvas_create_project', { name: 'Agent project' });
    const actionId = readLastActionId(response);
    session.resolveAction(bootstrap.token, bootstrap.sessionId, actionId, 'applied', {
      project: { id: 'project-2', name: 'Agent project', nodeCount: 0 },
    });
    await pendingCreate;

    assert.throws(() => session.publish(
      bootstrap.token,
      snapshot(false, 'project-3', 'Unexpected project'),
      bootstrap.sessionId,
    ), { code: 'ACTIVE_PROJECT_MISMATCH' });
  } finally {
    session.close();
  }
});

test('expires an applied project rebind when its snapshot never arrives', async () => {
  const scheduled: Array<() => void> = [];
  const session = new WebCanvasSession({
    createToken: () => 'token',
    createSessionId: () => 'session-1',
    setTimeout: ((callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length;
    }) as unknown as typeof globalThis.setTimeout,
    clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
  });
  const bootstrap = session.issueBootstrap(
    'http://127.0.0.1:49124',
    'http://127.0.0.1:49123',
  );
  session.connect(bootstrap.token, {
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  }, bootstrap.sessionId);
  const response = new TestResponse();
  session.openEvents(bootstrap.token, bootstrap.sessionId, response as unknown as ServerResponse);
  session.publish(bootstrap.token, snapshot(false), bootstrap.sessionId);

  try {
    const pendingCreate = session.callTool('canvas_create_project', { name: 'Agent project' });
    const actionId = readLastActionId(response);
    session.resolveAction(bootstrap.token, bootstrap.sessionId, actionId, 'applied', {
      project: { id: 'project-2', name: 'Agent project', nodeCount: 0 },
    });
    await pendingCreate;
    assert.equal(scheduled.length, 1);
    scheduled[0]?.();

    assert.throws(() => session.publish(
      bootstrap.token,
      snapshot(false, 'project-2', 'Agent project'),
      bootstrap.sessionId,
    ), { code: 'ACTIVE_PROJECT_MISMATCH' });
  } finally {
    session.close();
  }
});

test('keeps two Web canvas sessions isolated on different projects', async () => {
  const first = new WebCanvasSession({
    createToken: () => 'token-1',
    createSessionId: () => 'session-1',
  });
  const second = new WebCanvasSession({
    createToken: () => 'token-2',
    createSessionId: () => 'session-2',
  });
  const firstBootstrap = first.issueBootstrap('http://127.0.0.1:49124', 'http://127.0.0.1:49123');
  const secondBootstrap = second.issueBootstrap('http://127.0.0.1:49126', 'http://127.0.0.1:49125');
  first.connect(firstBootstrap.token, {
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  }, firstBootstrap.sessionId);
  second.connect(secondBootstrap.token, {
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  }, secondBootstrap.sessionId);
  first.openEvents(
    firstBootstrap.token,
    firstBootstrap.sessionId,
    new TestResponse() as unknown as ServerResponse,
  );
  second.openEvents(
    secondBootstrap.token,
    secondBootstrap.sessionId,
    new TestResponse() as unknown as ServerResponse,
  );
  first.publish(firstBootstrap.token, snapshot(false, 'project-1'), firstBootstrap.sessionId);
  second.publish(secondBootstrap.token, snapshot(false, 'project-2'), secondBootstrap.sessionId);

  try {
    assert.equal(
      (await first.callTool('canvas_get_state', {}) as { projectId: string }).projectId,
      'project-1',
    );
    assert.equal(
      (await second.callTool('canvas_get_state', {}) as { projectId: string }).projectId,
      'project-2',
    );
  } finally {
    first.close();
    second.close();
  }
});

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

test('keeps an authenticated browser session live after the bootstrap deadline', async () => {
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

  try {
    const state = await session.callTool('canvas_get_state', {}) as { projectId: string };
    assert.equal(state.projectId, 'project-1');
  } finally {
    session.close();
  }
});

test('rejects a duplicate connection without ending the authenticated session', async () => {
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

  try {
    assert.throws(() => session.connect(bootstrap.token, {
      protocol: WEB_CANVAS_PROTOCOL,
      capabilities: WEB_CANVAS_CAPABILITIES,
    }, bootstrap.sessionId), { code: 'UNAUTHORIZED' });
    const state = await session.callTool('canvas_get_state', {}) as { projectId: string };
    assert.equal(state.projectId, 'project-1');
  } finally {
    session.close();
  }
});

test('rejects a browser connection after its unconsumed bootstrap expires', () => {
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
  now = bootstrap.expiresAt;

  assert.throws(() => session.connect(bootstrap.token, {
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  }, bootstrap.sessionId), { code: 'SESSION_EXPIRED' });
});

test('keeps canvas_open idempotent after the browser connects', async () => {
  let sequence = 0;
  const session = new WebCanvasSession({
    createToken: () => `token-${++sequence}`,
    createSessionId: () => `session-${sequence}`,
  });
  try {
    const opened = session.ensureOpen(
      'http://127.0.0.1:49124',
      'http://127.0.0.1:49123',
    );
    assert.equal(opened.status, 'awaiting_browser');
    if (opened.status !== 'awaiting_browser') {
      throw new Error('Expected a bootstrap for the browser.');
    }
    const bootstrap = opened.bootstrap;
    session.connect(bootstrap.token, {
      protocol: WEB_CANVAS_PROTOCOL,
      capabilities: WEB_CANVAS_CAPABILITIES,
    }, bootstrap.sessionId);
    session.openEvents(bootstrap.token, bootstrap.sessionId, new TestResponse() as unknown as ServerResponse);
    session.publish(bootstrap.token, snapshot(true), bootstrap.sessionId);

    const reopened = session.ensureOpen(
      'http://127.0.0.1:49124',
      'http://127.0.0.1:49123',
    );
    assert.deepEqual(reopened, {
      status: 'connected',
      canonicalOrigin: 'http://127.0.0.1:49123',
    });
    session.publish(bootstrap.token, snapshot(true), bootstrap.sessionId);
  } finally {
    session.close();
  }
});

test('requires a fresh bootstrap after the browser event stream closes', () => {
  let sequence = 0;
  const session = new WebCanvasSession({
    createToken: () => `token-${++sequence}`,
    createSessionId: () => `session-${sequence}`,
  });
  const bootstrap = session.issueBootstrap(
    'http://127.0.0.1:49124',
    'http://127.0.0.1:49123',
  );
  session.connect(bootstrap.token, {
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  }, bootstrap.sessionId);
  const response = new TestResponse();
  session.openEvents(bootstrap.token, bootstrap.sessionId, response as unknown as ServerResponse);
  response.end();

  const reopened = session.ensureOpen(
    'http://127.0.0.1:49124',
    'http://127.0.0.1:49123',
  );
  assert.equal(reopened.status, 'awaiting_browser');
  if (reopened.status === 'awaiting_browser') {
    assert.notEqual(reopened.bootstrap.token, bootstrap.token);
  }
});

test('issues project-bound Runtime delegations and revokes Codex editing when the bridge closes', () => {
  const renewals: Array<{ sessionId: string; projectId: string }> = [];
  const delegations: Array<{ sessionId: string; projectId: string; actionId: string }> = [];
  const revocations: Array<{ sessionId: string; projectId: string }> = [];
  const session = new WebCanvasSession({
    createToken: () => 'token',
    createSessionId: () => 'session-1',
    projectService: {
      renewCodexLease(sessionId, projectId) {
        renewals.push({ sessionId, projectId });
        return { mode: 'codex', projectId, expiresAt: Date.now() + 30_000 };
      },
      createCodexDelegation(sessionId, projectId, actionId) {
        delegations.push({ sessionId, projectId, actionId });
        return { token: 'delegation-token', actionId, expiresAt: Date.now() + 10_000 };
      },
      revokeCodexLease(sessionId, projectId) {
        revocations.push({ sessionId, projectId });
        return true;
      },
    },
  });
  const bootstrap = session.issueBootstrap(
    'http://127.0.0.1:49124',
    'http://127.0.0.1:49123',
  );
  session.connect(bootstrap.token, {
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  }, bootstrap.sessionId);
  const response = new TestResponse();
  session.openEvents(bootstrap.token, bootstrap.sessionId, response as unknown as ServerResponse);
  session.publish(bootstrap.token, snapshot(true), bootstrap.sessionId);

  assert.throws(
    () => session.createDelegation(bootstrap.token, bootstrap.sessionId, 'action-before-grant'),
    { code: 'PROJECT_WRITE_NOT_AUTHORIZED' },
  );
  session.enableCodexEditing(bootstrap.token, bootstrap.sessionId);
  const delegation = session.createDelegation(
    bootstrap.token,
    bootstrap.sessionId,
    'action-1',
  );
  assert.equal(delegation.token, 'delegation-token');
  assert.equal(delegation.actionId, 'action-1');
  assert.equal(typeof delegation.expiresAt, 'number');
  assert.deepEqual(renewals, [
    { sessionId: 'session-1', projectId: 'project-1' },
    { sessionId: 'session-1', projectId: 'project-1' },
  ]);
  assert.deepEqual(delegations, [{ sessionId: 'session-1', projectId: 'project-1', actionId: 'action-1' }]);

  response.end();
  assert.deepEqual(revocations, [{ sessionId: 'session-1', projectId: 'project-1' }]);
});

test('closes the bridge and revokes Codex editing when lease renewal fails', async () => {
  const scheduled: Array<() => void> = [];
  const revocations: string[] = [];
  let renewalCount = 0;
  const session = new WebCanvasSession({
    createToken: () => 'token',
    createSessionId: () => 'session-1',
    projectService: {
      renewCodexLease() {
        renewalCount += 1;
        if (renewalCount > 1) {
          throw new Error('lease lost');
        }
        return { mode: 'codex', expiresAt: Date.now() + 30_000 };
      },
      createCodexDelegation(_sessionId, actionId) {
        return { token: 'delegation-token', actionId, expiresAt: Date.now() + 10_000 };
      },
      revokeCodexLease(sessionId) {
        revocations.push(sessionId);
        return true;
      },
    },
    setTimeout: ((callback: () => void) => {
      scheduled.push(callback);
      return 1;
    }) as unknown as typeof globalThis.setTimeout,
    clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
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
  session.enableCodexEditing(bootstrap.token, bootstrap.sessionId);

  assert.equal(scheduled.length, 1);
  scheduled[0]?.();
  await assert.rejects(session.callTool('canvas_get_state', {}), { code: 'NO_ACTIVE_CANVAS' });
  assert.deepEqual(revocations, ['session-1']);
});

test('revokes Codex editing when an authorized action fails', async () => {
  const revocations: string[] = [];
  const session = new WebCanvasSession({
    createToken: () => 'token',
    createSessionId: () => 'session-1',
    projectService: {
      renewCodexLease() {
        return { mode: 'codex', expiresAt: Date.now() + 30_000 };
      },
      createCodexDelegation(_sessionId, actionId) {
        return { token: 'delegation-token', actionId, expiresAt: Date.now() + 10_000 };
      },
      revokeCodexLease(sessionId) {
        revocations.push(sessionId);
        return true;
      },
    },
  });
  const bootstrap = session.issueBootstrap(
    'http://127.0.0.1:49124',
    'http://127.0.0.1:49123',
  );
  session.connect(bootstrap.token, {
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  }, bootstrap.sessionId);
  const response = new TestResponse();
  session.openEvents(bootstrap.token, bootstrap.sessionId, response as unknown as ServerResponse);
  session.publish(bootstrap.token, snapshot(true), bootstrap.sessionId);
  session.enableCodexEditing(bootstrap.token, bootstrap.sessionId);

  const pending = session.callTool('canvas_run_nodes', {
    projectId: 'project-1',
    nodeIds: ['node-1'],
  });
  const actionId = readLastActionId(response);
  session.resolveAction(
    bootstrap.token,
    bootstrap.sessionId,
    actionId,
    'failed',
    undefined,
    'result_persistence_failed',
  );

  const result = await pending as { status: string; error?: string };
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'result_persistence_failed');
  assert.deepEqual(revocations, ['session-1']);
  await assert.rejects(session.callTool('canvas_get_state', {}), { code: 'NO_ACTIVE_CANVAS' });
});

function readLastActionId(response: TestResponse): string {
  const block = [...response.chunks].reverse().find((chunk) => chunk.includes('event: action_request'));
  assert.ok(block, 'expected an action_request event');
  const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, 'expected action_request data');
  const payload = JSON.parse(dataLine.slice('data: '.length)) as { actionId?: string };
  assert.ok(payload.actionId, 'expected actionId');
  return payload.actionId;
}
