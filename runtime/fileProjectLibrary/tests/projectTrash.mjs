import { assert, createFileProjectLibrary, fs, os, path, projectDeleteOptions, projectMutationOptions, projectRecord, projectRestoreOptions, sha256, test, writeOwnedAsset } from './testSupport.mjs';

async function createDeletedProject(library, projectId) {
  await library.saveSnapshot(
    projectRecord(projectId, 'Deleted project', 'r1'),
    await projectMutationOptions(library, 'absent'),
  );
  const assetId = `${projectId}-asset`;
  await writeOwnedAsset(library, {
    assetId,
    projectId,
    kind: 'image',
    sourceKind: 'import',
    blob: new Blob([Uint8Array.from([7, 5, 3])], { type: 'image/png' }),
  });
  await library.saveSnapshot({
    ...projectRecord(projectId, 'Deleted project', 'r1'),
    nodesJson: JSON.stringify({
      nodes: [{
        id: 'image-1',
        type: 'imageNode',
        position: { x: 0, y: 0 },
        data: {
          assetId,
          aspectRatio: '1:1',
          prompt: 'fixture',
          model: 'fixture-model',
          size: '1K',
        },
      }],
      imagePool: [],
    }),
    nodeCount: 1,
  }, await projectMutationOptions(library, 'r1'));
  const deleted = await library.deleteProject(projectId, await projectDeleteOptions(library, projectId, 'r2'));
  return { assetId, deleted };
}

