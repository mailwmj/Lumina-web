import { assert, assetLifecycleOptions, canonicalize, createAssetOwner, createFileProjectLibrary, createRawFileProjectLibrary, emptyTrashOptions, fs, os, path, projectMutationOptions, projectRecord, sha256, test, TEST_DURABLE_FILE_OPS, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';

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

test('requires persisted GC plans to use the exact safety window and authorization state', async () => {
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
    for (const offset of [-1, 1]) {
      await fs.writeFile(planPath, canonicalize({
        ...plan,
        notBefore: plan.plannedAt + THIRTY_DAYS_MS + offset,
      }), 'utf8');
      await assert.rejects(library.cleanupOrphans(), (error) => error.code === 'corrupt_schema');
      assert.equal(await fs.stat(orphan).then(() => true).catch(() => false), true);
    }

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
