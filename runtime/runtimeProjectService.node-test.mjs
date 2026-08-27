import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRuntimeProjectService,
} from './runtimeProjectService.mjs';

function createFixture(options = {}) {
  let clock = 1_000;
  let tokenIndex = 0;
  const calls = [];
  const library = {
    async open() { calls.push(['open']); },
    async close() { calls.push(['close']); },
    async listProjects() { calls.push(['listProjects']); return []; },
    async openProject(projectId) { calls.push(['openProject', projectId]); return { id: projectId }; },
    async saveSnapshot(record) { calls.push(['saveSnapshot', record]); return record; },
    async updateViewport(projectId, viewportJson) { calls.push(['updateViewport', projectId, viewportJson]); },
    async renameProject(projectId, name, updatedAt) { calls.push(['renameProject', projectId, name, updatedAt]); },
    async deleteProject(projectId) { calls.push(['deleteProject', projectId]); return true; },
    async writeAsset(input) { calls.push(['writeAsset', input]); return { assetId: input.assetId }; },
    async readAsset(assetId) { calls.push(['readAsset', assetId]); return new Blob(['asset']); },
    async getAssetMetadata(assetId) { calls.push(['getAssetMetadata', assetId]); return { assetId, projectId: 'project-1' }; },
    async deleteAsset(assetId) { calls.push(['deleteAsset', assetId]); return true; },
    ...options.library,
  };
  const service = createRuntimeProjectService({
    library,
    now: () => clock,
    createToken: () => `opaque-runtime-token-${++tokenIndex}`,
    sessionTtlMs: 100,
    leaseTtlMs: 20,
    delegationTtlMs: 5,
  });
  return {
    calls,
    library,
    service,
    advance(milliseconds) { clock += milliseconds; },
  };
}

async function browserEditor(fixture, projectId = 'project-1') {
  await fixture.service.open();
  const session = fixture.service.createBrowserSession();
  const lease = fixture.service.acquireChromeLease(session.token, projectId);
  return { sessionToken: session.token, projectId, leaseToken: lease.token };
}

function recordFor(id) {
  return { id };
}

test('isolates editor leases by project and validates every mutation against its project lease', async () => {
  const fixture = createFixture();
  await fixture.service.open();
  const firstSession = fixture.service.createBrowserSession();
  const secondSession = fixture.service.createBrowserSession();
  const firstLease = fixture.service.acquireChromeLease(firstSession.token, 'project-1');
  const secondLease = fixture.service.acquireChromeLease(secondSession.token, 'project-2');

  assert.deepEqual(await fixture.service.listProjects(firstSession.token), []);
  await assert.rejects(
    fixture.service.listProjects('not-a-session'),
    (error) => error.code === 'session_invalid',
  );
  assert.throws(
    () => fixture.service.acquireChromeLease(secondSession.token, 'project-1'),
    (error) => error.code === 'editor_busy',
  );
  await assert.rejects(
    fixture.service.saveSnapshot({
      sessionToken: secondSession.token,
      leaseToken: secondLease.token,
    }, { id: 'project-1' }),
    (error) => error.code === 'editor_lease_invalid',
  );

  const record = recordFor('project-1');
  assert.equal(await fixture.service.saveSnapshot({
    sessionToken: firstSession.token,
    leaseToken: firstLease.token,
  }, record), record);
  const secondRecord = recordFor('project-2');
  assert.equal(await fixture.service.saveSnapshot({
    sessionToken: secondSession.token,
    leaseToken: secondLease.token,
  }, secondRecord), secondRecord);
  assert.deepEqual(fixture.service.getEditorStatus(firstSession.token, 'project-1'), {
    mode: 'chrome',
    projectId: 'project-1',
    expiresAt: 1_020,
  });
  assert.deepEqual(fixture.service.getEditorStatus(secondSession.token, 'project-2'), {
    mode: 'chrome',
    projectId: 'project-2',
    expiresAt: 1_020,
  });
});

test('force takeover revokes only the target project lease and rejects stale writes', async () => {
  const fixture = createFixture();
  await fixture.service.open();
  const firstSession = fixture.service.createBrowserSession();
  const secondSession = fixture.service.createBrowserSession();
  const firstLease = fixture.service.acquireChromeLease(firstSession.token, 'project-1');
  const unrelatedLease = fixture.service.acquireChromeLease(firstSession.token, 'project-2');

  const replacement = fixture.service.acquireChromeLease(secondSession.token, 'project-1', { force: true });
  assert.equal(replacement.projectId, 'project-1');
  await assert.rejects(
    fixture.service.saveSnapshot({ sessionToken: firstSession.token, leaseToken: firstLease.token }, { id: 'project-1' }),
    (error) => error.code === 'editor_lease_invalid',
  );
  const unrelatedRecord = recordFor('project-2');
  assert.equal(await fixture.service.saveSnapshot({
    sessionToken: firstSession.token,
    leaseToken: unrelatedLease.token,
  }, unrelatedRecord), unrelatedRecord);
  const replacementRecord = recordFor('project-1');
  assert.equal(await fixture.service.saveSnapshot({
    sessionToken: secondSession.token,
    leaseToken: replacement.token,
  }, replacementRecord), replacementRecord);

  fixture.service.handoffToCodex(
    secondSession.token,
    'project-1',
    replacement.token,
    'codex-session-force',
  );
  const delegation = fixture.service.createCodexDelegation(
    'codex-session-force',
    'project-1',
    'action-force',
  );
  fixture.service.acquireChromeLease(firstSession.token, 'project-1', { force: true });
  await assert.rejects(
    fixture.service.renameProject({
      delegationToken: delegation.token,
      actionId: delegation.actionId,
    }, 'project-1', 'Rejected stale delegation', 2),
    (error) => error.code === 'editor_lease_invalid',
  );
});