test('requires an authenticated catalog-bound context before deleting or restoring a project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-project-delete-context-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-delete-context', 'Protected project', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );

    await assert.rejects(
      library.deleteProject('project-delete-context', await projectMutationOptions(library, 'r1')),
      (error) => error.code === 'target_delete_authorization_required',
    );
    assert.equal((await library.openProject('project-delete-context')).name, 'Protected project');

    const deleted = await library.deleteProject(
      'project-delete-context',
      await projectDeleteOptions(library, 'project-delete-context', 'r1'),
    );
    await assert.rejects(
      library.restoreProject(
        'project-delete-context',
        deleted.deletionId,
        deleted.trashManifestSha256,
        await projectMutationOptions(library, 'absent'),
      ),
      (error) => error.code === 'target_delete_authorization_required',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deletes a project through a durable trash manifest and restores its snapshot and asset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-project-trash-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const { assetId, deleted } = await createDeletedProject(library, 'project-trash-restore');

    const manifestBytes = await fs.readFile(path.join(root, 'trash', deleted.deletionId, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.project.projectId, 'project-trash-restore');
    assert.equal(manifest.project.payloads.some((entry) => entry.path.endsWith('/project.json')), true);
    assert.equal(manifest.project.payloads.some((entry) => entry.path.endsWith('/history.json')), true);
    assert.equal(manifest.project.assets[0].assetId, assetId);
    assert.equal(deleted.trashManifestSha256, sha256(manifestBytes));
    assert.equal(await library.openProject('project-trash-restore'), null);

    const restored = await library.restoreProject(
      'project-trash-restore',
      deleted.deletionId,
      deleted.trashManifestSha256,
      await projectRestoreOptions(library, 'project-trash-restore', deleted.deletionId, deleted.trashManifestSha256),
    );
    assert.deepEqual(restored, {
      code: 'restored',
      projectId: 'project-trash-restore',
      revision: 'r2',
      catalog: restored.catalog,
    });
    assert.equal((await library.openProject('project-trash-restore')).name, 'Deleted project');
    assert.equal((await library.getAssetMetadata(assetId)).lifecycleState, 'active');
    assert.deepEqual(
      [...new Uint8Array(await (await library.readAsset(assetId)).arrayBuffer())],
      [7, 5, 3],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('restores a deleted project to a deterministic collision-free project ID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-project-restore-collision-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const { deleted } = await createDeletedProject(library, 'project-trash-collision');
    await library.saveSnapshot(
      projectRecord('project-trash-collision', 'Occupying project', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );

    const restored = await library.restoreProject(
      'project-trash-collision',
      deleted.deletionId,
      deleted.trashManifestSha256,
      await projectRestoreOptions(library, 'project-trash-collision', deleted.deletionId, deleted.trashManifestSha256),
    );
    assert.equal(restored.projectId, 'project-trash-collision-restored-1');
    assert.equal((await library.openProject('project-trash-collision')).name, 'Occupying project');
    assert.equal((await library.openProject('project-trash-collision-restored-1')).name, 'Deleted project');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('replays completed project-delete and project-restore commands after later catalog publications', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-project-trash-command-replay-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-trash-command-replay', 'Replayable project', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    const deleteOptions = await projectDeleteOptions(library, 'project-trash-command-replay', 'r1');
    const deleted = await library.deleteProject('project-trash-command-replay', deleteOptions);
    await library.saveSnapshot(
      projectRecord('project-trash-command-other-delete', 'Later publication', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    assert.deepEqual(
      await library.deleteProject('project-trash-command-replay', deleteOptions),
      deleted,
    );

    const restoreOptions = await projectRestoreOptions(
      library,
      'project-trash-command-replay',
      deleted.deletionId,
      deleted.trashManifestSha256,
    );
    const restored = await library.restoreProject(
      'project-trash-command-replay',
      deleted.deletionId,
      deleted.trashManifestSha256,
      restoreOptions,
    );
    await library.saveSnapshot(
      projectRecord('project-trash-command-other-restore', 'Later publication', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    assert.deepEqual(
      await library.restoreProject(
        'project-trash-command-replay',
        deleted.deletionId,
        deleted.trashManifestSha256,
        restoreOptions,
      ),
      restored,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recovers a project-restore command interrupted after its catalog head is published', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-project-restore-command-crash-'));
  let crash = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase, details) => {
        if (crash && phase === 'after-head' && details.operation === 'project-restore') {
          throw new Error('simulated-project-restore-after-head');
        }
      },
    });
    await library.open();
    const { deleted } = await createDeletedProject(library, 'project-trash-restore-crash');
    const restoreOptions = await projectRestoreOptions(
      library,
      'project-trash-restore-crash',
      deleted.deletionId,
      deleted.trashManifestSha256,
    );
    crash = true;
    await assert.rejects(
      library.restoreProject(
        'project-trash-restore-crash',
        deleted.deletionId,
        deleted.trashManifestSha256,
        restoreOptions,
      ),
      /simulated-project-restore-after-head/u,
    );
    crash = false;

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    const replayed = await restarted.restoreProject(
      'project-trash-restore-crash',
      deleted.deletionId,
      deleted.trashManifestSha256,
      restoreOptions,
    );
    assert.equal(replayed.code, 'restored');
    assert.equal((await restarted.openProject(replayed.projectId)).name, 'Deleted project');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resumes a pending project-restore publication interrupted before its catalog head', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-project-restore-pending-'));
  let crash = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase, details) => {
        if (crash && phase === 'before-head' && details.operation === 'project-restore') {
          throw new Error('simulated-project-restore-before-head');
        }
      },
    });
    await library.open();
    const { deleted } = await createDeletedProject(library, 'project-trash-restore-pending');
    const restoreOptions = await projectRestoreOptions(
      library,
      'project-trash-restore-pending',
      deleted.deletionId,
      deleted.trashManifestSha256,
    );
    crash = true;
    await assert.rejects(
      library.restoreProject(
        'project-trash-restore-pending',
        deleted.deletionId,
        deleted.trashManifestSha256,
        restoreOptions,
      ),
      /simulated-project-restore-before-head/u,
    );
    crash = false;

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    const replayed = await restarted.restoreProject(
      'project-trash-restore-pending',
      deleted.deletionId,
      deleted.trashManifestSha256,
      restoreOptions,
    );
    assert.equal(replayed.code, 'restored');
    assert.equal((await restarted.openProject(replayed.projectId)).name, 'Deleted project');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keeps a project live or restores it from trash across project-delete crash boundaries', async () => {
  for (const phase of ['before-project-trash-manifest', 'after-project-trash-manifest', 'after-project-trash-head']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `lumina-file-library-project-trash-${phase}-`));
    let crash = false;
    try {
      const library = createFileProjectLibrary({
        root,
        faultInjector: async (actualPhase) => {
          if (crash && actualPhase === phase) throw new Error(`simulated-${phase}`);
        },
      });
      await library.open();
      await library.saveSnapshot(
        projectRecord('project-trash-crash', 'Crash-safe project', 'r1'),
        await projectMutationOptions(library, 'absent'),
      );
      const deleteOptions = await projectDeleteOptions(library, 'project-trash-crash', 'r1');
      crash = true;
      await assert.rejects(
        library.deleteProject('project-trash-crash', deleteOptions),
        new RegExp(`simulated-${phase}`, 'u'),
      );
      crash = false;

      const restarted = createFileProjectLibrary({ root });
      await restarted.open();
      const live = await restarted.openProject('project-trash-crash');
      if (phase === 'before-project-trash-manifest') {
        assert.equal(live.name, 'Crash-safe project');
        continue;
      }
      assert.equal(live, null);
      const deletionId = (await fs.readdir(path.join(root, 'trash'))).find((entry) => entry.startsWith('d_'));
      const manifestBytes = await fs.readFile(path.join(root, 'trash', deletionId, 'manifest.json'));
      const replayed = await restarted.deleteProject('project-trash-crash', deleteOptions);
      assert.equal(replayed.code, 'deleted');
      assert.equal(replayed.deletionId, deletionId);
      const restored = await restarted.restoreProject(
        'project-trash-crash',
        deletionId,
        sha256(manifestBytes),
        await projectRestoreOptions(restarted, 'project-trash-crash', deletionId, sha256(manifestBytes)),
      );
      assert.equal(restored.projectId, 'project-trash-crash');
      assert.equal((await restarted.openProject('project-trash-crash')).name, 'Crash-safe project');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
