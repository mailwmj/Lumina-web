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
    async getAssetMetadata(assetId) { calls.push(['getAssetMetadata', assetId]); return { assetId }; },
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

async function browserEditor(fixture) {
  await fixture.service.open();
  const session = fixture.service.createBrowserSession();
  const lease = fixture.service.acquireChromeLease(session.token);
  return { sessionToken: session.token, leaseToken: lease.token };
}

test('requires an opaque browser session for reads and one global lease for all mutations', async () => {
  const fixture = createFixture();
  await fixture.service.open();
  const firstSession = fixture.service.createBrowserSession();
  const secondSession = fixture.service.createBrowserSession();
  const firstLease = fixture.service.acquireChromeLease(firstSession.token);

  assert.deepEqual(await fixture.service.listProjects(firstSession.token), []);
  await assert.rejects(
    fixture.service.listProjects('not-a-session'),
    (error) => error.code === 'session_invalid',
  );
  assert.throws(
    () => fixture.service.acquireChromeLease(secondSession.token),
    (error) => error.code === 'editor_busy',
  );
  await assert.rejects(
    fixture.service.saveSnapshot({
      sessionToken: secondSession.token,
      leaseToken: firstLease.token,
    }, { id: 'other-project' }),
    (error) => error.code === 'editor_lease_invalid',
  );

  const record = { id: 'project-1' };
  assert.equal(await fixture.service.saveSnapshot({
    sessionToken: firstSession.token,
    leaseToken: firstLease.token,
  }, record), record);
  assert.deepEqual(fixture.service.getEditorStatus(firstSession.token), {
    mode: 'chrome',
    expiresAt: 1_020,
  });
  assert.deepEqual(fixture.service.getEditorStatus(secondSession.token), {
    mode: 'busy',
    expiresAt: 1_020,
  });
});

test('renews leases, expires authority, and releases a closed browser session', async () => {
  const fixture = createFixture();
  const editor = await browserEditor(fixture);
  fixture.advance(15);
  assert.deepEqual(fixture.service.renewChromeLease(editor.sessionToken, editor.leaseToken), {
    mode: 'chrome',
    token: editor.leaseToken,
    expiresAt: 1_035,
  });

  fixture.advance(21);
  await assert.rejects(
    fixture.service.deleteProject(editor, 'project-expired'),
    (error) => error.code === 'editor_lease_invalid',
  );
  assert.deepEqual(fixture.service.getEditorStatus(editor.sessionToken), { mode: 'available' });

  const reacquired = fixture.service.acquireChromeLease(editor.sessionToken);
  assert.equal(fixture.service.closeBrowserSession(editor.sessionToken), true);
  const nextSession = fixture.service.createBrowserSession();
  assert.equal(fixture.service.acquireChromeLease(nextSession.token).mode, 'chrome');
  assert.notEqual(reacquired.token, editor.leaseToken);
});

test('hands Chrome authority to Codex and permits only a bound one-shot delegated action', async () => {
  const fixture = createFixture();
  const chrome = await browserEditor(fixture);
  assert.deepEqual(
    fixture.service.handoffToCodex(chrome.sessionToken, chrome.leaseToken, 'codex-session-1'),
    { mode: 'codex', expiresAt: 1_020 },
  );
  assert.deepEqual(fixture.service.getEditorStatus(chrome.sessionToken), {
    mode: 'codex',
    expiresAt: 1_020,
  });
  await assert.rejects(
    fixture.service.renameProject(chrome, 'project-1', 'Blocked Chrome', 2),
    (error) => error.code === 'editor_lease_invalid',
  );

  const delegation = fixture.service.createCodexDelegation('codex-session-1', 'action-1');
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

  fixture.service.revokeCodexLease('codex-session-1');
  assert.deepEqual(fixture.service.getEditorStatus(chrome.sessionToken), { mode: 'available' });
  assert.equal(fixture.service.acquireChromeLease(chrome.sessionToken).mode, 'chrome');
});

test('revokes delegated actions on expiry, disconnect, and Runtime shutdown', async () => {
  const fixture = createFixture();
  const chrome = await browserEditor(fixture);
  fixture.service.handoffToCodex(chrome.sessionToken, chrome.leaseToken, 'codex-session-expiry');
  const expired = fixture.service.createCodexDelegation('codex-session-expiry', 'action-expiry');
  fixture.advance(5);
  await assert.rejects(
    fixture.service.deleteAsset({
      delegationToken: expired.token,
      actionId: expired.actionId,
    }, 'asset-1'),
    (error) => error.code === 'editor_lease_invalid',
  );

  fixture.service.revokeCodexLease('codex-session-expiry');
  const lease = fixture.service.acquireChromeLease(chrome.sessionToken);
  fixture.service.handoffToCodex(chrome.sessionToken, lease.token, 'codex-session-close');
  const revoked = fixture.service.createCodexDelegation('codex-session-close', 'action-close');
  fixture.service.revokeCodexLease('codex-session-close');
  await assert.rejects(
    fixture.service.deleteAsset({ delegationToken: revoked.token, actionId: revoked.actionId }, 'asset-1'),
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
