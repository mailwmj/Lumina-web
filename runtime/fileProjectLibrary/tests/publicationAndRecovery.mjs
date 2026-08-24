import { assert, canonicalize, createAssetOwner, createFileProjectLibrary, createRawFileProjectLibrary, fs, os, path, projectRecord, sha256, test, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';

test('blocks writes after recovering the prior head until recovery is acknowledged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-readonly-recovery-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(projectRecord('project-readonly-recovery', 'Before', 'r1'), { expectedRevision: 'absent' });
    await library.rename('project-readonly-recovery', 'Before crash', 3, { expectedRevision: 'r1' });
    const previousHead = await fs.readFile(path.join(root, 'head.previous.json'));
    await fs.writeFile(path.join(root, 'head.json'), '{"broken":true}', 'utf8');
    const recovered = createFileProjectLibrary({ root });
    await recovered.open();
    await assert.rejects(
      recovered.rename('project-readonly-recovery', 'Blocked', 3, { expectedRevision: 'r1' }),
      (error) => error.code === 'recovery_required',
    );
    assert.deepEqual(await fs.readFile(path.join(root, 'head.json')), previousHead);
    await recovered.acknowledgeRecovery();
    const renamed = await recovered.rename('project-readonly-recovery', 'After acknowledgement', 4, { expectedRevision: 'r1' });
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
        library.saveSnapshot(projectRecord(`project-${phase}`, phase, 'r1'), { expectedRevision: 'absent' }),
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
      library.saveSnapshot(projectRecord('project-current-journal', 'Interrupted', 'r1'), { expectedRevision: 'absent' }),
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
      library.saveSnapshot(projectRecord('project-partial-quarantine', 'Interrupted', 'r1'), { expectedRevision: 'absent' }),
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
      library.saveSnapshot(projectRecord('project-visible-journal', 'Visible', 'r1'), { expectedRevision: 'absent' }),
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
        atomicReplace: async (temporary, target) => {
          await fs.rename(temporary, target);
        },
        atomicReplaceIfLeaseCurrent: async (temporary, target, leasePath, expectedContents, expiresAt) => {
          if (failHead && path.basename(target) === 'head.json') {
            const error = new Error('no space');
            error.code = 'ENOSPC';
            throw error;
          }
          if (Date.now() >= expiresAt || await fs.readFile(leasePath, 'utf8') !== expectedContents) return false;
          await fs.rename(temporary, target);
          return true;
        },
      },
    });
    await library.open();
    await library.saveSnapshot(projectRecord('project-disk', 'Before failure', 'r1'), { expectedRevision: 'absent' });
    const before = await fs.readFile(path.join(root, 'head.json'));
    failHead = true;
    await assert.rejects(
      library.rename('project-disk', 'After failure', 3, { expectedRevision: 'r1' }),
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
