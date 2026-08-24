import { assert, assetLifecycleOptions, createAssetOwner, createFileProjectLibrary, emptyTrashOptions, fs, os, path, test, TEST_DURABLE_FILE_OPS, THIRTY_DAYS_MS, writeOwnedAsset } from './testSupport.mjs';

test('resumes an authorized trash cleanup after a source payload has been collected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-partial-restart-'));
  let expectedTrashRelative = null;
  let crashAfterUnlink = false;
  let crashed = false;
  try {
    const durableFileOps = {
      removeIfUnchanged: async (managedRoot, relative, expectedContents) => {
        const removed = await TEST_DURABLE_FILE_OPS.removeIfUnchanged(managedRoot, relative, expectedContents);
        if (crashAfterUnlink && !crashed && relative === expectedTrashRelative && removed) {
          crashed = true;
          throw new Error('trash-cleanup-after-unlink-crash');
        }
        return removed;
      },
    };
    const library = createFileProjectLibrary({ root, durableFileOps });
    await library.open();
    await createAssetOwner(library, 'project-trash-partial-restart');
    await writeOwnedAsset(library, {
      assetId: 'asset-trash-partial-restart',
      projectId: 'project-trash-partial-restart',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([2, 7, 1, 8])], { type: 'image/png' }),
    });
    await library.setDeletionCandidates(
      'project-trash-partial-restart',
      ['asset-trash-partial-restart'],
      await assetLifecycleOptions(library, 'project-trash-partial-restart', 'r1', ['asset-trash-partial-restart']),
    );
    const trashed = await library.cleanupOrphans();
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'trash', trashed.deletionId, 'manifest.json'), 'utf8'));
    expectedTrashRelative = path.normalize(manifest.assets[0].trashBytesPath);
    crashAfterUnlink = true;

    await assert.rejects(
      library.cleanupOrphans(await emptyTrashOptions(root, trashed.deletionId)),
      /trash-cleanup-after-unlink-crash/u,
    );
    assert.equal(crashed, true);
    await fs.rm(path.join(root, manifest.assets[0].bytesPath));

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    assert.deepEqual(await restarted.cleanupOrphans(), {
      code: 'trash_empty_cancelled',
      deletionId: trashed.deletionId,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fails closed when a final maintenance directory removal sees an ancestor swap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-maintenance-directory-race-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-maintenance-directory-outside-'));
  let expectedRelative = null;
  let removalCalls = 0;
  try {
    const durableFileOps = {
      removeDirectoryManaged: async (managedRoot, relative) => {
        if (relative !== expectedRelative) {
          return TEST_DURABLE_FILE_OPS.removeDirectoryManaged(managedRoot, relative);
        }
        removalCalls += 1;
        const target = path.join(managedRoot, relative);
        const parent = path.dirname(target);
        const backup = `${parent}-before-swap`;
        const outsideTarget = path.join(outside, path.basename(target));
        await fs.mkdir(outsideTarget, { recursive: true });
        await fs.rename(parent, backup);
        await fs.symlink(outside, parent, 'junction');
        await fs.rm(parent, { recursive: true, force: true });
        await fs.rename(backup, parent);
        assert.equal(await fs.stat(outsideTarget).then(() => true).catch(() => false), true);
        return false;
      },
    };
    let clockNow = Date.now();
    const library = createFileProjectLibrary({ root, durableFileOps, clock: () => clockNow });
    await library.open();
    const orphan = path.join(root, 'assets', 'a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'orphan.bin');
    await fs.mkdir(path.dirname(orphan), { recursive: true });
    await fs.writeFile(orphan, Uint8Array.from([1, 2, 3]));
    await fs.utimes(orphan, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000, (clockNow - THIRTY_DAYS_MS - 1_000) / 1_000);

    const planned = await library.cleanupOrphans();
    clockNow = planned.notBefore;
    assert.equal((await library.cleanupOrphans()).code, 'cleanup_complete');
    expectedRelative = path.join('maintenance', planned.transactionId);
    clockNow += THIRTY_DAYS_MS;

    await assert.rejects(library.cleanupOrphans(), (error) => error.code === 'recovery_required');
    assert.equal(removalCalls, 1);
    assert.equal(await fs.stat(path.join(outside, planned.transactionId)).then(() => true).catch(() => false), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('fails closed when a final quarantine directory removal sees an ancestor swap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-quarantine-directory-race-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-quarantine-directory-outside-'));
  let crashPublication = false;
  let expectedRelative = null;
  let removalCalls = 0;
  try {
    const writer = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (crashPublication && phase === 'after-materialize') throw new Error('quarantine-directory-crash');
      },
    });
    await writer.open();
    await createAssetOwner(writer, 'project-quarantine-directory-race');
    crashPublication = true;
    await assert.rejects(
      writeOwnedAsset(writer, {
        assetId: 'asset-quarantine-directory-race',
        projectId: 'project-quarantine-directory-race',
        kind: 'image',
        sourceKind: 'import',
        blob: new Blob([Uint8Array.from([3, 1, 4])], { type: 'image/png' }),
      }),
      /quarantine-directory-crash/u,
    );
    crashPublication = false;

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    const [transactionId] = await fs.readdir(path.join(root, 'quarantine'));
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'quarantine', transactionId, 'manifest.json'), 'utf8'));
    let clockNow = manifest.retainedUntil;
    const cleaner = createFileProjectLibrary({ root, clock: () => clockNow });
    await cleaner.open();
    assert.equal((await cleaner.cleanupOrphans()).code, 'quarantine_cleanup_complete');
    const cleanup = JSON.parse(await fs.readFile(path.join(root, 'quarantine', transactionId, 'cleanup.json'), 'utf8'));
    expectedRelative = path.join('quarantine', transactionId);
    clockNow = cleanup.retainedUntil;

    const expirer = createFileProjectLibrary({
      root,
      clock: () => clockNow,
      durableFileOps: {
        removeDirectoryManaged: async (managedRoot, relative) => {
          if (relative !== expectedRelative) {
            return TEST_DURABLE_FILE_OPS.removeDirectoryManaged(managedRoot, relative);
          }
          removalCalls += 1;
          const target = path.join(managedRoot, relative);
          const parent = path.dirname(target);
          const backup = `${parent}-before-swap`;
          const outsideTarget = path.join(outside, path.basename(target));
          await fs.mkdir(outsideTarget, { recursive: true });
          await fs.rename(parent, backup);
          await fs.symlink(outside, parent, 'junction');
          await fs.rm(parent, { recursive: true, force: true });
          await fs.rename(backup, parent);
          assert.equal(await fs.stat(outsideTarget).then(() => true).catch(() => false), true);
          return false;
        },
      },
    });
    await expirer.open();

    await assert.rejects(expirer.cleanupOrphans(), (error) => error.code === 'recovery_required');
    assert.equal(removalCalls, 1);
    assert.equal(await fs.stat(path.join(outside, transactionId)).then(() => true).catch(() => false), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