test('renews leases, expires authority, and releases a closed browser session', async () => {
  const fixture = createFixture();
  const editor = await browserEditor(fixture);
  fixture.advance(15);
  assert.deepEqual(fixture.service.renewChromeLease(editor.sessionToken, editor.projectId, editor.leaseToken), {
    mode: 'chrome',
    projectId: editor.projectId,
    token: editor.leaseToken,
    expiresAt: 1_035,
  });

  fixture.advance(21);
  await assert.rejects(
    fixture.service.deleteProject(editor, 'project-expired'),
    (error) => error.code === 'editor_lease_invalid',
  );
  assert.deepEqual(fixture.service.getEditorStatus(editor.sessionToken, editor.projectId), {
    mode: 'available',
    projectId: editor.projectId,
  });

  const reacquired = fixture.service.acquireChromeLease(editor.sessionToken, editor.projectId);
  assert.equal(fixture.service.closeBrowserSession(editor.sessionToken), true);
  const nextSession = fixture.service.createBrowserSession();
  assert.equal(fixture.service.acquireChromeLease(nextSession.token, editor.projectId).mode, 'chrome');
  assert.notEqual(reacquired.token, editor.leaseToken);
});

test('hands Chrome authority to Codex and permits only a bound one-shot delegated action', async () => {
  const fixture = createFixture();
  const chrome = await browserEditor(fixture);
  assert.deepEqual(
    fixture.service.handoffToCodex(chrome.sessionToken, chrome.projectId, chrome.leaseToken, 'codex-session-1'),
    { mode: 'codex', projectId: chrome.projectId, expiresAt: 1_020 },
  );
  assert.deepEqual(fixture.service.getEditorStatus(chrome.sessionToken, chrome.projectId), {
    mode: 'codex',
    projectId: chrome.projectId,
    expiresAt: 1_020,
  });
  await assert.rejects(
    fixture.service.renameProject(chrome, 'project-1', 'Blocked Chrome', 2),
    (error) => error.code === 'editor_lease_invalid',
  );

  const delegation = fixture.service.createCodexDelegation('codex-session-1', chrome.projectId, 'action-1');
  await fixture.service.renameProject({
    delegationToken: delegation.token,
    actionId: 'action-1',
  }, 'project-1', 'Codex edit', 3);
  await assert.rejects(
    fixture.service.renameProject({
      delegationToken: delegation.token,
      actionId: 'action-1',
    }, 'project-1', 'Replayed edit', 4),
    (error) => error.code === 'editor_lease_invalid',
  );

  fixture.service.revokeCodexLease('codex-session-1', chrome.projectId);
  assert.deepEqual(fixture.service.getEditorStatus(chrome.sessionToken, chrome.projectId), {
    mode: 'available',
    projectId: chrome.projectId,
  });
  assert.equal(fixture.service.acquireChromeLease(chrome.sessionToken, chrome.projectId).mode, 'chrome');
});

test('revokes delegated actions on expiry, disconnect, and Runtime shutdown', async () => {
  const fixture = createFixture();
  const chrome = await browserEditor(fixture);
  fixture.service.handoffToCodex(chrome.sessionToken, chrome.projectId, chrome.leaseToken, 'codex-session-expiry');
  const expired = fixture.service.createCodexDelegation('codex-session-expiry', chrome.projectId, 'action-expiry');
  fixture.advance(5);
  await assert.rejects(
    fixture.service.deleteAsset({
      delegationToken: expired.token,
      actionId: expired.actionId,
    }, chrome.projectId, 'asset-1'),
    (error) => error.code === 'editor_lease_invalid',
  );

  fixture.service.revokeCodexLease('codex-session-expiry', chrome.projectId);
  const lease = fixture.service.acquireChromeLease(chrome.sessionToken, chrome.projectId);
  fixture.service.handoffToCodex(chrome.sessionToken, chrome.projectId, lease.token, 'codex-session-close');
  const revoked = fixture.service.createCodexDelegation('codex-session-close', chrome.projectId, 'action-close');
  fixture.service.revokeCodexLease('codex-session-close', chrome.projectId);
  await assert.rejects(
    fixture.service.deleteAsset(
      { delegationToken: revoked.token, actionId: revoked.actionId },
      chrome.projectId,
      'asset-1',
    ),
    (error) => error.code === 'editor_lease_invalid',
  );

  await fixture.service.close();
  assert.deepEqual(fixture.calls.at(-1), ['close']);
  await assert.rejects(
    fixture.service.listProjects(chrome.sessionToken),
    (error) => error.code === 'runtime_unavailable',
  );
});

test('keeps generation authorization outside the project service contract', async () => {
  const fixture = createFixture();
  await fixture.service.open();
  assert.equal(Object.hasOwn(fixture.service, 'authorizeGeneration'), false);
  assert.equal(Object.hasOwn(fixture.service, 'submitGeneration'), false);
  assert.deepEqual(
    Object.keys(fixture.service).filter((key) => /generation|gateway/iu.test(key)),
    [],
  );
});
