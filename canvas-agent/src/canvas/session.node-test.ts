import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { ServerResponse } from 'node:http';

import { CANVAS_AGENT_PROTOCOL_VERSION, type CanvasSnapshot } from './protocol.js';
import { CanvasSession } from './session.js';

class TestResponse extends EventEmitter {
  chunks: string[] = [];

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

function snapshot(
  revision = 'revision-1',
  selectedImagePreviews: CanvasSnapshot['selectedImagePreviews'] = [],
  nodes: CanvasSnapshot['nodes'] = [{ id: 'node-1', type: 'textAnnotationNode' }]
): CanvasSnapshot {
  return {
    protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION,
    projectId: 'project-1',
    projectName: 'Project',
    revision,
    nodes,
    edges: [],
    selectedNodeIds: ['node-1'],
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedImagePreviews,
    capabilities: { nodeTypes: [] },
  };
}

test('returns a structured error when no active live canvas exists', async () => {
  const session = new CanvasSession();
  await assert.rejects(
    session.callTool('canvas_get_state', {}),
    (error: unknown) => Boolean(
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'NO_ACTIVE_CANVAS'
    )
  );
});

test('reports whether the live canvas is actually ready', () => {
  const session = new CanvasSession();
  assert.deepEqual(session.health(), {
    ok: true,
    protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION,
    hasActiveCanvas: false,
    readiness: 'waiting_for_canvas',
  });

  const response = new TestResponse();
  session.openEvents('client-1', response as unknown as ServerResponse);
  session.updateState('client-1', snapshot());

  const health = session.health(true);
  response.end();
  assert.deepEqual(health, {
    ok: true,
    protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION,
    hasActiveCanvas: true,
    readiness: 'ready',
    activeProject: { id: 'project-1', name: 'Project' },
  });
});

test('creates a pending proposal and marks it stale after a revision change', async () => {
  const session = new CanvasSession();
  const response = new TestResponse();
  session.openEvents('client-1', response as unknown as ServerResponse);
  session.updateState('client-1', snapshot());

  const created = await session.callTool('canvas_propose_changes', {
    projectId: 'project-1',
    baseRevision: 'revision-1',
    summary: 'Create an annotation',
    operations: [{
      type: 'create_node',
      clientId: 'draft-note',
      nodeType: 'textAnnotationNode',
      position: { x: 20, y: 30 },
      data: { content: 'Draft' },
    }],
  }) as { proposalId: string; status: string };

  assert.equal(created.status, 'pending');
  assert.match(response.chunks.join(''), /change_proposal/);

  session.updateState('client-1', snapshot('revision-2'));
  const status = await session.callTool('canvas_get_change_status', {
    proposalId: created.proposalId,
  }) as { status: string; error?: string };
  assert.equal(status.status, 'stale');
  assert.equal(status.error, 'canvas_changed');

  response.end();
});

test('records one applied change-set result for polling', async () => {
  const session = new CanvasSession();
  const response = new TestResponse();
  session.openEvents('client-1', response as unknown as ServerResponse);
  session.updateState('client-1', snapshot());
  const created = await session.callTool('canvas_propose_changes', {
    projectId: 'project-1',
    baseRevision: 'revision-1',
    summary: 'Move a node',
    operations: [{
      type: 'move_node',
      nodeId: 'node-1',
      position: { x: 120, y: 80 },
    }],
  }) as { proposalId: string };

  session.resolveProposal('client-1', created.proposalId, 'applied', {
    updatedNodeIds: ['node-1'],
  });
  const status = await session.callTool('canvas_get_change_status', {
    proposalId: created.proposalId,
  }) as { status: string; result: unknown };
  assert.equal(status.status, 'applied');
  assert.deepEqual(status.result, { updatedNodeIds: ['node-1'] });

  response.end();
});

test('returns a proposal result directly when Lumina completes within the fast wait', async () => {
  const session = new CanvasSession(100, 100);
  const response = new TestResponse();
  session.openEvents('client-1', response as unknown as ServerResponse);
  session.updateState('client-1', snapshot());

  const resultPromise = session.callTool('canvas_propose_changes', {
    projectId: 'project-1',
    baseRevision: 'revision-1',
    summary: 'Move a node',
    operations: [{
      type: 'move_node',
      nodeId: 'node-1',
      position: { x: 120, y: 80 },
    }],
  });
  const proposalId = readLastProposalId(response);
  session.resolveProposal('client-1', proposalId, 'applied', {
    updatedNodeIds: ['node-1'],
  });

  const result = await resultPromise.finally(() => response.end()) as {
    status: string;
    result?: unknown;
  };
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.result, { updatedNodeIds: ['node-1'] });
});

