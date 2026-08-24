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

    assert.equal((await library.cleanupOrphans(await emptyTrashOptions(library, root, trashed.deletionId))).code, 'trash_empty_complete');
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
      (error) => error.code === 'runtime_command_context_required',
    );
    const mismatched = await emptyTrashOptions(library, root, trashed.deletionId);
    mismatched.emptyTrash.trashManifestSha256 = '0'.repeat(64);
    await assert.rejects(
      library.cleanupOrphans(mismatched),
      (error) => error.code === 'command_body_mismatch',
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
      testRuntimeCommandAuthorizationVerifier: async () => null,
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
      emptyTrashOptions(library, root, trashed.deletionId),
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
      library.cleanupOrphans(await emptyTrashOptions(library, root, trashed.deletionId)),
      /trash-cleanup-authorized-crash/u,
    );
    const cleanupPath = path.join(root, 'trash', trashed.deletionId, 'cleanup.json');
    assert.equal(JSON.parse(await fs.readFile(cleanupPath, 'utf8')).state, 'authorized');

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    assert.deepEqual(await restarted.cleanupOrphans(), {
      code: 'trash_empty_complete',
      deletionId: trashed.deletionId,
    });
    assert.equal(JSON.parse(await fs.readFile(cleanupPath, 'utf8')).state, 'complete');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retries its pending empty-trash receipt after authorization expiry without orphan recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-command-retry-'));
  let crashAfterAuthorization = true;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (crashAfterAuthorization && phase === 'after-trash-cleanup-authorized') {
          crashAfterAuthorization = false;
          throw new Error('trash-cleanup-command-retry-crash');
        }
      },
    });
    await library.open();
    await createAssetOwner(library, 'project-trash-command-retry');
    await writeOwnedAsset(library, {
      assetId: 'asset-trash-command-retry',
      projectId: 'project-trash-command-retry',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([2, 7, 1, 8])], { type: 'image/png' }),
    });
    await library.setDeletionCandidates(
      'project-trash-command-retry',
      ['asset-trash-command-retry'],
      await assetLifecycleOptions(library, 'project-trash-command-retry', 'r1', ['asset-trash-command-retry']),
    );
    const trashed = await library.cleanupOrphans();
    const selection = await emptyTrashOptions(library, root, trashed.deletionId);

    await assert.rejects(
      library.cleanupOrphans(selection),
      /trash-cleanup-command-retry-crash/u,
    );
    const ledgerPath = path.join(root, 'control', 'runtime-command-ledger.json');
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    ledger.entries.find((entry) => entry.commandId === selection.emptyTrash.context.commandId).authorizationExpiresAt = 0;
    await fs.writeFile(ledgerPath, canonicalize(ledger), 'utf8');

    await emptyTrashOptions(library, root, trashed.deletionId);
    assert.deepEqual(await library.cleanupOrphans(selection), {
      code: 'trash_empty_complete',
      deletionId: trashed.deletionId,
    });
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

    assert.deepEqual(await library.cleanupOrphans(await emptyTrashOptions(library, root, trashed.deletionId)), {
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

test('cancels empty-trash when its catalog root changes after authorization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-root-change-'));
  let crashAfterAuthorization = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (crashAfterAuthorization && phase === 'after-trash-cleanup-authorized') {
          crashAfterAuthorization = false;
          throw new Error('trash-cleanup-root-change-crash');
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
    const selection = await emptyTrashOptions(library, root, trashed.deletionId);
    crashAfterAuthorization = true;

    await assert.rejects(
      library.cleanupOrphans(selection),
      /trash-cleanup-root-change-crash/u,
    );
    await library.saveSnapshot(
      projectRecord('project-trash-root-change-followup', 'Follow-up', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );

    assert.deepEqual(await library.cleanupOrphans(selection), {
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
