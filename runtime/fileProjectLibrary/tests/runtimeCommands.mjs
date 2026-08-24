import { assert, assetLifecycleOptions, canonicalize, createAssetOwner, createFileProjectLibrary, fs, os, path, sha256, test, writeOwnedAsset } from './testSupport.mjs';

function emptyTrashCommandRequest(catalog, deletionId, trashManifestSha256, now) {
  const action = 'empty-trash';
  const subject = { projectId: null, assetId: null, deletionId };
  const body = { deletionId, trashManifestSha256 };
  const commandRequestSha256 = sha256(canonicalize({
    format: 'lumina-runtime-command-request',
    version: 1,
    action,
    expectedCatalog: catalog,
    subject,
    body,
  }));
  return {
    action,
    subject,
    expectedCatalog: catalog,
    body,
    authorization: {
      format: 'lumina-runtime-command-authorization',
      version: 1,
      action,
      subject,
      commandRequestSha256,
      bridgeSessionId: 'test-session',
      issuedAt: now,
      expiresAt: now + 60_000,
      proof: 'test-proof',
    },
  };
}

async function createTrash(library) {
  await createAssetOwner(library, 'project-runtime-command');
  await writeOwnedAsset(library, {
    assetId: 'asset-runtime-command',
    projectId: 'project-runtime-command',
    kind: 'image',
    sourceKind: 'import',
    blob: new Blob([Uint8Array.from([8, 6, 4])], { type: 'image/png' }),
  });
  await library.setDeletionCandidates(
    'project-runtime-command',
    ['asset-runtime-command'],
    await assetLifecycleOptions(library, 'project-runtime-command', 'r1', ['asset-runtime-command']),
  );
  return library.cleanupOrphans();
}