test('does not return transient stale before an applied result that follows its snapshot', async () => {
  const session = new CanvasSession(100, 100);
  const response = new TestResponse();
  session.openEvents('client-1', response as unknown as ServerResponse);
  session.updateState('client-1', snapshot('revision-1'));

  const resultPromise = session.callTool('canvas_propose_changes', {
    projectId: 'project-1',
    baseRevision: 'revision-1',
    summary: 'Move a node',
    operations: [{
      type: 'move_node',
      nodeId: 'node-1',
      position: { x: 10, y: 20 },
    }],
  });
  const proposalId = readLastProposalId(response);
  session.updateState('client-1', snapshot('revision-after-apply'));
  await new Promise((resolve) => setImmediate(resolve));
  session.resolveProposal('client-1', proposalId, 'applied', { movedNodeIds: ['node-1'] });

  const result = await resultPromise.finally(() => response.end()) as {
    status: string;
    result?: unknown;
  };
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.result, { movedNodeIds: ['node-1'] });
});

test('waits for target node progress without returning the full canvas', async () => {
  const session = new CanvasSession();
  const response = new TestResponse();
  session.openEvents('client-1', response as unknown as ServerResponse);
  session.updateState('client-1', snapshot('revision-1', [], [{
    id: 'result-1',
    type: 'exportImageNode',
    data: {
      displayName: 'Front view',
      isGenerating: true,
      generationBatchId: 'batch-1',
      generationBatchIndex: 0,
      generationBatchSize: 1,
    },
  }]));

  const resultPromise = session.callTool('canvas_wait_for_nodes', {
    projectId: 'project-1',
    nodeIds: ['result-1'],
    timeoutMs: 100,
  });
  session.updateState('client-1', snapshot('revision-2', [], [{
    id: 'result-1',
    type: 'exportImageNode',
    data: {
      displayName: 'Front view',
      isGenerating: false,
      generationBatchId: 'batch-1',
      generationBatchIndex: 0,
      generationBatchSize: 1,
    },
  }]));

  const result = await resultPromise.finally(() => response.end()) as {
    changed: boolean;
    summary: { ready: number; allTerminal: boolean };
    nodes: Array<{ nodeId: string; status: string }>;
    capabilities?: unknown;
    edges?: unknown;
  };
  assert.equal(result.changed, true);
  assert.deepEqual(result.summary, {
    total: 1,
    ready: 1,
    generating: 0,
    failed: 0,
    attentionRequired: 0,
    empty: 0,
    missing: 0,
    terminal: 1,
    allTerminal: true,
  });
  assert.deepEqual(result.nodes, [{
    nodeId: 'result-1',
    nodeType: 'exportImageNode',
    status: 'ready',
    generationError: null,
    generationRecoveryState: null,
  }]);
  assert.equal('displayName' in result.nodes[0], false);
  assert.equal(result.capabilities, undefined);
  assert.equal(result.edges, undefined);
});

test('rejects a node wait timeout when the connected canvas heartbeat is stale', async () => {
  const session = new CanvasSession();
  const response = new TestResponse();
  const realDateNow = Date.now;
  let now = realDateNow();
  Date.now = () => now;

  try {
    session.openEvents('client-1', response as unknown as ServerResponse);
    session.updateState('client-1', snapshot('revision-1', [], [{
      id: 'result-1',
      type: 'exportImageNode',
      data: { isGenerating: true },
    }]));

    const resultPromise = session.callTool('canvas_wait_for_nodes', {
      projectId: 'project-1',
      nodeIds: ['result-1'],
      timeoutMs: 5,
    });
    now += 16_000;

    await assert.rejects(resultPromise, (error: unknown) => Boolean(
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'NO_ACTIVE_CANVAS'
    ));
  } finally {
    Date.now = realDateNow;
    response.end();
  }
});

test('preserves selected previews across lightweight snapshot heartbeats', async () => {
  const session = new CanvasSession();
  const response = new TestResponse();
  session.openEvents('client-1', response as unknown as ServerResponse);
  session.updateState('client-1', snapshot('revision-1', [{
    nodeId: 'node-1',
    mimeType: 'image/jpeg',
    dataUrl: 'data:image/jpeg;base64,preview',
  }]));
  const { selectedImagePreviews: _previews, ...lightweightSnapshot } = snapshot('revision-2');
  session.updateState('client-1', lightweightSnapshot);

  const state = await session.callTool('canvas_get_state', {}) as CanvasSnapshot;
  assert.deepEqual(state.selectedImagePreviews, [{
    nodeId: 'node-1',
    mimeType: 'image/jpeg',
    dataUrl: 'data:image/jpeg;base64,preview',
  }]);

  response.end();
});

