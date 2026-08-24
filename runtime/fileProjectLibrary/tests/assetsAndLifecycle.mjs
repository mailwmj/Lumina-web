import { assert, canonicalize, createAssetOwner, createFileProjectLibrary, createRawFileProjectLibrary, fs, os, path, projectRecord, sha256, test, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';

test('writes asset metadata and bytes with stable integrity checks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await createAssetOwner(library, 'project-asset');
    const result = await writeOwnedAsset(library, {
      assetId: 'asset-1',
      projectId: 'project-asset',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'image/png' }),
      width: 2,
      height: 2,
      sourceMetadata: { fileName: 'fixture.png', isReference: true, version: 1 },
    });
    assert.equal(result.code, 'applied');
    assert.deepEqual(await library.getAssetMetadata('asset-1'), {
      assetId: 'asset-1',
      projectId: 'project-asset',
      kind: 'image',
      mimeType: 'image/png',
      byteCount: 4,
      createdAt: result.metadata.createdAt,
      sourceKind: 'import',
      width: 2,
      height: 2,
      durationMs: null,
      sourceMetadata: { fileName: 'fixture.png', isReference: true, version: 1 },
      lifecycleState: 'active',
    });
    const bytes = new Uint8Array(await (await library.readAsset('asset-1')).arrayBuffer());
    assert.deepEqual([...bytes], [1, 2, 3, 4]);

    await assert.rejects(
      writeOwnedAsset(library, {
        assetId: 'bad-media',
        projectId: 'project-asset',
        kind: 'image',
        sourceKind: 'import',
        blob: new Blob(['not an image'], { type: 'video/mp4' }),
      }),
      (error) => error.code === 'unsupported_media_type',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('fences direct asset writes to a pinned existing project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-asset-fence-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const project = projectRecord('project-asset-fence', 'Asset fence', 'r1');
    const saved = await library.saveSnapshot(project, { expectedRevision: 'absent' });
    const input = {
      assetId: 'asset-fence',
      projectId: project.id,
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' }),
    };
    const headBefore = await fs.readFile(path.join(root, 'head.json'));

    await assert.rejects(
      library.writeAsset(input),
      (error) => error.code === 'asset_precondition_required',
    );
    assert.deepEqual(await fs.readFile(path.join(root, 'head.json')), headBefore);

    await assert.rejects(
      library.writeAsset(
        { ...input, assetId: 'asset-missing-owner', projectId: 'project-missing-owner' },
        { expectedCatalog: saved.catalog, expectedProjectRevision: 'absent' },
      ),
      (error) => error.code === 'asset_owner_missing',
    );

    const written = await library.writeAsset(input, {
      expectedCatalog: saved.catalog,
      expectedProjectRevision: project.revision,
    });
    assert.equal(written.code, 'applied');
    assert.equal((await library.getAssetMetadata(input.assetId)).projectId, project.id);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stages Blob bytes through its stream without whole-buffer reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-stream-'));
  try {
    class StreamingBlob extends Blob {
      arrayBuffer() {
        throw new Error('whole-buffer read is forbidden');
      }
    }
    const library = createFileProjectLibrary({ root });
    await library.open();
    await createAssetOwner(library, 'project-stream');
    const result = await writeOwnedAsset(library, {
      assetId: 'asset-stream',
      projectId: 'project-stream',
      kind: 'image',
      sourceKind: 'import',
      blob: new StreamingBlob([Uint8Array.from([11, 12, 13])], { type: 'image/png' }),
    });
    assert.equal(result.code, 'applied');
    assert.deepEqual(
      [...new Uint8Array(await (await library.readAsset('asset-stream')).arrayBuffer())],
      [11, 12, 13],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('publishes deletion-candidate metadata without deleting shared bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await createAssetOwner(library, 'project-candidate');
    await writeOwnedAsset(library, {
      assetId: 'asset-candidate',
      projectId: 'project-candidate',
      kind: 'image',
      sourceKind: 'derived',
      blob: new Blob([Uint8Array.from([6, 7, 8])], { type: 'image/png' }),
    });
    const applied = await library.setDeletionCandidates('project-candidate', ['asset-candidate']);
    assert.equal(applied.code, 'applied');
    assert.deepEqual((await library.listDeletionCandidates('project-candidate')).map((item) => item.assetId), ['asset-candidate']);
    assert.equal((await library.getAssetMetadata('asset-candidate')).lifecycleState, 'deletion-candidate');
    assert.deepEqual(
      [...new Uint8Array(await (await library.readAsset('asset-candidate')).arrayBuffer())],
      [6, 7, 8],
    );
    await library.setDeletionCandidates('project-candidate', []);
    assert.deepEqual(await library.listDeletionCandidates('project-candidate'), []);
    assert.equal((await library.getAssetMetadata('asset-candidate')).lifecycleState, 'active');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects stale asset lifecycle sets instead of erasing a concurrent candidate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-asset-cas-'));
  try {
    const first = createFileProjectLibrary({ root });
    const second = createFileProjectLibrary({ root });
    await Promise.all([first.open(), second.open()]);
    await createAssetOwner(first, 'project-asset-cas');
    for (const assetId of ['asset-cas-a', 'asset-cas-b']) {
      await writeOwnedAsset(first, {
        assetId,
        projectId: 'project-asset-cas',
        kind: 'image',
        sourceKind: 'import',
        blob: new Blob([Uint8Array.from([assetId.endsWith('a') ? 1 : 2])], { type: 'image/png' }),
      });
    }
    const expectedAssets = [];
    for (const assetId of ['asset-cas-a', 'asset-cas-b']) {
      const metadata = await first.getAssetMetadata(assetId);
      expectedAssets.push({
        assetId,
        lifecycleState: metadata.lifecycleState,
        metadataSha256: sha256(canonicalize({
          format: 'lumina-library-asset-metadata',
          version: 1,
          metadata,
        })),
      });
    }
    const firstResult = await first.setDeletionCandidates(
      'project-asset-cas',
      ['asset-cas-a'],
      { expectedRevision: 'r1', expectedAssets },
    ).catch((error) => error);
    assert.equal(firstResult.code, 'applied');
    await assert.rejects(
      second.setDeletionCandidates(
        'project-asset-cas',
        ['asset-cas-b'],
        { expectedRevision: 'r1', expectedAssets },
      ),
      (error) => error.code === 'stale_asset_lifecycle',
    );
    assert.equal((await first.getAssetMetadata('asset-cas-a')).lifecycleState, 'deletion-candidate');
    assert.equal((await first.getAssetMetadata('asset-cas-b')).lifecycleState, 'active');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('project deletion leaves owned asset bytes recoverable as candidates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(projectRecord('project-delete-assets', 'Delete me', 'r1'), { expectedRevision: 'absent' });
    await writeOwnedAsset(library, {
      assetId: 'asset-delete-assets',
      projectId: 'project-delete-assets',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([3, 2, 1])], { type: 'image/png' }),
    });
    await library.delete('project-delete-assets', { expectedRevision: 'r1' });
    assert.equal(await library.openProject('project-delete-assets'), null);
    assert.equal((await library.getAssetMetadata('asset-delete-assets')).lifecycleState, 'deletion-candidate');
    assert.deepEqual(
      [...new Uint8Array(await (await library.readAsset('asset-delete-assets')).arrayBuffer())],
      [3, 2, 1],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('project deletion candidates include assets referenced only by the deleted project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-delete-references-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await createAssetOwner(library, 'project-delete-reference');
    await writeOwnedAsset(library, {
      assetId: 'asset-delete-reference',
      projectId: 'project-delete-reference',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([5, 4, 3])], { type: 'image/png' }),
    });
    await library.saveSnapshot({
      ...projectRecord('project-delete-reference', 'Delete referenced', 'r1'),
      nodesJson: JSON.stringify({
        nodes: [{
          id: 'image-1',
          type: 'imageNode',
          position: { x: 0, y: 0 },
          data: {
            assetId: 'asset-delete-reference',
            aspectRatio: '1:1',
            prompt: 'fixture',
            model: 'fixture-model',
            size: '1K',
          },
        }],
        imagePool: [],
      }),
      nodeCount: 1,
    }, { expectedRevision: 'r1' });
    await library.deleteProject('project-delete-reference', { expectedRevision: 'r2' });
    assert.equal((await library.getAssetMetadata('asset-delete-reference')).lifecycleState, 'deletion-candidate');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keeps committed asset bytes when a later project publication fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-'));
  let failPublication = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (failPublication && phase === 'before-head') throw new Error('simulated disk-full');
      },
    });
    await library.open();
    await createAssetOwner(library, 'project-survives');
    await writeOwnedAsset(library, {
      assetId: 'asset-survives',
      projectId: 'project-survives',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([9, 8, 7])], { type: 'image/png' }),
    });
    failPublication = true;
    await assert.rejects(
      library.saveSnapshot(projectRecord('project-survives', 'Failed snapshot', 'r1'), { expectedRevision: 'r1' }),
      /simulated disk-full/u,
    );

    const recovered = createFileProjectLibrary({ root });
    await recovered.open();
    assert.deepEqual(
      [...new Uint8Array(await (await recovered.readAsset('asset-survives')).arrayBuffer())],
      [9, 8, 7],
    );
    assert.equal((await recovered.openProject('project-survives')).name, 'Asset owner project-survives');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keeps logical IDs out of filesystem paths and rejects corrupt schemas', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const traversalId = '../outside-project';
    await library.saveSnapshot(projectRecord(traversalId, 'Traversal-safe', 'r1'), { expectedRevision: 'absent' });
    await writeOwnedAsset(library, {
      assetId: '../../outside-asset',
      projectId: traversalId,
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([1])], { type: 'image/png' }),
    });
    assert.ok(await library.openProject(traversalId));
    assert.equal(await fs.stat(path.join(root, '..', 'outside-project')).catch(() => null), null);
    assert.equal(await fs.stat(path.join(root, '..', 'outside-asset')).catch(() => null), null);

    assert.throws(() => validateLibraryKey('../escape'), (error) => error.code === 'invalid_library_key');
    assert.throws(() => validateLibraryKey('p_ABC'), (error) => error.code === 'invalid_library_key');

    const headPath = path.join(root, 'head.json');
    const priorHead = await fs.readFile(path.join(root, 'head.previous.json'));
    await fs.writeFile(headPath, '{"version":1,"format":"broken"}', 'utf8');
    const recovered = createFileProjectLibrary({ root });
    await recovered.open();
    assert.ok(await recovered.openProject(traversalId));
    assert.equal(await recovered.getAssetMetadata('../../outside-asset'), null);
    assert.deepEqual(await fs.readFile(headPath), priorHead);

    await fs.writeFile(headPath, '{"version":1}', 'utf8');
    await fs.writeFile(path.join(root, 'head.previous.json'), '{"version":1}', 'utf8');
    const unrecoverable = createFileProjectLibrary({ root });
    await assert.rejects(unrecoverable.open(), (error) => error.code === 'recovery_required');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
