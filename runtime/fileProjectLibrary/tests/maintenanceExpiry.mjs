import { assert, assetLifecycleOptions, canonicalize, createAssetOwner, createFileProjectLibrary, createRawFileProjectLibrary, emptyTrashOptions, fs, os, path, projectMutationOptions, projectRecord, sha256, test, TEST_DURABLE_FILE_OPS, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';

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
    await library.cleanupOrphans(await emptyTrashOptions(library, root, trashed.deletionId));

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
