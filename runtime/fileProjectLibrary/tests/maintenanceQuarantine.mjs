import { assert, assetLifecycleOptions, canonicalize, createAssetOwner, createFileProjectLibrary, createRawFileProjectLibrary, emptyTrashOptions, fs, os, path, projectMutationOptions, projectRecord, sha256, test, TEST_DURABLE_FILE_OPS, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';

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
