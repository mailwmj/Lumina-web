import { assert, assetLifecycleOptions, canonicalize, createAssetOwner, createFileProjectLibrary, createRawFileProjectLibrary, emptyTrashOptions, fs, os, path, projectMutationOptions, projectRecord, sha256, test, TEST_DURABLE_FILE_OPS, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';

test('moves deletion candidates through durable trash before catalog removal and bounded GC', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-lifecycle-'));
  let clockNow = Date.now();
  try {
    const library = createFileProjectLibrary({ root, clock: () => clockNow });
    await library.open();
    await createAssetOwner(library, 'project-trash-lifecycle');
    await writeOwnedAsset(library, {
      assetId: 'asset-trash-lifecycle',
      projectId: 'project-trash-lifecycle',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([7, 4, 3])], { type: 'image/png' }),
    });
    await library.setDeletionCandidates(
      'project-trash-lifecycle',
      ['asset-trash-lifecycle'],
      {
        ...(await projectMutationOptions(library, 'r1')),
        expectedAssets: [{
          assetId: 'asset-trash-lifecycle',
          lifecycleState: 'active',
          metadataSha256: sha256(canonicalize({
            format: 'lumina-library-asset-metadata',
            version: 1,
            metadata: await library.getAssetMetadata('asset-trash-lifecycle'),
          })),
        }],
      },
    );
    const candidate = await library.getAssetMetadata('asset-trash-lifecycle');
    const catalog = JSON.parse(await fs.readFile(
      path.join(root, 'commits', `${(await library.open()).revision.commitId}.json`),
      'utf8',
    ));
    const entry = catalog.assets.find((item) => item.assetId === candidate.assetId);
    const priorBytes = path.join(root, entry.bytesPath);
    const priorMetadata = path.join(root, entry.metadataPath);

    const trashed = await library.cleanupOrphans();
    assert.equal(trashed.code, 'trash_published');
    assert.equal(await library.getAssetMetadata('asset-trash-lifecycle'), null);
    const manifest = JSON.parse(await fs.readFile(
      path.join(root, 'trash', trashed.deletionId, 'manifest.json'),
      'utf8',
    ));
    assert.equal(manifest.catalog.commitId, catalog.commitId);
    assert.equal(await fs.stat(path.join(root, manifest.assets[0].trashBytesPath)).then(() => true), true);
    assert.equal(await fs.stat(path.join(root, manifest.assets[0].trashMetadataPath)).then(() => true), true);

    assert.equal((await library.cleanupOrphans(await emptyTrashOptions(root, trashed.deletionId))).code, 'trash_empty_complete');
    await fs.utimes(priorBytes, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000);
    await fs.utimes(priorMetadata, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000);
    await library.saveSnapshot(
      projectRecord('project-trash-followup', 'Follow-up', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    const planned = await library.cleanupOrphans();
    assert.equal(planned.code, 'cleanup_planned');
    assert.ok(planned.entries.some((item) => item.path === entry.bytesPath));
    clockNow += THIRTY_DAYS_MS;
    const collected = await library.cleanupOrphans();
    assert.equal(collected.code, 'cleanup_complete');
    assert.equal(await fs.stat(priorBytes).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('requires an exact manifest-bound selection before emptying trash', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-selection-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await createAssetOwner(library, 'project-trash-selection');
    await writeOwnedAsset(library, {
      assetId: 'asset-trash-selection',
      projectId: 'project-trash-selection',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([9, 4, 2])], { type: 'image/png' }),
    });
    await library.setDeletionCandidates(
      'project-trash-selection',
      ['asset-trash-selection'],
      await assetLifecycleOptions(library, 'project-trash-selection', 'r1', ['asset-trash-selection']),
    );
    const trashed = await library.cleanupOrphans();
    const manifestPath = path.join(root, 'trash', trashed.deletionId, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

    await assert.rejects(
      library.cleanupOrphans({ emptyTrash: true }),
      (error) => error.code === 'trash_manifest_mismatch',
    );
    const mismatched = await emptyTrashOptions(root, trashed.deletionId);
    mismatched.emptyTrash.trashManifestSha256 = '0'.repeat(64);
    await assert.rejects(
      library.cleanupOrphans(mismatched),
      (error) => error.code === 'trash_manifest_mismatch',
    );
    assert.deepEqual(
      await fs.readFile(path.join(root, manifest.assets[0].trashBytesPath)),
      Buffer.from([9, 4, 2]),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('requires a fresh trusted authorization before emptying trash', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-authorization-'));
  try {
    const library = createFileProjectLibrary({
      root,
      emptyTrashAuthorizer: async () => false,
    });
    await library.open();
    await createAssetOwner(library, 'project-trash-authorization');
    await writeOwnedAsset(library, {
      assetId: 'asset-trash-authorization',
      projectId: 'project-trash-authorization',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([6, 2, 1])], { type: 'image/png' }),
    });
    await library.setDeletionCandidates(
      'project-trash-authorization',
      ['asset-trash-authorization'],
      await assetLifecycleOptions(library, 'project-trash-authorization', 'r1', ['asset-trash-authorization']),
    );
    const trashed = await library.cleanupOrphans();
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'trash', trashed.deletionId, 'manifest.json'), 'utf8'));

    await assert.rejects(
      library.cleanupOrphans(await emptyTrashOptions(root, trashed.deletionId)),
      (error) => error.code === 'authorization_denied',
    );
    assert.deepEqual(
      await fs.readFile(path.join(root, manifest.assets[0].trashBytesPath)),
      Buffer.from([6, 2, 1]),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resumes a manifest-backed trash copy before removing its live candidates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-recovery-'));
  let crashAfterManifest = true;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (crashAfterManifest && phase === 'after-trash-manifest') {
          crashAfterManifest = false;
          throw new Error('trash-manifest-crash');
        }
      },
    });
    await library.open();
    await createAssetOwner(library, 'project-trash-recovery');
    await writeOwnedAsset(library, {
      assetId: 'asset-trash-recovery',
      projectId: 'project-trash-recovery',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([8, 6, 7, 5])], { type: 'image/png' }),
    });
    await library.setDeletionCandidates(
      'project-trash-recovery',
      ['asset-trash-recovery'],
      await assetLifecycleOptions(library, 'project-trash-recovery', 'r1', ['asset-trash-recovery']),
    );

    await assert.rejects(library.cleanupOrphans(), /trash-manifest-crash/u);
    const [deletionId] = await fs.readdir(path.join(root, 'trash'));
    assert.match(deletionId, /^d_[0-9a-f]{32}$/u);
    assert.ok(await library.getAssetMetadata('asset-trash-recovery'));

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    assert.equal(await restarted.getAssetMetadata('asset-trash-recovery'), null);
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'trash', deletionId, 'manifest.json'), 'utf8'));
    assert.deepEqual(await fs.readFile(path.join(root, manifest.assets[0].trashBytesPath)), Buffer.from([8, 6, 7, 5]));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resumes an authorized trash cleanup after restart without a fresh authorization proof', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-authorized-restart-'));
  let crashAfterAuthorization = true;
  let restartedAuthorizationCalls = 0;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (crashAfterAuthorization && phase === 'after-trash-cleanup-authorized') {
          crashAfterAuthorization = false;
          throw new Error('trash-cleanup-authorized-crash');
        }
      },
    });
    await library.open();
    await createAssetOwner(library, 'project-trash-authorized-restart');
    await writeOwnedAsset(library, {
      assetId: 'asset-trash-authorized-restart',
      projectId: 'project-trash-authorized-restart',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([5, 8, 13])], { type: 'image/png' }),
    });
    await library.setDeletionCandidates(
      'project-trash-authorized-restart',
      ['asset-trash-authorized-restart'],
      await assetLifecycleOptions(library, 'project-trash-authorized-restart', 'r1', ['asset-trash-authorized-restart']),
    );
    const trashed = await library.cleanupOrphans();

    await assert.rejects(
      library.cleanupOrphans(await emptyTrashOptions(root, trashed.deletionId)),
      /trash-cleanup-authorized-crash/u,
    );
    const cleanupPath = path.join(root, 'trash', trashed.deletionId, 'cleanup.json');
    assert.equal(JSON.parse(await fs.readFile(cleanupPath, 'utf8')).state, 'authorized');

    const restarted = createFileProjectLibrary({
      root,
      emptyTrashAuthorizer: async () => {
        restartedAuthorizationCalls += 1;
        return false;
      },
    });
    await restarted.open();
    assert.deepEqual(await restarted.cleanupOrphans(), {
      code: 'trash_empty_complete',
      deletionId: trashed.deletionId,
    });
    assert.equal(restartedAuthorizationCalls, 0);
    assert.equal(JSON.parse(await fs.readFile(cleanupPath, 'utf8')).state, 'complete');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('removes an owned manifest temporary from an otherwise empty trash closure on restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-manifest-temp-'));
  const deletionId = 'd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const temporaryName = `manifest.json.${process.pid}.123e4567-e89b-12d3-a456-426614174000.tmp`;
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await createAssetOwner(library, 'project-trash-manifest-temp');
    await fs.mkdir(path.join(root, 'trash', deletionId), { recursive: true });
    await fs.writeFile(path.join(root, 'trash', deletionId, temporaryName), '{"incomplete":true}', 'utf8');

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();

    assert.equal((await restarted.openProject('project-trash-manifest-temp')).name, 'Asset owner project-trash-manifest-temp');
    assert.equal(
      await fs.stat(path.join(root, 'trash', deletionId, temporaryName)).then(() => true).catch(() => false),
      false,
    );
    assert.equal(await fs.stat(path.join(root, 'trash', deletionId)).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects oversized candidate metadata before its contents are read for trash', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-metadata-bound-'));
  const originalOpen = fs.open;
  const originalReadFile = fs.readFile;
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await createAssetOwner(library, 'project-trash-metadata-bound');
    await writeOwnedAsset(library, {
      assetId: 'asset-trash-metadata-bound',
      projectId: 'project-trash-metadata-bound',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([8, 8, 8])], { type: 'image/png' }),
    });
    await library.setDeletionCandidates(
      'project-trash-metadata-bound',
      ['asset-trash-metadata-bound'],
      await assetLifecycleOptions(library, 'project-trash-metadata-bound', 'r1', ['asset-trash-metadata-bound']),
    );
    const head = JSON.parse(await originalReadFile(path.join(root, 'head.json'), 'utf8'));
    const catalog = JSON.parse(await originalReadFile(path.join(root, 'commits', `${head.commitId}.json`), 'utf8'));
    const asset = catalog.assets.find((entry) => entry.assetId === 'asset-trash-metadata-bound');
    const metadataPath = path.join(root, asset.metadataPath);

    let metadataRead = false;
    let metadataOpens = 0;
    fs.open = async (target, ...arguments_) => {
      const handle = await originalOpen(target, ...arguments_);
      if (path.resolve(target) === path.resolve(metadataPath)) {
        metadataOpens += 1;
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        handle.read = async (...readArguments) => {
          if (metadataOpens > 1) metadataRead = true;
          return read(...readArguments);
        };
        handle.close = async () => {
          await close();
          if (metadataOpens === 1) await fs.writeFile(metadataPath, Buffer.alloc((64 * 1024) + 1));
        };
      }
      return handle;
    };
    await assert.rejects(library.cleanupOrphans(), (error) => error.code === 'corrupt_schema');
    assert.equal(metadataRead, false);
  } finally {
    fs.open = originalOpen;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('does not remove an outside directory when a manifest-temp ancestor is swapped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-temp-race-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-temp-outside-'));
  const deletionId = 'd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const temporaryName = `manifest.json.${process.pid}.123e4567-e89b-12d3-a456-426614174001.tmp`;
  const trashRoot = path.join(root, 'trash');
  const backupTrashRoot = path.join(root, 'trash-before-swap');
  let armed = false;
  let swapped = false;
  try {
    const durableFileOps = {
      removeIfUnchanged: async (managedRoot, relative, expectedContents) => {
        const target = path.join(managedRoot, relative);
        const removed = await TEST_DURABLE_FILE_OPS.removeIfUnchanged(managedRoot, relative, expectedContents);
        if (armed && removed && !swapped && path.resolve(target) === path.resolve(trashRoot, deletionId, temporaryName)) {
          swapped = true;
          await fs.mkdir(path.join(outside, deletionId));
          await fs.rename(trashRoot, backupTrashRoot);
          await fs.symlink(outside, trashRoot, 'junction');
        }
        return removed;
      },
    };
    const library = createFileProjectLibrary({ root, durableFileOps });
    await library.open();
    await fs.mkdir(path.join(trashRoot, deletionId), { recursive: true });
    await fs.writeFile(path.join(trashRoot, deletionId, temporaryName), '{"incomplete":true}', 'utf8');
    armed = true;

    const restarted = createFileProjectLibrary({ root, durableFileOps });
    await assert.rejects(restarted.open(), (error) => error.code === 'path_escape');
    assert.equal(swapped, true);
    assert.equal(await fs.stat(path.join(outside, deletionId)).then(() => true).catch(() => false), true);
  } finally {
    await fs.rm(trashRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rename(backupTrashRoot, trashRoot).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('does not delete an outside payload when a trash payload ancestor changes at exact removal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-delete-race-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-delete-outside-'));
  let armed = false;
  let expectedTarget = null;
  let swapped = false;
  let backupAssetDirectory = null;
  try {
    const restoreAncestor = async (assetDirectory) => {
      await fs.rm(assetDirectory, { recursive: true, force: true });
      await fs.rename(backupAssetDirectory, assetDirectory);
      backupAssetDirectory = null;
    };
    const durableFileOps = {
      removeIfUnchanged: async (...args) => {
        const legacyAbsoluteOperation = args.length === 2;
        const [managedRoot, relative] = args;
        const target = legacyAbsoluteOperation ? managedRoot : path.join(managedRoot, relative);
        if (!armed || path.resolve(target) !== path.resolve(expectedTarget)) {
          return TEST_DURABLE_FILE_OPS.removeIfUnchanged(managedRoot, relative, args[2]);
        }
        const assetDirectory = path.dirname(target);
        const outsidePayload = path.join(outside, path.basename(target));
        backupAssetDirectory = `${assetDirectory}-before-swap`;
        await fs.mkdir(outside, { recursive: true });
        await fs.copyFile(target, outsidePayload);
        await fs.rename(assetDirectory, backupAssetDirectory);
        await fs.symlink(outside, assetDirectory, 'junction');
        swapped = true;
        if (legacyAbsoluteOperation) await fs.rm(target, { force: true });
        await restoreAncestor(assetDirectory);
        return false;
      },
    };
    const library = createFileProjectLibrary({ root, durableFileOps });
    await library.open();
    await createAssetOwner(library, 'project-trash-delete-race');
    await writeOwnedAsset(library, {
      assetId: 'asset-trash-delete-race',
      projectId: 'project-trash-delete-race',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([21, 34])], { type: 'image/png' }),
    });
    await library.setDeletionCandidates(
      'project-trash-delete-race',
      ['asset-trash-delete-race'],
      await assetLifecycleOptions(library, 'project-trash-delete-race', 'r1', ['asset-trash-delete-race']),
    );
    const trashed = await library.cleanupOrphans();
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'trash', trashed.deletionId, 'manifest.json'), 'utf8'));
    const target = path.join(root, manifest.assets[0].trashBytesPath);
    expectedTarget = target;
    armed = true;

    assert.deepEqual(await library.cleanupOrphans(await emptyTrashOptions(root, trashed.deletionId)), {
      code: 'trash_empty_cancelled',
      deletionId: trashed.deletionId,
    });
    assert.equal(swapped, true);
    assert.deepEqual(await fs.readFile(path.join(outside, path.basename(target))), Buffer.from([21, 34]));
  } finally {
    const trash = path.join(root, 'trash');
    await fs.rm(trash, { recursive: true, force: true }).catch(() => {});
    if (backupAssetDirectory) {
      const assetDirectory = backupAssetDirectory.replace(/-before-swap$/u, '');
      await fs.rename(backupAssetDirectory, assetDirectory).catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('retains a durable trash expiry receipt before exact audit removal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-expiry-'));
  let clockNow = Date.now();
  try {
    const library = createFileProjectLibrary({ root, clock: () => clockNow });
    await library.open();
    await createAssetOwner(library, 'project-trash-expiry');
    await writeOwnedAsset(library, {
      assetId: 'asset-trash-expiry',
      projectId: 'project-trash-expiry',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([3, 1, 4])], { type: 'image/png' }),
    });
    await library.setDeletionCandidates(
      'project-trash-expiry',
      ['asset-trash-expiry'],
      await assetLifecycleOptions(library, 'project-trash-expiry', 'r1', ['asset-trash-expiry']),
    );
    const trashed = await library.cleanupOrphans();
    await library.cleanupOrphans(await emptyTrashOptions(root, trashed.deletionId));

    const trashRoot = path.join(root, 'trash', trashed.deletionId);
    const cleanup = JSON.parse(await fs.readFile(path.join(trashRoot, 'cleanup.json'), 'utf8'));
    assert.deepEqual(cleanup.expectedCatalog, trashed.catalog);
    assert.match(cleanup.rootSetSha256, /^[0-9a-f]{64}$/u);
    assert.equal(cleanup.authorizationClass, 'empty-trash');
    assert.equal(cleanup.authorizedAt, clockNow);
    assert.equal(cleanup.terminalAt, clockNow);
    assert.equal(cleanup.trashManifestSha256, sha256(await fs.readFile(path.join(trashRoot, 'manifest.json'))));
    assert.equal(Object.hasOwn(cleanup, 'cancelled'), false);

    clockNow += THIRTY_DAYS_MS;
    await library.cleanupOrphans();
    const expiry = JSON.parse(await fs.readFile(path.join(trashRoot, 'expiry.json'), 'utf8'));
    assert.equal(expiry.state, 'complete');
    assert.equal(expiry.authorizedAt, clockNow);
    assert.equal(expiry.trashManifestSha256, cleanup.trashManifestSha256);
    assert.equal(Object.hasOwn(expiry, 'manifestSha256'), false);
    assert.equal(await fs.stat(path.join(trashRoot, 'manifest.json')).then(() => true).catch(() => false), false);
    assert.equal(await fs.stat(path.join(trashRoot, 'cleanup.json')).then(() => true).catch(() => false), false);

    clockNow += THIRTY_DAYS_MS;
    await library.cleanupOrphans();
    assert.equal(await fs.stat(trashRoot).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cancels empty-trash when its catalog root changes after authorization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-root-change-'));
  let replaceHead = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (replaceHead && phase === 'after-trash-cleanup-authorized') {
          await fs.copyFile(path.join(root, 'head.previous.json'), path.join(root, 'head.json'));
        }
      },
    });
    await library.open();
    await createAssetOwner(library, 'project-trash-root-change');
    await writeOwnedAsset(library, {
      assetId: 'asset-trash-root-change',
      projectId: 'project-trash-root-change',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([1, 3, 5])], { type: 'image/png' }),
    });
    await library.setDeletionCandidates(
      'project-trash-root-change',
      ['asset-trash-root-change'],
      await assetLifecycleOptions(library, 'project-trash-root-change', 'r1', ['asset-trash-root-change']),
    );
    const trashed = await library.cleanupOrphans();
    replaceHead = true;

    assert.deepEqual(await library.cleanupOrphans(await emptyTrashOptions(root, trashed.deletionId)), {
      code: 'trash_empty_cancelled',
      deletionId: trashed.deletionId,
    });
    const trashRoot = path.join(root, 'trash', trashed.deletionId);
    const cleanup = JSON.parse(await fs.readFile(path.join(trashRoot, 'cleanup.json'), 'utf8'));
    assert.equal(cleanup.state, 'cancelled');
    assert.equal(Object.hasOwn(cleanup, 'cancelled'), false);
    assert.equal(await fs.stat(path.join(root, cleanup.entries[0].path)).then(() => true), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('plans and bounds orphan cleanup behind a safety window', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-cleanup-'));
  let clockNow = Date.now();
  try {
    const library = createFileProjectLibrary({ root, safetyWindowMs: 0, clock: () => clockNow });
    await library.open();
    const orphan = path.join(root, 'assets', 'a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'orphan.bin');
    await fs.mkdir(path.dirname(orphan), { recursive: true });
    await fs.writeFile(orphan, Uint8Array.from([1, 2, 3]));
    const now = Date.now() + 1_000;
    await fs.utimes(orphan, (now - THIRTY_DAYS_MS - 1_000) / 1_000, (now - THIRTY_DAYS_MS - 1_000) / 1_000);
    clockNow = now;

    const planned = await library.cleanupOrphans();
    assert.equal(planned.code, 'cleanup_planned');
    assert.equal(planned.notBefore, now + THIRTY_DAYS_MS);
    assert.equal(await fs.stat(orphan).then(() => true).catch(() => false), true);
    const duplicateAttempt = await library.cleanupOrphans();
    assert.equal(duplicateAttempt.code, 'cleanup_planned');
    assert.equal(duplicateAttempt.transactionId, planned.transactionId);
    assert.equal((await fs.readdir(path.join(root, 'maintenance'))).length, 1);
    clockNow = now + THIRTY_DAYS_MS;
    const completed = await library.cleanupOrphans();
    assert.equal(completed.code, 'cleanup_complete');
    assert.deepEqual(completed.removed, ['assets/a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/orphan.bin']);
    assert.equal(await fs.stat(orphan).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects persisted GC plans that shorten the safety window or skip authorization state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-invalid-gc-plan-'));
  let clockNow = Date.now();
  try {
    const library = createFileProjectLibrary({ root, clock: () => clockNow });
    await library.open();
    const orphan = path.join(root, 'assets', 'a_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'orphan.bin');
    await fs.mkdir(path.dirname(orphan), { recursive: true });
    await fs.writeFile(orphan, Uint8Array.from([1, 2, 3]));
    await fs.utimes(orphan, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000);
    const planned = await library.cleanupOrphans();
    const planPath = path.join(root, 'maintenance', planned.transactionId, 'gc.json');
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    await fs.writeFile(planPath, canonicalize({
      ...plan,
      notBefore: plan.plannedAt + THIRTY_DAYS_MS - 1,
    }), 'utf8');
    await assert.rejects(library.cleanupOrphans(), (error) => error.code === 'corrupt_schema');
    assert.equal(await fs.stat(orphan).then(() => true).catch(() => false), true);

    await fs.writeFile(planPath, canonicalize({
      ...plan,
      state: 'authorized',
      authorizedAt: null,
    }), 'utf8');
    await assert.rejects(library.cleanupOrphans(), (error) => error.code === 'corrupt_schema');
    assert.equal(await fs.stat(orphan).then(() => true).catch(() => false), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('does not delete unowned temporary files during startup recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-temp-scope-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const unrelated = path.join(
      root,
      'projects',
      'p_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'unrelated.123.123e4567-e89b-12d3-a456-426614174000.tmp',
    );
    const unrelatedHead = path.join(
      root,
      'head.json.123.123e4567-e89b-12d3-a456-426614174000.tmp',
    );
    await fs.mkdir(path.dirname(unrelated), { recursive: true });
    await fs.writeFile(unrelated, Uint8Array.from([7, 7, 7]));
    await fs.writeFile(unrelatedHead, Uint8Array.from([8, 8, 8]));
    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    assert.deepEqual([...await fs.readFile(unrelated)], [7, 7, 7]);
    assert.deepEqual([...await fs.readFile(unrelatedHead)], [8, 8, 8]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bounds catalog cleanup without requiring the full predecessor chain', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-lineage-cleanup-'));
  let clockNow = Date.now();
  try {
    const library = createFileProjectLibrary({ root, clock: () => clockNow });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-lineage-cleanup', 'First', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    await library.rename('project-lineage-cleanup', 'Second', 3, await projectMutationOptions(library, 'r1'));
    await library.rename('project-lineage-cleanup', 'Third', 4, await projectMutationOptions(library, 'r2'));

    const head = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    const orphanCommit = JSON.parse(await fs.readFile(path.join(root, 'head.previous.json'), 'utf8')).previousCommitId;
    const orphanPath = path.join(root, 'commits', `${orphanCommit}.json`);
    const old = (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000;
    await fs.utimes(orphanPath, old, old);
    const planned = await library.cleanupOrphans();
    assert.equal(planned.code, 'cleanup_planned');
    clockNow += THIRTY_DAYS_MS;
    const result = await library.cleanupOrphans();
    assert.equal(result.code, 'cleanup_complete');
    assert.equal(await fs.stat(orphanPath).then(() => true).catch(() => false), false);
    assert.equal((await library.openProject('project-lineage-cleanup')).name, 'Third');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8')).commitId, head.commitId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects an unrelated prior-head journal before cleanup can retain its payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-journal-root-'));
  let clockNow = Date.now();
  try {
    const library = createFileProjectLibrary({ root, clock: () => clockNow });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-journal-root', 'First', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    const firstHead = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    await library.rename('project-journal-root', 'Second', 3, await projectMutationOptions(library, 'r1'));
    const secondHead = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    await library.rename('project-journal-root', 'Third', 4, await projectMutationOptions(library, 'r2'));
    const currentHead = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    assert.equal(currentHead.previousCommitId, secondHead.commitId);
    assert.notEqual(firstHead.commitId, currentHead.previousCommitId);
    await fs.writeFile(path.join(root, 'head.previous.json'), canonicalize(firstHead), 'utf8');

    await assert.rejects(library.cleanupOrphans(), (error) => error.code === 'corrupt_schema');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keeps an in-flight reader catalog reachable through later cleanup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-reader-pin-'));
  let clockNow = Date.now();
  let releaseRead;
  let reading = null;
  try {
    const reader = createFileProjectLibrary({ root });
    const writer = createFileProjectLibrary({ root });
    const cleaner = createFileProjectLibrary({ root, clock: () => clockNow });
    await Promise.all([reader.open(), writer.open(), cleaner.open()]);
    await writer.saveSnapshot(
      projectRecord('project-reader-pin', 'First', 'r1'),
      await projectMutationOptions(writer, 'absent'),
    );
    const initialHead = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    const initialCommit = JSON.parse(await fs.readFile(
      path.join(root, 'commits', `${initialHead.commitId}.json`),
      'utf8',
    ));
    const initialProjectPath = path.join(
      root,
      initialCommit.projects[0].manifestPath.replace(/manifest\.json$/u, 'project.json'),
    );

    const originalOpen = fs.open;
    let blockProjectRead = true;
    let initialProjectOpens = 0;
    let signalReadStarted;
    const readStarted = new Promise((resolve) => { signalReadStarted = resolve; });
    const readMayContinue = new Promise((resolve) => { releaseRead = resolve; });
    fs.open = async (target, ...arguments_) => {
      if (path.resolve(target) === path.resolve(initialProjectPath) && arguments_[0] === 'r') {
        initialProjectOpens += 1;
      }
      if (blockProjectRead && initialProjectOpens === 2) {
        blockProjectRead = false;
        signalReadStarted();
        await readMayContinue;
      }
      return originalOpen(target, ...arguments_);
    };
    try {
      reading = reader.openProject('project-reader-pin');
      await readStarted;
      await writer.rename('project-reader-pin', 'Second', 3, await projectMutationOptions(writer, 'r1'));
      await writer.rename('project-reader-pin', 'Third', 4, await projectMutationOptions(writer, 'r2'));
      await cleaner.cleanupOrphans();
      assert.equal(await fs.stat(initialProjectPath).then(() => true).catch(() => false), true);

      releaseRead();
      assert.equal((await reading).name, 'First');
    } finally {
      releaseRead?.();
      await reading?.catch(() => {});
      fs.open = originalOpen;
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('holds new reader pins outside garbage-collection authorization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-reader-gate-'));
  let clockNow = Date.now();
  let releaseAuthorization;
  let signalAuthorization;
  const authorizationReached = new Promise((resolve) => { signalAuthorization = resolve; });
  try {
    const cleaner = createFileProjectLibrary({
      root,
      clock: () => clockNow,
      faultInjector: async (phase) => {
        if (phase === 'before-cleanup-authorize') {
          signalAuthorization();
          await new Promise((resolve) => { releaseAuthorization = resolve; });
        }
      },
    });
    const reader = createFileProjectLibrary({ root });
    await Promise.all([cleaner.open(), reader.open()]);
    const orphan = path.join(root, 'assets', 'a_cccccccccccccccccccccccccccccccc', 'orphan.bin');
    await fs.mkdir(path.dirname(orphan), { recursive: true });
    await fs.writeFile(orphan, Uint8Array.from([1, 2, 3]));
    clockNow += 1_000;
    await fs.utimes(orphan, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000);
    assert.equal((await cleaner.cleanupOrphans()).code, 'cleanup_planned');
    clockNow += THIRTY_DAYS_MS;

    const cleaning = cleaner.cleanupOrphans();
    await authorizationReached;
    let readerSettled = false;
    const reading = reader.listProjects().then((projects) => {
      readerSettled = true;
      return projects;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(readerSettled, false);

    releaseAuthorization();
    assert.equal((await cleaning).code, 'cleanup_complete');
    assert.deepEqual(await reading, []);
  } finally {
    releaseAuthorization?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('revalidates each authorized garbage-collection entry before unlinking it', async () => {
  for (const mode of ['digest', 'lease', 'conditional']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `lumina-file-library-gc-revalidate-${mode}-`));
    let clockNow = Date.now();
    let arm = false;
    const orphan = path.join(root, 'assets', 'a_dddddddddddddddddddddddddddddddd', 'orphan.bin');
    try {
      const library = createFileProjectLibrary({
        root,
        clock: () => clockNow,
        faultInjector: async (phase) => {
          if (!arm) return;
          if (mode === 'digest' && phase === 'after-cleanup-authorize') {
            await fs.writeFile(orphan, Uint8Array.from([9, 9, 9]));
          } else if (mode === 'lease' && phase === 'after-cleanup-authorize') {
            await fs.writeFile(path.join(root, '.library-write.lock'), `${process.pid}\n${Date.now()}\nreplacement-gc-lease\n`, 'utf8');
          } else if (mode === 'conditional' && phase === 'after-cleanup-revalidate') {
            await fs.writeFile(orphan, Uint8Array.from([9, 9, 9]));
          }
        },
      });
      await library.open();
      await fs.mkdir(path.dirname(orphan), { recursive: true });
      await fs.writeFile(orphan, Uint8Array.from([1, 2, 3]));
      await fs.utimes(orphan, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000);
      assert.equal((await library.cleanupOrphans()).code, 'cleanup_planned');
      clockNow += THIRTY_DAYS_MS;
      arm = true;

      if (mode === 'digest' || mode === 'conditional') {
        assert.equal((await library.cleanupOrphans()).code, 'cleanup_cancelled');
        assert.deepEqual(await fs.readFile(orphan), Buffer.from([9, 9, 9]));
      } else {
        await assert.rejects(library.cleanupOrphans(), (error) => error.code === 'lease_lost');
        assert.equal(await fs.stat(orphan).then(() => true).catch(() => false), true);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('retains a quarantine payload replaced after authorization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-quarantine-race-'));
  let crashPublication = false;
  try {
    const writer = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (crashPublication && phase === 'after-materialize') {
          throw new Error('quarantine-publication-crash');
        }
      },
    });
    await writer.open();
    await writer.saveSnapshot(
      projectRecord('project-quarantine-race', 'Quarantine race', 'r1'),
      await projectMutationOptions(writer, 'absent'),
    );
    crashPublication = true;
    await assert.rejects(
      writeOwnedAsset(writer, {
        assetId: 'asset-quarantine-race',
        projectId: 'project-quarantine-race',
        kind: 'image',
        sourceKind: 'import',
        blob: new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' }),
      }),
      /quarantine-publication-crash/u,
    );
    crashPublication = false;

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    const [transactionId] = await fs.readdir(path.join(root, 'quarantine'));
    const manifest = JSON.parse(await fs.readFile(
      path.join(root, 'quarantine', transactionId, 'manifest.json'),
      'utf8',
    ));
    const payload = manifest.retained.find((entry) => entry.path.endsWith('/bytes.bin'));
    assert.ok(payload);
    const replacement = Buffer.from([9, 9, 9]);
    let replaced = false;
    const cleaner = createFileProjectLibrary({
      root,
      clock: () => manifest.retainedUntil,
      faultInjector: async (phase, details) => {
        if (!replaced && phase === 'after-quarantine-cleanup-revalidate' && details.path === payload.path) {
          replaced = true;
          await fs.writeFile(path.join(root, payload.path), replacement);
        }
      },
    });
    await cleaner.open();

    await assert.rejects(cleaner.cleanupOrphans(), (error) => error.code === 'recovery_required');
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readFile(path.join(root, payload.path)), replacement);
    assert.equal(JSON.parse(await fs.readFile(
      path.join(root, 'quarantine', transactionId, 'cleanup.json'),
      'utf8',
    )).state, 'authorized');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resumes each cleanup plan crash state without deleting unlisted bytes', async () => {
  for (const crashPhase of ['before-cleanup-authorize', 'after-cleanup-authorize', 'after-cleanup-delete']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `lumina-file-library-cleanup-${crashPhase}-`));
    let armed = false;
    let clockNow = Date.now();
    try {
      const library = createFileProjectLibrary({
        root,
        clock: () => clockNow,
        faultInjector: async (phase) => {
          if (armed && phase === crashPhase) throw new Error(`cleanup-crash-${crashPhase}`);
        },
      });
      await library.open();
      const orphan = path.join(root, 'assets', 'a_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'orphan.bin');
      const unlisted = path.join(root, 'assets', 'a_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'unlisted.bin');
      await fs.mkdir(path.dirname(orphan), { recursive: true });
      await fs.writeFile(orphan, Uint8Array.from([1, 2, 3]));
      const now = Date.now() + 1_000;
      await fs.utimes(orphan, (now - THIRTY_DAYS_MS - 1_000) / 1_000, (now - THIRTY_DAYS_MS - 1_000) / 1_000);
      clockNow = now;
      assert.equal((await library.cleanupOrphans()).code, 'cleanup_planned');
      clockNow += THIRTY_DAYS_MS;
      armed = true;
      await assert.rejects(library.cleanupOrphans({ authorize: true }), /cleanup-crash/u);
      armed = false;
      await fs.writeFile(unlisted, Uint8Array.from([4, 5, 6]));
      const restarted = createFileProjectLibrary({ root, clock: () => clockNow + 1 });
      await restarted.open();
      const resumed = await restarted.cleanupOrphans({ authorize: true });
      assert.equal(resumed.code, 'cleanup_complete');
      assert.equal(await fs.stat(orphan).then(() => true).catch(() => false), false);
      assert.equal(await fs.stat(unlisted).then(() => true).catch(() => false), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