test('records an applied result that arrives after its committed snapshot', async () => {
  const session = new CanvasSession();
  const response = new TestResponse();
  session.openEvents('client-1', response as unknown as ServerResponse);
  session.updateState('client-1', snapshot('revision-1'));
  const created = await session.callTool('canvas_propose_changes', {
    projectId: 'project-1',
    baseRevision: 'revision-1',
    summary: 'Move a node',
    operations: [{
      type: 'move_node',
      nodeId: 'node-1',
      position: { x: 10, y: 20 },
    }],
  }) as { proposalId: string };

  session.updateState('client-1', snapshot('revision-after-apply'));
  session.resolveProposal('client-1', created.proposalId, 'applied', { movedNodeIds: ['node-1'] });

  const status = await session.callTool('canvas_get_change_status', {
    proposalId: created.proposalId,
  }) as { status: string; result?: unknown };
  assert.equal(status.status, 'applied');
  assert.deepEqual(status.result, { movedNodeIds: ['node-1'] });

  response.end();
});

test('returns an action result directly when Lumina completes within the fast wait', async () => {
  const session = new CanvasSession(100);
  const response = new TestResponse();
  session.openEvents('client-1', response as unknown as ServerResponse);
  session.updateState('client-1', snapshot());

  const resultPromise = session.callTool('canvas_get_node_images', {
    projectId: 'project-1',
    nodeIds: ['node-1'],
    maxDimension: 768,
  });
  const actionId = readLastActionId(response);
  session.resolveAction('client-1', actionId, 'applied', {
    images: [{ nodeId: 'node-1', dataUrl: 'data:image/webp;base64,cHJldmlldw==' }],
  });

  const result = await resultPromise as { status: string; result?: unknown };
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.result, {
    images: [{ nodeId: 'node-1', dataUrl: 'data:image/webp;base64,cHJldmlldw==' }],
  });
  const retained = await session.callTool('canvas_get_action_status', { actionId }) as {
    result?: unknown;
  };
  assert.deepEqual(retained.result, { images: [{ nodeId: 'node-1' }] });
  response.end();
});

test('returns pending only after the action fast wait expires', async () => {
  const session = new CanvasSession(5);
  const response = new TestResponse();
  session.openEvents('client-1', response as unknown as ServerResponse);
  session.updateState('client-1', snapshot());

  const result = await session.callTool('canvas_import_images', {
    projectId: 'project-1',
    baseRevision: 'revision-1',
    images: [{ clientId: 'model', source: 'data:image/png;base64,AA==' }],
  }) as { actionId: string; status: string };
  assert.equal(result.status, 'pending');

  session.resolveAction('client-1', result.actionId, 'applied', { createdNodeIds: ['upload-1'] });
  const status = await session.callTool('canvas_get_action_status', {
    actionId: result.actionId,
  }) as { status: string; result?: unknown };
  assert.equal(status.status, 'applied');
  assert.deepEqual(status.result, { createdNodeIds: ['upload-1'] });
  response.end();
});

test('marks an in-flight action stale when its canvas disconnects', async () => {
  const session = new CanvasSession(100);
  const response = new TestResponse();
  session.openEvents('client-1', response as unknown as ServerResponse);
  session.updateState('client-1', snapshot());

  const resultPromise = session.callTool('canvas_run_nodes', {
    projectId: 'project-1',
    baseRevision: 'revision-1',
    nodeIds: ['node-1'],
  });
  response.end();

  const result = await resultPromise as { status: string; error?: string };
  assert.equal(result.status, 'stale');
  assert.equal(result.error, 'canvas_disconnected');
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

function readLastProposalId(response: TestResponse): string {
  const block = [...response.chunks].reverse().find((chunk) => chunk.includes('event: change_proposal'));
  assert.ok(block, 'expected a change_proposal event');
  const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, 'expected change_proposal data');
  const payload = JSON.parse(dataLine.slice('data: '.length)) as { proposalId?: string };
  assert.ok(payload.proposalId, 'expected proposalId');
  return payload.proposalId;
}
