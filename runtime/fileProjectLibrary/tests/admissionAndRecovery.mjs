import { assert, canonicalize, createAssetOwner, createFileProjectLibrary, createRawFileProjectLibrary, fs, os, path, projectMutationOptions, projectRecord, sha256, test, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';

test('rejects duplicate, malformed, and unknown persisted JSON members', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-schema-'));
  const unknownRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-unknown-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-schema', 'Schema', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    const validHead = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));

    await fs.writeFile(
      path.join(root, 'head.json'),
      `{"format":"lumina-library-head","version":1,"commitId":"${validHead.commitId}","commitSha256":"${'0'.repeat(64)}","commitSha256":"${validHead.commitSha256}","previousCommitId":${JSON.stringify(validHead.previousCommitId)}}`,
      'utf8',
    );
    const duplicateRecovery = createFileProjectLibrary({ root });
    await duplicateRecovery.open();
    assert.equal(await duplicateRecovery.openProject('project-schema'), null);

    await fs.writeFile(path.join(root, 'head.json'), '{"format":', 'utf8');
    await fs.writeFile(path.join(root, 'head.previous.json'), '{"format":', 'utf8');
    const malformed = createFileProjectLibrary({ root });
    await assert.rejects(malformed.open(), (error) => error.code === 'recovery_required');

    const unknownLibrary = createFileProjectLibrary({ root: unknownRoot });
    await unknownLibrary.open();
    await unknownLibrary.saveSnapshot(
      projectRecord('project-unknown', 'Unknown', 'r1'),
      await projectMutationOptions(unknownLibrary, 'absent'),
    );
    const head = JSON.parse(await fs.readFile(path.join(unknownRoot, 'head.json'), 'utf8'));
    const catalog = JSON.parse(await fs.readFile(path.join(unknownRoot, 'commits', `${head.commitId}.json`), 'utf8'));
    const entry = catalog.projects.find((candidate) => candidate.projectId === 'project-unknown');
    const projectPath = path.join(unknownRoot, entry.manifestPath.replace(/manifest\.json$/u, 'project.json'));
    const projectDocument = JSON.parse(await fs.readFile(projectPath, 'utf8'));
    await fs.writeFile(projectPath, JSON.stringify({ ...projectDocument, unknown: true }), 'utf8');
    const unknownRecovery = createFileProjectLibrary({ root: unknownRoot });
    await unknownRecovery.open();
    assert.ok((await unknownRecovery.openProject('project-unknown')).recovery);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(unknownRoot, { recursive: true, force: true });
  }
});
test('atomically publishes corrupt snapshot recovery evidence through its replacement catalog', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-corrupt-project-recovery-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-intact', 'Intact', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    await library.saveSnapshot(
      projectRecord('project-corrupt', 'Corrupt', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    const headBefore = await fs.readFile(path.join(root, 'head.json'));
    const head = JSON.parse(headBefore);
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'commits', `${head.commitId}.json`), 'utf8'));
    const entry = catalog.projects.find((candidate) => candidate.projectId === 'project-corrupt');
    const snapshotDirectory = path.join(root, entry.manifestPath.replace(/manifest\.json$/u, ''));
    const originalProject = JSON.parse(await fs.readFile(path.join(snapshotDirectory, 'project.json'), 'utf8'));
    const corruptProjectBytes = Buffer.from(JSON.stringify({ ...originalProject, unknown: true }));
    const historyBytes = await fs.readFile(path.join(snapshotDirectory, 'history.json'));
    await fs.writeFile(path.join(snapshotDirectory, 'project.json'), corruptProjectBytes);

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    assert.equal((await restarted.openProject('project-intact')).name, 'Intact');
    const recovered = await restarted.openProject('project-corrupt');
    assert.ok(['unsupported_schema', 'migration_failed'].includes(recovered.recovery.reason));
    await assert.rejects(
      restarted.saveSnapshot(
        { ...recovered, name: 'Must remain read-only' },
        await projectMutationOptions(restarted, 'r1'),
      ),
      (error) => error.code === 'project_read_only_recovery',
    );
    const recoveryHead = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    assert.notEqual(recoveryHead.commitId, head.commitId);
    const recoveryCatalog = JSON.parse(await fs.readFile(
      path.join(root, 'commits', `${recoveryHead.commitId}.json`),
      'utf8',
    ));
    const recoveryEntry = recoveryCatalog.projects.find((candidate) => candidate.projectId === 'project-corrupt');
    assert.notEqual(recoveryEntry.snapshotKey, entry.snapshotKey);
    const recovery = JSON.parse(await fs.readFile(
      path.join(root, recoveryEntry.manifestPath),
      'utf8',
    )).recovery;
    assert.match(recovery.recoveryId, /^r_[0-9a-f]{32}$/u);
    assert.deepEqual(await fs.readFile(path.join(root, recovery.sourceProjectPath)), corruptProjectBytes);
    assert.deepEqual(await fs.readFile(path.join(root, recovery.sourceHistoryPath)), historyBytes);
    assert.equal(
      await fs.stat(path.join(root, 'projects', entry.projectKey, 'recovery')).then(() => true).catch(() => false),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects oversized snapshots and assets before whole-file reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-bounded-read-'));
  const originalReadFile = fs.readFile;
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-bounded-read', 'Bounded', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    await writeOwnedAsset(library, {
      assetId: 'asset-bounded-read',
      projectId: 'project-bounded-read',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' }),
    });
    const head = JSON.parse(await originalReadFile(path.join(root, 'head.json'), 'utf8'));
    const catalog = JSON.parse(await originalReadFile(path.join(root, 'commits', `${head.commitId}.json`), 'utf8'));
    const project = catalog.projects.find((entry) => entry.projectId === 'project-bounded-read');
    const asset = catalog.assets.find((entry) => entry.assetId === 'asset-bounded-read');
    const projectPath = path.join(root, project.manifestPath.replace(/manifest\.json$/u, 'project.json'));
    const assetPath = path.join(root, asset.bytesPath);
    const projectBytesBefore = await originalReadFile(projectPath);
    await fs.writeFile(projectPath, Buffer.alloc((4 * 1024 * 1024) + 1));

    let projectWholeRead = false;
    fs.readFile = async (target, ...arguments_) => {
      if (path.resolve(target) === path.resolve(projectPath)) projectWholeRead = true;
      return originalReadFile(target, ...arguments_);
    };
    await assert.rejects(library.openProject('project-bounded-read'), (error) => error.code === 'corrupt_schema');
    assert.equal(projectWholeRead, false);

    await fs.writeFile(projectPath, projectBytesBefore);
    await fs.writeFile(assetPath, Uint8Array.from([1, 2, 3, 4]));
    let assetWholeRead = false;
    fs.readFile = async (target, ...arguments_) => {
      if (path.resolve(target) === path.resolve(assetPath)) assetWholeRead = true;
      return originalReadFile(target, ...arguments_);
    };
    await assert.rejects(library.readAsset('asset-bounded-read'), (error) => error.code === 'corrupt_schema');
    assert.equal(assetWholeRead, false);
  } finally {
    fs.readFile = originalReadFile;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keeps corrupt snapshot recovery evidence unreachable until its catalog is published', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-recovery-publication-crash-'));
  let crashRecoveryPublication = false;
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-recovery-crash', 'Recovery crash', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    const headBefore = await fs.readFile(path.join(root, 'head.json'));
    const catalogBefore = JSON.parse(await fs.readFile(
      path.join(root, 'commits', `${JSON.parse(headBefore).commitId}.json`),
      'utf8',
    ));
    const entry = catalogBefore.projects[0];
    const projectPath = path.join(root, entry.manifestPath.replace(/manifest\.json$/u, 'project.json'));
    const source = JSON.parse(await fs.readFile(projectPath, 'utf8'));
    await fs.writeFile(projectPath, JSON.stringify({ ...source, unknown: true }), 'utf8');

    const interrupted = createFileProjectLibrary({
      root,
      faultInjector: async (phase, details) => {
        if (crashRecoveryPublication && phase === 'after-materialize' && details.operation === 'project-recovery') {
          throw new Error('recovery-publication-crash');
        }
      },
    });
    crashRecoveryPublication = true;
    await assert.rejects(interrupted.open(), /recovery-publication-crash/u);
    assert.deepEqual(await fs.readFile(path.join(root, 'head.json')), headBefore);

    const restarted = createFileProjectLibrary({ root });
    await restarted.open();
    const recovered = await restarted.openProject('project-recovery-crash');
    assert.ok(recovered.recovery);
    const recoveredHead = await fs.readFile(path.join(root, 'head.json'));
    assert.notDeepEqual(recoveredHead, headBefore);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects a junctioned asset directory before opening its catalog targets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-path-swap-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-path-swap-outside-'));
  const originalOpen = fs.open;
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-path-swap', 'Path swap', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    await writeOwnedAsset(library, {
      assetId: 'asset-path-swap',
      projectId: 'project-path-swap',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([5, 4, 3])], { type: 'image/png' }),
    });
    const head = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'commits', head.commitId + '.json'), 'utf8'));
    const entry = catalog.assets.find((candidate) => candidate.assetId === 'asset-path-swap');
    const assetDirectory = path.join(root, 'assets', entry.assetKey);
    await fs.writeFile(path.join(outside, 'bytes.bin'), Uint8Array.from([5, 4, 3]));
    await fs.rm(assetDirectory, { recursive: true, force: true });
    await fs.symlink(outside, assetDirectory, process.platform === 'win32' ? 'junction' : 'dir');

    let rawOpenAttempt = false;
    fs.open = async (target, ...arguments_) => {
      if (path.resolve(target).startsWith(path.resolve(assetDirectory))) {
        rawOpenAttempt = true;
        const error = new Error('A junctioned target reached a raw filesystem open.');
        error.code = 'unsafe_raw_open';
        throw error;
      }
      return originalOpen(target, ...arguments_);
    };
    await assert.rejects(
      library.readAsset('asset-path-swap'),
      (error) => error.code === 'path_escape',
    );
    assert.equal(rawOpenAttempt, false);
  } finally {
    fs.open = originalOpen;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('rejects an asset target swapped to an outside junction after pathname validation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-open-swap-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-open-swap-outside-'));
  const originalOpen = fs.open;
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-open-swap', 'Open swap', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    await writeOwnedAsset(library, {
      assetId: 'asset-open-swap',
      projectId: 'project-open-swap',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([5, 4, 3])], { type: 'image/png' }),
    });
    const head = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'commits', `${head.commitId}.json`), 'utf8'));
    const entry = catalog.assets.find((candidate) => candidate.assetId === 'asset-open-swap');
    const bytesPath = path.join(root, entry.bytesPath);
    const assetDirectory = path.dirname(bytesPath);
    const backupDirectory = `${assetDirectory}.before-open-swap`;
    const outsideAssetDirectory = path.join(outside, 'asset');
    const outsideBytesPath = path.join(outsideAssetDirectory, 'bytes.bin');
    await fs.mkdir(outsideAssetDirectory);
    await fs.writeFile(outsideBytesPath, Uint8Array.from([9, 8, 7]));

    let swapped = false;
    let outsideHandleRead = false;
    fs.open = async (target, ...arguments_) => {
      if (!swapped && path.resolve(target) === path.resolve(bytesPath)) {
        swapped = true;
        await fs.rename(assetDirectory, backupDirectory);
        await fs.symlink(outsideAssetDirectory, assetDirectory, process.platform === 'win32' ? 'junction' : 'dir');
        try {
          const handle = await originalOpen(target, ...arguments_);
          const read = handle.read.bind(handle);
          handle.read = async (...readArguments) => {
            outsideHandleRead = true;
            return read(...readArguments);
          };
          return handle;
        } finally {
          await fs.rmdir(assetDirectory);
          await fs.rename(backupDirectory, assetDirectory);
        }
      }
      return originalOpen(target, ...arguments_);
    };

    await assert.rejects(
      library.readAsset('asset-open-swap'),
      (error) => error.code === 'path_escape',
    );
    assert.equal(swapped, true);
    assert.equal(outsideHandleRead, false);
  } finally {
    fs.open = originalOpen;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('restores the last validated catalog when the current head is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-missing-head-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(
      projectRecord('project-journal', 'First', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    await library.rename('project-journal', 'Second', 3, await projectMutationOptions(library, 'r1'));
    await fs.rm(path.join(root, 'head.json'));

    const recovered = createFileProjectLibrary({ root });
    await recovered.open();
    assert.equal((await recovered.openProject('project-journal')).name, 'First');
    assert.ok(await fs.stat(path.join(root, 'head.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reclaims an expired write lease without disturbing a live writer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-lease-'));
  try {
    const first = createFileProjectLibrary({ root, lockTimeoutMs: 25 });
    await first.open();
    const lockPath = path.join(root, '.library-write.lock');
    await fs.writeFile(lockPath, '4294967295\n0\n', 'utf8');
    const old = (Date.now() - 1_000) / 1_000;
    await fs.utimes(lockPath, old, old);
    const recovered = createFileProjectLibrary({ root, lockTimeoutMs: 25 });
    await recovered.open();
    assert.deepEqual(await recovered.listProjects(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('does not reclaim a replacement write lease after observing a stale lease', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-lease-race-'));
  try {
    const bootstrap = createFileProjectLibrary({ root });
    await bootstrap.open();
    const lockPath = path.join(root, '.library-write.lock');
    const staleContents = '4294967295\n0\nstale-test-lease\n';
    const replacementContents = `${process.pid}\n${Date.now()}\nfresh-test-lease\n`;
    await fs.writeFile(lockPath, staleContents, 'utf8');
    let compareAttempts = 0;
    const contender = createFileProjectLibrary({
      root,
      lockTimeoutMs: 25,
      durableFileOps: {
        removeIfUnchanged: async (managedRoot, relative, expectedContents) => {
          const target = path.join(managedRoot, relative);
          compareAttempts += 1;
          if (compareAttempts === 1) {
            assert.equal(await fs.readFile(target, 'utf8'), staleContents);
            await fs.writeFile(target, replacementContents, 'utf8');
          }
          if (await fs.readFile(target, 'utf8') !== expectedContents) return false;
          await fs.rm(target, { force: true });
          return true;
        },
      },
    });
    await assert.rejects(contender.open(), (error) => error.code === 'library_busy');
    assert.equal(compareAttempts, 1);
    assert.equal(await fs.readFile(lockPath, 'utf8'), replacementContents);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('does not replace the head after the final write lease changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-head-lease-'));
  let armReplacement = false;
  try {
    const lockPath = path.join(root, '.library-write.lock');
    const replacementContents = `${process.pid}\n${Date.now()}\nreplacement-head-lease\n`;
    const library = createFileProjectLibrary({
      root,
      durableFileOps: {
        atomicReplaceManaged: async (managedRoot, temporary, target) => {
          if (armReplacement && path.resolve(path.join(managedRoot, target)) === path.resolve(path.join(root, 'head.json'))) {
            await fs.writeFile(lockPath, replacementContents, 'utf8');
          }
          await fs.rename(path.join(managedRoot, temporary), path.join(managedRoot, target));
        },
        atomicReplaceIfLeaseCurrentManaged: async (managedRoot, temporary, target, leasePath, expectedContents, expiresAt) => {
          if (armReplacement && path.resolve(path.join(managedRoot, target)) === path.resolve(path.join(root, 'head.json'))) {
            await fs.writeFile(lockPath, replacementContents, 'utf8');
          }
          if (Date.now() >= expiresAt || await fs.readFile(path.join(managedRoot, leasePath), 'utf8') !== expectedContents) return false;
          await fs.rename(path.join(managedRoot, temporary), path.join(managedRoot, target));
          return true;
        },
      },
    });
    await library.open();
    const headBefore = await fs.readFile(path.join(root, 'head.json'));
    armReplacement = true;

    await assert.rejects(
      library.saveSnapshot(
        projectRecord('project-head-lease', 'Lease changed', 'r1'),
        await projectMutationOptions(library, 'absent'),
      ),
      (error) => error.code === 'lease_lost',
    );
    assert.deepEqual(await fs.readFile(path.join(root, 'head.json')), headBefore);
    assert.equal(await fs.readFile(lockPath, 'utf8'), replacementContents);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('does not replace the head journal after the final write lease changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-journal-lease-'));
  let armReplacement = false;
  try {
    const lockPath = path.join(root, '.library-write.lock');
    const journalPath = path.join(root, 'head.previous.json');
    const replacementContents = `${process.pid}\n${Date.now()}\nreplacement-journal-lease\n`;
    const library = createFileProjectLibrary({
      root,
      durableFileOps: {
        atomicReplaceManaged: async (managedRoot, temporary, target) => {
          if (armReplacement && path.resolve(path.join(managedRoot, target)) === path.resolve(journalPath)) {
            await fs.writeFile(lockPath, replacementContents, 'utf8');
          }
          await fs.rename(path.join(managedRoot, temporary), path.join(managedRoot, target));
        },
        atomicReplaceIfLeaseCurrentManaged: async (managedRoot, temporary, target, leasePath, expectedContents, expiresAt) => {
          if (armReplacement && path.resolve(path.join(managedRoot, target)) === path.resolve(journalPath)) {
            await fs.writeFile(lockPath, replacementContents, 'utf8');
          }
          if (Date.now() >= expiresAt || await fs.readFile(path.join(managedRoot, leasePath), 'utf8') !== expectedContents) return false;
          await fs.rename(path.join(managedRoot, temporary), path.join(managedRoot, target));
          return true;
        },
      },
    });
    await library.open();
    const headBefore = await fs.readFile(path.join(root, 'head.json'));
    armReplacement = true;

    await assert.rejects(
      library.saveSnapshot(
        projectRecord('project-journal-lease', 'Journal lease changed', 'r1'),
        await projectMutationOptions(library, 'absent'),
      ),
      (error) => error.code === 'lease_lost',
    );
    assert.deepEqual(await fs.readFile(path.join(root, 'head.json')), headBefore);
    assert.equal(await fs.stat(journalPath).then(() => true).catch(() => false), false);
    assert.equal(await fs.readFile(lockPath, 'utf8'), replacementContents);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('expires a live final-publication lease after five minutes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-live-lease-'));
  try {
    const first = createFileProjectLibrary({ root, lockTimeoutMs: 25 });
    await first.open();
    const lockPath = path.join(root, '.library-write.lock');
    await fs.writeFile(lockPath, `${process.pid}\n${Date.now() - (5 * 60 * 1000) - 1}\nexpired-test-lease\n`, 'utf8');
    const recovered = createFileProjectLibrary({ root, lockTimeoutMs: 25 });
    await recovered.open();
    assert.deepEqual(await recovered.listProjects(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects managed symlink escapes before reading asset bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-outside-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await createAssetOwner(library, 'project-symlink');
    await writeOwnedAsset(library, {
      assetId: 'asset-symlink',
      projectId: 'project-symlink',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([4, 5])], { type: 'image/png' }),
    });
    const commit = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'commits', `${commit.commitId}.json`), 'utf8'));
    const entry = catalog.assets.find((candidate) => candidate.assetId === 'asset-symlink');
    const assetDirectory = path.join(root, 'assets', entry.assetKey);
    await fs.rm(assetDirectory, { recursive: true, force: true });
    try {
      await fs.symlink(outside, assetDirectory, 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
        t.skip('symlink creation is unavailable in this Windows environment');
        return;
      }
      throw error;
    }
    await assert.rejects(library.readAsset('asset-symlink'), (error) => error.code === 'path_escape');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('fails closed for credential-bearing project and asset metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await createAssetOwner(library, 'secret-asset-owner');
    const before = await fs.readFile(path.join(root, 'head.json'));
    const unsafe = projectRecord('secret-project', 'Unsafe', 'r1');
    unsafe.nodesJson = JSON.stringify({
      nodes: [{ id: 'node-1', type: 'imageNode', position: { x: 0, y: 0 }, data: { prompt: 'keep prompt', apiKey: 'provider-secret' } }],
      imagePool: [],
    });
    await assert.rejects(
      library.saveSnapshot(unsafe, await projectMutationOptions(library, 'absent')),
      (error) => error.code === 'project_secret_admission_failed',
    );
    await assert.rejects(
      writeOwnedAsset(library, {
        assetId: 'secret-asset',
        projectId: 'secret-asset-owner',
        kind: 'image',
        sourceKind: 'import',
        blob: new Blob([Uint8Array.from([1])], { type: 'image/png' }),
        sourceMetadata: { apiKey: 'provider-secret' },
      }),
      (error) => error.code === 'project_secret_admission_failed',
    );
    assert.deepEqual(await fs.readFile(path.join(root, 'head.json')), before);
    assert.equal(await library.openProject('secret-project'), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects unknown canvas node types before publication', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-node-admission-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const before = await fs.readFile(path.join(root, 'head.json'));
    const record = projectRecord('project-node-admission', 'Node admission', 'r1');
    record.nodesJson = JSON.stringify({
      nodes: [{ id: 'node-1', type: 'not-in-registry', position: { x: 0, y: 0 }, data: {} }],
      imagePool: [],
    });
    await assert.rejects(
      library.saveSnapshot(record, await projectMutationOptions(library, 'absent')),
      (error) => error.code === 'project_secret_admission_failed',
    );
    assert.deepEqual(await fs.readFile(path.join(root, 'head.json')), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('enforces registry-required node fields and exclusive numeric bounds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-registry-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();

    const missingNodeData = projectRecord('project-required-fields', 'Required fields', 'r1');
    missingNodeData.nodesJson = JSON.stringify({
      nodes: [{
        id: 'node-1',
        type: 'textAnnotationNode',
        position: { x: 0, y: 0 },
        data: {},
      }],
      imagePool: [],
    });
    await assert.rejects(
      library.saveSnapshot(missingNodeData, await projectMutationOptions(library, 'absent')),
      (error) => error.code === 'project_secret_admission_failed',
    );

    const invalidViewport = projectRecord('project-invalid-viewport', 'Invalid viewport', 'r1');
    invalidViewport.viewportJson = '{"x":0,"y":0,"zoom":0}';
    await assert.rejects(
      library.saveSnapshot(invalidViewport, await projectMutationOptions(library, 'absent')),
      (error) => error.code === 'project_secret_admission_failed',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects credential-like URLs and JWT-shaped user text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-url-admission-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    for (const [index, content] of [
      'https://example.test/prompt?campaign=fixture',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    ].entries()) {
      const record = projectRecord(`project-unsafe-${index}`, 'Unsafe text', 'r1');
      record.nodesJson = JSON.stringify({
        nodes: [{
          id: `node-${index}`,
          type: 'textAnnotationNode',
          position: { x: 0, y: 0 },
          data: { content },
        }],
        imagePool: [],
      });
      await assert.rejects(
        library.saveSnapshot(record, await projectMutationOptions(library, 'absent')),
        (error) => error.code === 'project_secret_admission_failed',
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('applies admission to project names before staging', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-name-admission-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const record = projectRecord('project-unsafe-name', 'https://example.test/name?query=1', 'r1');
    await assert.rejects(
      library.saveSnapshot(record, await projectMutationOptions(library, 'absent')),
      (error) => error.code === 'project_secret_admission_failed',
    );
    assert.equal((await library.listProjects()).length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('round-trips recovery projects as read-only facts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-project-recovery-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const record = {
      ...projectRecord('project-recovery', 'Recovery project', 'r1'),
      recovery: { reason: 'migration_failed' },
    };
    await library.saveSnapshot(record, await projectMutationOptions(library, 'absent'));
    const opened = await library.openProject(record.id);
    assert.deepEqual(opened.recovery, record.recovery);
    await assert.rejects(
      library.saveSnapshot(
        { ...record, name: 'Changed' },
        await projectMutationOptions(library, 'r1'),
      ),
      (error) => error.code === 'project_read_only_recovery',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('omits asset-backed display URLs inside storyboard frames', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-storyboard-url-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await createAssetOwner(library, 'project-storyboard-url');
    await writeOwnedAsset(library, {
      assetId: 'storyboard-frame-asset',
      projectId: 'project-storyboard-url',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([1, 2])], { type: 'image/png' }),
    });
    await library.saveSnapshot({
      ...projectRecord('project-storyboard-url', 'Storyboard URLs', 'r1'),
      nodesJson: JSON.stringify({
        nodes: [{
          id: 'storyboard-1',
          type: 'storyboardNode',
          position: { x: 0, y: 0 },
          data: {
            aspectRatio: '1:1',
            gridRows: 1,
            gridCols: 1,
            frames: [{
              id: 'frame-1',
              assetId: 'storyboard-frame-asset',
              imageUrl: 'https://example.test/frame.png',
              previewImageUrl: 'https://example.test/frame-preview.png',
              aspectRatio: '1:1',
              note: 'Frame',
              order: 0,
            }],
          },
        }],
        imagePool: [],
      }),
    }, await projectMutationOptions(library, 'r1'));
    const opened = await library.openProject('project-storyboard-url');
    const frame = JSON.parse(opened.nodesJson).nodes[0].data.frames[0];
    assert.equal(frame.imageUrl, undefined);
    assert.equal(frame.previewImageUrl, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('omits derived display URLs when a stable asset backs the node', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-display-url-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await createAssetOwner(library, 'project-backed-url');
    await writeOwnedAsset(library, {
      assetId: 'asset-backed-url',
      projectId: 'project-backed-url',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([1, 2])], { type: 'image/png' }),
    });
    await library.saveSnapshot({
      ...projectRecord('project-backed-url', 'Backed URL', 'r1'),
      nodesJson: JSON.stringify({
        nodes: [{
          id: 'node-1',
          type: 'imageNode',
          position: { x: 0, y: 0 },
            data: {
              assetId: 'asset-backed-url',
              aspectRatio: '1:1',
              prompt: 'backed',
              model: 'fixture-model',
              size: '1K',
              imageUrl: 'https://example.test/current.png',
              previewImageUrl: 'https://example.test/preview.png',
          },
        }],
        imagePool: [],
      }),
      historyJson: JSON.stringify({
        past: [{
          nodes: [{
            id: 'node-history',
            type: 'imageNode',
            position: { x: 0, y: 0 },
            data: {
              assetId: 'asset-backed-url',
              aspectRatio: '1:1',
              prompt: 'history',
              model: 'fixture-model',
              size: '1K',
              imageUrl: 'https://example.test/history.png',
            },
          }],
          edges: [],
        }],
        future: [],
      }),
    }, await projectMutationOptions(library, 'r1'));
    const opened = await library.openProject('project-backed-url');
    const nodes = JSON.parse(opened.nodesJson);
    const history = JSON.parse(opened.historyJson);
    assert.equal(nodes.nodes[0].data.imageUrl, undefined);
    assert.equal(nodes.nodes[0].data.previewImageUrl, undefined);
    assert.equal(history.past[0].nodes[0].data.imageUrl, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
