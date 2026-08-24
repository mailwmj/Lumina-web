import { assert, canonicalize, createAssetOwner, createFileProjectLibrary, createProductionFileProjectLibrary, createRawFileProjectLibrary, fs, os, path, projectMutationOptions, projectRecord, sha256, test, TEST_DURABLE_FILE_OPS, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';
import { materializeTransactionPayloads } from '../publication.mjs';

async function replaceWithJunction(directory, outside, backup) {
  await fs.rename(directory, backup);
  await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
}

test('fails closed when an ancestor is swapped after directory validation', async (t) => {
  if (!['win32', 'darwin'].includes(process.platform)) t.skip('production DurableFileOps is platform-specific');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-mkdir-race-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-mkdir-race-outside-'));
  const backup = `${root}-moved`;
  let arm = false;
  let swapped = false;
  try {
    const library = createProductionFileProjectLibrary({
      root,
      faultInjector: async (phase, details) => {
        if (!arm || swapped || phase !== 'before-secure-mkdir' || !details.relative.startsWith('staging/')) return;
        const parent = path.dirname(details.target);
        if (path.resolve(parent) === path.resolve(root)) return;
        const parentStat = await fs.lstat(parent).catch(() => null);
        if (!parentStat?.isDirectory()) return;
        await replaceWithJunction(parent, outside, backup);
        swapped = true;
      },
    });
    await library.open();
    arm = true;
    await assert.rejects(
      library.saveSnapshot(
        projectRecord('project-mkdir-race', 'Mkdir race', 'r1'),
        await projectMutationOptions(library, 'absent'),
      ),
      (error) => error.code === 'path_escape',
    );
    assert.equal(swapped, true);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(backup, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('fails closed when an ancestor is swapped before atomic head replacement', async (t) => {
  if (!['win32', 'darwin'].includes(process.platform)) t.skip('production DurableFileOps is platform-specific');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-replace-race-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-replace-race-outside-'));
  const backup = `${root}-moved`;
  let arm = false;
  let swapped = false;
  try {
    const library = createProductionFileProjectLibrary({
      root,
      faultInjector: async (phase, details) => {
        if (!arm || swapped || phase !== 'before-secure-replace' || path.basename(details.target) !== 'head.json') return;
        await replaceWithJunction(root, outside, backup);
        swapped = true;
      },
    });
    await library.open();
    arm = true;
    await assert.rejects(
      library.saveSnapshot(
        projectRecord('project-replace-race', 'Replace race', 'r1'),
        await projectMutationOptions(library, 'absent'),
      ),
      (error) => error.code === 'path_escape',
    );
    assert.equal(swapped, true);
    assert.equal(await fs.stat(path.join(outside, 'head.json')).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(backup, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('rejects a replacement source leaf swapped to a reparse point at the native boundary', async (t) => {
  if (!['win32', 'darwin'].includes(process.platform)) t.skip('production DurableFileOps is platform-specific');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-replace-leaf-race-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-replace-leaf-race-outside-'));
  let arm = false;
  let swapped = false;
  try {
    const library = createProductionFileProjectLibrary({
      root,
      faultInjector: async (phase, details) => {
        if (!arm || swapped || phase !== 'before-secure-replace' || path.basename(details.target) !== 'head.json') return;
        await fs.rm(details.temporary, { force: true });
        try {
          await fs.symlink(outside, details.temporary, process.platform === 'win32' ? 'junction' : 'dir');
          swapped = true;
        } catch (error) {
          if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
            t.skip('reparse-point creation is unavailable in this environment');
            return;
          }
          throw error;
        }
      },
    });
    await library.open();
    arm = true;
    await assert.rejects(
      library.saveSnapshot(
        projectRecord('project-replace-leaf-race', 'Replace leaf race', 'r1'),
        await projectMutationOptions(library, 'absent'),
      ),
      (error) => error.code === 'path_escape',
    );
    assert.equal(swapped, true);
    assert.equal(await fs.stat(path.join(outside, 'head.json')).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('fails closed when a quarantine-copy ancestor is swapped after validation', async (t) => {
  if (!['win32', 'darwin'].includes(process.platform)) t.skip('production DurableFileOps is platform-specific');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-copy-race-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-copy-race-outside-'));
  let crashPublication = true;
  let backup = null;
  try {
    const writer = createProductionFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (crashPublication && phase === 'after-materialize') throw new Error('copy-race-publication-crash');
      },
    });
    await writer.open();
    await assert.rejects(
      writer.saveSnapshot(
        projectRecord('project-copy-race', 'Copy race', 'r1'),
        await projectMutationOptions(writer, 'absent'),
      ),
      /copy-race-publication-crash/u,
    );
    crashPublication = false;
    let swapped = false;
    const restarted = createProductionFileProjectLibrary({
      root,
      faultInjector: async (phase, details) => {
        if (swapped || phase !== 'before-secure-quarantine-copy') return;
        const parent = path.dirname(details.targetPath);
        backup = `${parent}-moved`;
        await replaceWithJunction(parent, outside, backup);
        swapped = true;
      },
    });
    await assert.rejects(restarted.open(), (error) => error.code === 'path_escape');
    assert.equal(swapped, true);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    if (backup) await fs.rm(backup, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('fails closed when a trash-audit directory ancestor is swapped before removal', async (t) => {
  if (!['win32', 'darwin'].includes(process.platform)) t.skip('production DurableFileOps is platform-specific');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-remove-race-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-trash-remove-race-outside-'));
  const deletionId = `d_${'a'.repeat(32)}`;
  const trashRoot = path.join(root, 'trash');
  const backup = `${trashRoot}-moved`;
  let clockNow = Date.now();
  let arm = false;
  let swapped = false;
  try {
    const library = createProductionFileProjectLibrary({
      root,
      clock: () => clockNow,
      faultInjector: async (phase, details) => {
        if (!arm || swapped || phase !== 'before-secure-remove-directory' || path.resolve(details.target) !== path.resolve(path.join(root, 'trash', deletionId))) return;
        await replaceWithJunction(trashRoot, outside, backup);
        swapped = true;
      },
    });
    await library.open();
    await fs.mkdir(path.join(root, 'trash', deletionId), { recursive: true });
    await fs.mkdir(path.join(outside, deletionId), { recursive: true });
    const completedAt = clockNow - THIRTY_DAYS_MS;
    await fs.writeFile(path.join(root, 'trash', deletionId, 'expiry.json'), canonicalize({
      format: 'lumina-library-trash-expiry',
      version: 1,
      deletionId,
      trashManifestSha256: '1'.repeat(64),
      cleanupSha256: '2'.repeat(64),
      terminalRootSetSha256: '3'.repeat(64),
      authorizedAt: completedAt,
      state: 'complete',
      completedAt,
      retainedUntil: clockNow,
    }), 'utf8');

    arm = true;
    await assert.rejects(library.cleanupOrphans(), (error) => error.code === 'path_escape');
    assert.equal(swapped, true);
    assert.equal(await fs.stat(path.join(outside, deletionId)).then(() => true).catch(() => false), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(backup, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('rejects a junctioned immutable publication target before hashing it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-publication-path-safety-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-publication-path-safety-outside-'));
  const originalOpen = fs.open;
  const transactionId = 't_' + '1'.repeat(32);
  const commitId = 'c_' + '2'.repeat(32);
  try {
    const stagingRoot = path.join(root, 'staging', transactionId);
    const sourcePath = path.join(stagingRoot, 'commits', commitId + '.json');
    const targetDirectory = path.join(root, 'commits');
    const targetPath = path.join(targetDirectory, commitId + '.json');
    const payload = Buffer.from('{"format":"test"}');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, payload);
    await fs.writeFile(path.join(outside, commitId + '.json'), payload);
    await fs.rm(targetDirectory, { recursive: true, force: true });
    await fs.symlink(outside, targetDirectory, process.platform === 'win32' ? 'junction' : 'dir');

    let rawTargetOpen = false;
    fs.open = async (target, ...arguments_) => {
      if (path.resolve(target) === path.resolve(targetPath)) {
        rawTargetOpen = true;
        const error = new Error('The publication target reached a raw filesystem open.');
        error.code = 'unsafe_raw_open';
        throw error;
      }
      return originalOpen(target, ...arguments_);
    };
    await assert.rejects(
      materializeTransactionPayloads(
        { root, durableFileOps: TEST_DURABLE_FILE_OPS },
        stagingRoot,
        [{ path: 'commits/' + commitId + '.json', sha256: sha256(payload) }],
      ),
      (error) => error.code === 'path_escape',
    );
    assert.equal(rawTargetOpen, false);
  } finally {
    fs.open = originalOpen;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('rejects a reparse point created immediately before materializing a payload', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-materialize-race-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-materialize-race-outside-'));
  let arm = false;
  let reparseCreated = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase, details) => {
        if (!arm || reparseCreated || phase !== 'before-materialize-temporary-open') return;
        try {
          await fs.symlink(outside, details.temporary, process.platform === 'win32' ? 'junction' : 'dir');
          reparseCreated = true;
        } catch (error) {
          if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
            t.skip('reparse-point creation is unavailable in this environment');
            return;
          }
          throw error;
        }
      },
    });
    await library.open();
    await createAssetOwner(library, 'project-materialize-race');
    arm = true;

    await assert.rejects(
      writeOwnedAsset(library, {
        assetId: 'asset-materialize-race',
        projectId: 'project-materialize-race',
        kind: 'image',
        sourceKind: 'import',
        blob: new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' }),
      }),
      (error) => error.code === 'path_escape',
    );
    if (reparseCreated) {
      assert.equal(await fs.stat(outside).then((stat) => stat.isDirectory()), true);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('blocks writes after recovering the prior head until recovery is acknowledged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-readonly-recovery-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-readonly-recovery', 'Before', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    await library.rename(
      'project-readonly-recovery',
      'Before crash',
      3,
      await projectMutationOptions(library, 'r1'),
    );
    const previousHead = await fs.readFile(path.join(root, 'head.previous.json'));
    await fs.writeFile(path.join(root, 'head.json'), '{"broken":true}', 'utf8');
    const recovered = createFileProjectLibrary({ root });
    await recovered.open();
    await assert.rejects(
      recovered.rename(
        'project-readonly-recovery',
        'Blocked',
        3,
        await projectMutationOptions(recovered, 'r1'),
      ),
      (error) => error.code === 'recovery_required',
    );
    assert.deepEqual(await fs.readFile(path.join(root, 'head.json')), previousHead);
    await recovered.acknowledgeRecovery();
    const renamed = await recovered.rename(
      'project-readonly-recovery',
      'After acknowledgement',
      4,
      await projectMutationOptions(recovered, 'r1'),
    );
    assert.equal(renamed.code, 'applied');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('recovers deterministically from every publication phase', async () => {
  for (const phase of ['after-stage', 'after-materialize', 'after-head-previous', 'before-head', 'after-head']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `lumina-file-library-${phase}-`));
    let armed = false;
    try {
      const library = createFileProjectLibrary({
        root,
        faultInjector: async (observed) => {
          if (armed && observed === phase) throw new Error(`crash-${phase}`);
        },
      });
      await library.open();
      armed = true;
      await assert.rejects(
        library.saveSnapshot(
          projectRecord(`project-${phase}`, phase, 'r1'),
          await projectMutationOptions(library, 'absent'),
        ),
        new RegExp(`crash-${phase}`, 'u'),
      );
      const restarted = createFileProjectLibrary({ root });
      await restarted.open();
      const project = await restarted.openProject(`project-${phase}`);
      if (phase === 'after-head') {
        assert.equal(project.name, phase);
      } else {
        assert.equal(project, null);
      }
      const staging = await fs.readdir(path.join(root, 'staging'));
      assert.equal(staging.length, 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('accepts a validated current-head journal after an interrupted pre-head publication', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-current-journal-'));
  let armed = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (armed && phase === 'after-head-previous') throw new Error('crash-after-head-previous');
      },
    });
    await library.open();
    armed = true;
    await assert.rejects(
      library.saveSnapshot(
        projectRecord('project-current-journal', 'Interrupted', 'r1'),
        await projectMutationOptions(library, 'absent'),
      ),
      /crash-after-head-previous/u,
    );

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    assert.equal((await restarted.cleanupOrphans()).code, 'cleanup_complete');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('quarantines a mid-copy payload without exposing a partial final asset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-materialize-copy-'));
  let armed = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase, details) => {
        if (armed && phase === 'during-materialize-copy' && details.copiedBytes > 0) {
          throw new Error('mid-copy-crash');
        }
      },
    });
    await library.open();
    await createAssetOwner(library, 'project-mid-copy');
    armed = true;
    await assert.rejects(
      writeOwnedAsset(library, {
        assetId: 'asset-mid-copy',
        projectId: 'project-mid-copy',
        kind: 'image',
        sourceKind: 'import',
        blob: new Blob([Uint8Array.from([1, 2, 3, 4, 5, 6])], { type: 'image/png' }),
      }),
      /mid-copy-crash/u,
    );

    const [transactionId] = await fs.readdir(path.join(root, 'staging'));
    const publish = JSON.parse(await fs.readFile(path.join(root, 'staging', transactionId, 'publish.json'), 'utf8'));
    const bytesPayload = publish.payloads.find((payload) => payload.path.endsWith('/bytes.bin'));
    assert.ok(bytesPayload);
    assert.equal(await fs.stat(path.join(root, bytesPayload.path)).then(() => true).catch(() => false), false);

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    assert.equal((await restarted.openProject('project-mid-copy')).revision, 'r1');
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'quarantine', transactionId, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.retained.find((entry) => entry.path === bytesPayload.path), bytesPayload);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('quarantines every materialized pre-head payload and deletes only its authorized closure after retention', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-quarantine-closure-'));
  let armed = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (armed && phase === 'after-materialize') throw new Error('crash-after-materialize');
      },
    });
    await library.open();
    await createAssetOwner(library, 'project-quarantine-closure');
    armed = true;
    await assert.rejects(
      writeOwnedAsset(library, {
        assetId: 'asset-quarantine-closure',
        projectId: 'project-quarantine-closure',
        kind: 'image',
        sourceKind: 'import',
        blob: new Blob([Uint8Array.from([3, 1, 4])], { type: 'image/png' }),
      }),
      /crash-after-materialize/u,
    );

    const [transactionId] = await fs.readdir(path.join(root, 'staging'));
    const publish = JSON.parse(await fs.readFile(path.join(root, 'staging', transactionId, 'publish.json'), 'utf8'));
    const restarted = createFileProjectLibrary({ root });
    await restarted.open();

    const manifest = JSON.parse(await fs.readFile(
      path.join(root, 'quarantine', transactionId, 'manifest.json'),
      'utf8',
    ));
    assert.equal(manifest.retainedUntil - manifest.failedAt, THIRTY_DAYS_MS);
    assert.deepEqual(manifest.publish.payloads, publish.payloads);
    for (const payload of publish.payloads) {
      assert.deepEqual(manifest.retained.find((entry) => entry.path === payload.path), payload);
      assert.equal(await fs.stat(path.join(root, payload.path)).then(() => true).catch(() => false), true);
    }

    const cleaner = createFileProjectLibrary({ root, clock: () => manifest.retainedUntil });
    await cleaner.open();
    const cleaned = await cleaner.cleanupOrphans();
    assert.equal(cleaned.code, 'quarantine_cleanup_complete');
    const receipt = JSON.parse(await fs.readFile(
      path.join(root, 'quarantine', transactionId, 'cleanup.json'),
      'utf8',
    ));
    assert.equal(receipt.state, 'complete');
    for (const payload of publish.payloads) {
      assert.equal(await fs.stat(path.join(root, payload.path)).then(() => true).catch(() => false), false);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resumes every authorized quarantine cleanup crash state without broad deletion', async () => {
  for (const crashPhase of ['after-quarantine-cleanup-authorize', 'after-quarantine-cleanup-delete']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `lumina-file-library-quarantine-${crashPhase}-`));
    let crashPublication = true;
    let crashCleanup = false;
    try {
      const writer = createFileProjectLibrary({
        root,
        faultInjector: async (phase) => {
          if (crashPublication && phase === 'after-materialize') throw new Error('quarantine-publication-crash');
        },
      });
      await writer.open();
      crashPublication = false;
      await createAssetOwner(writer, `project-${crashPhase}`);
      crashPublication = true;
      await assert.rejects(
        writeOwnedAsset(writer, {
          assetId: `asset-${crashPhase}`,
          projectId: `project-${crashPhase}`,
          kind: 'image',
          sourceKind: 'import',
          blob: new Blob([Uint8Array.from([8, 6, 7])], { type: 'image/png' }),
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
      const cleaner = createFileProjectLibrary({
        root,
        clock: () => manifest.retainedUntil,
        faultInjector: async (phase, details) => {
          if (!crashCleanup) return;
          if (phase === 'after-quarantine-cleanup-authorize' && crashPhase === phase) {
            throw new Error(`quarantine-cleanup-${crashPhase}`);
          }
          if (phase === 'after-quarantine-cleanup-delete'
            && crashPhase === phase
            && details.path.startsWith(`quarantine/${transactionId}/`)) {
            throw new Error(`quarantine-cleanup-${crashPhase}`);
          }
        },
      });
      await cleaner.open();
      crashCleanup = true;
      await assert.rejects(cleaner.cleanupOrphans(), /quarantine-cleanup/u);
      crashCleanup = false;

      const resumed = createFileProjectLibrary({ root, clock: () => manifest.retainedUntil });
      await resumed.open();
      assert.equal((await resumed.cleanupOrphans()).code, 'quarantine_cleanup_complete');
      assert.equal(JSON.parse(await fs.readFile(
        path.join(root, 'quarantine', transactionId, 'cleanup.json'),
        'utf8',
      )).state, 'complete');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('resumes a quarantine whose directory exists before its manifest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-partial-quarantine-'));
  let armed = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (armed && phase === 'after-stage') throw new Error('crash-after-stage');
      },
    });
    await library.open();
    armed = true;
    await assert.rejects(
      library.saveSnapshot(
        projectRecord('project-partial-quarantine', 'Interrupted', 'r1'),
        await projectMutationOptions(library, 'absent'),
      ),
      /crash-after-stage/u,
    );
    const [transactionId] = await fs.readdir(path.join(root, 'staging'));
    await fs.mkdir(path.join(root, 'quarantine', transactionId));

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();

    const manifest = JSON.parse(await fs.readFile(
      path.join(root, 'quarantine', transactionId, 'manifest.json'),
      'utf8',
    ));
    assert.equal(manifest.transactionId, transactionId);
    assert.equal(manifest.reason, 'not_published');
    assert.deepEqual(await fs.readdir(path.join(root, 'staging')), []);
    assert.equal(await restarted.openProject('project-partial-quarantine'), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('quarantines a staging directory with a mismatched publish transaction id', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-mismatched-journal-'));
  let armed = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (armed && phase === 'after-head') throw new Error('crash-after-head');
      },
    });
    await library.open();
    armed = true;
    await assert.rejects(
      library.saveSnapshot(
        projectRecord('project-visible-journal', 'Visible', 'r1'),
        await projectMutationOptions(library, 'absent'),
      ),
      /crash-after-head/u,
    );
    const [realTransactionId] = await fs.readdir(path.join(root, 'staging'));
    const mismatchedTransactionId = `t_${'f'.repeat(32)}`;
    assert.notEqual(mismatchedTransactionId, realTransactionId);
    const mismatchedRoot = path.join(root, 'staging', mismatchedTransactionId);
    await fs.mkdir(mismatchedRoot);
    await fs.copyFile(
      path.join(root, 'staging', realTransactionId, 'publish.json'),
      path.join(mismatchedRoot, 'publish.json'),
    );
    await fs.writeFile(path.join(mismatchedRoot, 'unpublished-payload.bin'), Uint8Array.from([4, 5, 6]));

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();

    const manifest = JSON.parse(await fs.readFile(
      path.join(root, 'quarantine', mismatchedTransactionId, 'manifest.json'),
      'utf8',
    ));
    assert.equal(manifest.transactionId, mismatchedTransactionId);
    assert.equal(manifest.reason, 'transaction_id_mismatch');
    assert.deepEqual(
      [...await fs.readFile(path.join(root, 'quarantine', mismatchedTransactionId, 'unpublished-payload.bin'))],
      [4, 5, 6],
    );
    assert.equal((await restarted.openProject('project-visible-journal')).name, 'Visible');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preserves the previous head when atomic replacement reports disk full', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-disk-full-'));
  let failHead = false;
  try {
    const library = createFileProjectLibrary({
      root,
      durableFileOps: {
        atomicReplaceManaged: async (managedRoot, temporary, target) => {
          await fs.rename(path.join(managedRoot, temporary), path.join(managedRoot, target));
        },
        atomicReplaceIfLeaseCurrentManaged: async (managedRoot, temporary, target, leasePath, expectedContents, expiresAt) => {
          if (failHead && path.basename(target) === 'head.json') {
            const error = new Error('no space');
            error.code = 'ENOSPC';
            throw error;
          }
          if (Date.now() >= expiresAt || await fs.readFile(path.join(managedRoot, leasePath), 'utf8') !== expectedContents) return false;
          await fs.rename(path.join(managedRoot, temporary), path.join(managedRoot, target));
          return true;
        },
      },
    });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-disk', 'Before failure', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    const before = await fs.readFile(path.join(root, 'head.json'));
    failHead = true;
    await assert.rejects(
      library.rename(
        'project-disk',
        'After failure',
        3,
        await projectMutationOptions(library, 'r1'),
      ),
      (error) => error.code === 'ENOSPC',
    );
    assert.deepEqual(await fs.readFile(path.join(root, 'head.json')), before);
    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    assert.equal((await restarted.openProject('project-disk')).name, 'Before failure');
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('does not recursively erase a staging closure replaced after publication', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-staging-cleanup-race-'));
  let replacementPath = null;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase, details) => {
        if (phase !== 'before-staging-cleanup-delete' || details.operation !== 'project-mutation') return;
        replacementPath = path.join(details.stagingRoot, 'publish.json');
        await fs.writeFile(replacementPath, 'replacement', 'utf8');
      },
    });
    await library.open();

    await assert.rejects(
      library.saveSnapshot(
        projectRecord('project-staging-cleanup-race', 'Staging cleanup race', 'r1'),
        await projectMutationOptions(library, 'absent'),
      ),
      (error) => error.code === 'recovery_required',
    );

    assert.ok(replacementPath);
    assert.equal(await fs.readFile(replacementPath, 'utf8'), 'replacement');
    assert.equal((await library.openProject('project-staging-cleanup-race')).name, 'Staging cleanup race');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('persists complete publication preconditions and quarantines a missing catalog field', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-publish-preconditions-'));
  let interruptPublication = false;
  try {
    const library = createFileProjectLibrary({
      root,
      faultInjector: async (phase) => {
        if (interruptPublication && phase === 'after-stage') throw new Error('stop-after-stage');
      },
    });
    await library.open();
    const initial = await library.saveSnapshot(
      projectRecord('project-publish-preconditions', 'Initial', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    interruptPublication = true;
    const expectedCatalog = initial.catalog;
    await assert.rejects(
      library.rename('project-publish-preconditions', 'Interrupted', 2, {
        expectedCatalog,
        expectedRevision: 'r1',
      }),
      /stop-after-stage/u,
    );
    const [transactionId] = await fs.readdir(path.join(root, 'staging'));
    const publishPath = path.join(root, 'staging', transactionId, 'publish.json');
    const publish = JSON.parse(await fs.readFile(publishPath, 'utf8'));
    assert.deepEqual(publish.expectedCatalog, expectedCatalog);
    assert.deepEqual(publish.expectedProjectRevisions, [{
      projectId: 'project-publish-preconditions',
      expectedRevision: 'r1',
    }]);

    delete publish.expectedCatalog.sequence;
    await fs.writeFile(publishPath, canonicalize(publish), 'utf8');
    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    const quarantine = JSON.parse(await fs.readFile(
      path.join(root, 'quarantine', transactionId, 'manifest.json'),
      'utf8',
    ));
    assert.equal(quarantine.reason, 'invalid_publish_record');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