test('empties trash only through a verified catalog-bound runtime command context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-empty-trash-command-'));
  let now = 10_000;
  try {
    const library = createFileProjectLibrary({
      root,
      clock: () => now,
      testRuntimeCommandAuthorizationVerifier: async (authorization) => ({
        bridgeSessionId: authorization.bridgeSessionId,
        issuedAt: authorization.issuedAt,
        expiresAt: authorization.expiresAt,
      }),
    });
    await library.open();
    const trashed = await createTrash(library);
    const manifestBytes = await fs.readFile(path.join(root, 'trash', trashed.deletionId, 'manifest.json'));
    const trashManifestSha256 = sha256(manifestBytes);

    await assert.rejects(
      library.cleanupOrphans({
        emptyTrash: {
          deletionId: trashed.deletionId,
          trashManifestSha256,
          authorization: 'old-literal-authorization',
        },
      }),
      (error) => error.code === 'runtime_command_context_required',
    );

    const request = emptyTrashCommandRequest((await library.open()).revision, trashed.deletionId, trashManifestSha256, now);
    const context = await library.authorizeRuntimeCommand(request);
    const result = await library.cleanupOrphans({
      emptyTrash: { deletionId: trashed.deletionId, trashManifestSha256, context },
    });
    assert.equal(result.code, 'trash_empty_complete');
    await library.rename('project-runtime-command', 'Replay probe', 3, {
      expectedCatalog: (await library.open()).revision,
      expectedRevision: 'r1',
    });
    assert.deepEqual(
      await library.cleanupOrphans({
        emptyTrash: { deletionId: trashed.deletionId, trashManifestSha256, context },
      }),
      result,
    );
    const ledgerBytes = await fs.readFile(path.join(root, 'control', 'runtime-command-ledger.json'), 'utf8');
    const ledger = JSON.parse(ledgerBytes);
    assert.equal(ledger.entries[0].state, 'completed');
    assert.equal(ledgerBytes.includes('test-proof'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recovers an empty-trash command interrupted after its durable cleanup receipt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-empty-trash-command-crash-'));
  let now = 15_000;
  let crash = false;
  try {
    const library = createFileProjectLibrary({
      root,
      clock: () => now,
      testRuntimeCommandAuthorizationVerifier: async (authorization) => ({
        bridgeSessionId: authorization.bridgeSessionId,
        issuedAt: authorization.issuedAt,
        expiresAt: authorization.expiresAt,
      }),
      faultInjector: async (phase) => {
        if (crash && phase === 'after-trash-cleanup-authorized') {
          throw new Error('simulated-empty-trash-after-authorized');
        }
      },
    });
    await library.open();
    const trashed = await createTrash(library);
    const trashManifestSha256 = sha256(await fs.readFile(path.join(root, 'trash', trashed.deletionId, 'manifest.json')));
    const request = emptyTrashCommandRequest((await library.open()).revision, trashed.deletionId, trashManifestSha256, now);
    const context = await library.authorizeRuntimeCommand(request);
    crash = true;
    await assert.rejects(
      library.cleanupOrphans({ emptyTrash: { deletionId: trashed.deletionId, trashManifestSha256, context } }),
      /simulated-empty-trash-after-authorized/u,
    );
    crash = false;
    now += 60_001;

    const restarted = createFileProjectLibrary({
      root,
      clock: () => now,
      testRuntimeCommandAuthorizationVerifier: async (authorization) => ({
        bridgeSessionId: authorization.bridgeSessionId,
        issuedAt: authorization.issuedAt,
        expiresAt: authorization.expiresAt,
      }),
    });
    await restarted.open();
    await restarted.cleanupOrphans();
    await restarted.rename('project-runtime-command', 'Later publication', 3, {
      expectedCatalog: (await restarted.open()).revision,
      expectedRevision: 'r1',
    });
    assert.deepEqual(
      await restarted.cleanupOrphans({ emptyTrash: { deletionId: trashed.deletionId, trashManifestSha256, context } }),
      { code: 'trash_empty_complete', deletionId: trashed.deletionId },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects a stale or expired empty-trash command context without removing trash payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-empty-trash-stale-command-'));
  let now = 20_000;
  try {
    const library = createFileProjectLibrary({
      root,
      clock: () => now,
      testRuntimeCommandAuthorizationVerifier: async (authorization) => ({
        bridgeSessionId: authorization.bridgeSessionId,
        issuedAt: authorization.issuedAt,
        expiresAt: authorization.expiresAt,
      }),
    });
    await library.open();
    const trashed = await createTrash(library);
    const manifestBytes = await fs.readFile(path.join(root, 'trash', trashed.deletionId, 'manifest.json'));
    const trashManifestSha256 = sha256(manifestBytes);
    const context = await library.authorizeRuntimeCommand(
      emptyTrashCommandRequest((await library.open()).revision, trashed.deletionId, trashManifestSha256, now),
    );
    now += 60_001;
    await assert.rejects(
      library.cleanupOrphans({ emptyTrash: { deletionId: trashed.deletionId, trashManifestSha256, context } }),
      (error) => error.code === 'authorization_denied',
    );
    assert.equal(await fs.stat(path.join(root, 'trash', trashed.deletionId, 'manifest.json')).then(() => true), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects a command ledger whose retained command exceeds its high-water mark', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-command-ledger-high-water-'));
  let now = 30_000;
  try {
    const library = createFileProjectLibrary({
      root,
      clock: () => now,
      testRuntimeCommandAuthorizationVerifier: async (authorization) => ({
        bridgeSessionId: authorization.bridgeSessionId,
        issuedAt: authorization.issuedAt,
        expiresAt: authorization.expiresAt,
      }),
    });
    await library.open();
    const deletionId = 'd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const request = emptyTrashCommandRequest((await library.open()).revision, deletionId, '0'.repeat(64), now);
    await library.authorizeRuntimeCommand(request);
    const ledgerPath = path.join(root, 'control', 'runtime-command-ledger.json');
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    await fs.writeFile(ledgerPath, canonicalize({ ...ledger, lastAllocatedSequence: 0 }), 'utf8');

    await assert.rejects(
      library.authorizeRuntimeCommand(request),
      (error) => error.code === 'recovery_required',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
