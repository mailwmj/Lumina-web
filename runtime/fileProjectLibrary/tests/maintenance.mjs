import { assert, canonicalize, createAssetOwner, createFileProjectLibrary, createRawFileProjectLibrary, fs, os, path, projectMutationOptions, projectRecord, sha256, test, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';

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
