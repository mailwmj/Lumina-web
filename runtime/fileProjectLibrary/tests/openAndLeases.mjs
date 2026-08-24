import process from 'node:process';

import { assert, canonicalize, createAssetOwner, createFileProjectLibrary, createNoDurabilityFileProjectLibrary, createProductionFileProjectLibrary, createRawFileProjectLibrary, fs, os, path, projectDeleteOptions, projectMutationOptions, projectRecord, sha256, test, TEST_DURABLE_FILE_OPS, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';

test('rejects direct caller-selected library root paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-unmanaged-root-'));
  try {
    assert.throws(
      () => createRawFileProjectLibrary({ root }),
      (error) => error.code === 'invalid_root',
    );
    assert.throws(
      () => createRawFileProjectLibrary({ dataRoot: root }),
      (error) => error.code === 'invalid_root',
    );
    assert.equal(await fs.stat(path.join(root, 'library.json')).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retries a managed lock path that disappears during canonical safety validation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-lock-race-'));
  const lockPath = path.join(root, '.library-write.lock');
  const originalRealpath = fs.realpath;
  let released = false;
  try {
    await fs.writeFile(lockPath, '', 'utf8');
    fs.realpath = async (target, ...arguments_) => {
      if (!released && path.resolve(target) === path.resolve(lockPath)) {
        released = true;
        await fs.rm(lockPath, { force: true });
        return path.resolve(root, '..', 'released-lock-target');
      }
      return originalRealpath(target, ...arguments_);
    };
    const library = createFileProjectLibrary({ root });
    await library.open();
    assert.equal(released, true);
    assert.deepEqual(await library.listProjects(), []);
  } finally {
    fs.realpath = originalRealpath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retries a Windows final-lock handle invalidated during canonical safety validation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-lock-ebadf-race-'));
  const lockPath = path.join(root, '.library-write.lock');
  const originalRealpath = fs.realpath;
  let invalidated = false;
  try {
    await fs.writeFile(lockPath, '', 'utf8');
    fs.realpath = async (target, ...arguments_) => {
      if (!invalidated && path.resolve(target) === path.resolve(lockPath)) {
        invalidated = true;
        await fs.rm(lockPath, { force: true });
        const error = new Error('The released Windows lock no longer has a valid handle.');
        error.code = 'EBADF';
        throw error;
      }
      return originalRealpath(target, ...arguments_);
    };
    const library = createFileProjectLibrary({ root });
    await library.open();
    assert.equal(invalidated, true);
    assert.deepEqual(await library.listProjects(), []);
  } finally {
    fs.realpath = originalRealpath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retries a managed lock path that disappears during native reparse probing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-lock-probe-race-'));
  const lockPath = path.join(root, '.library-write.lock');
  let released = false;
  try {
    await fs.writeFile(lockPath, '', 'utf8');
    const library = createFileProjectLibrary({
      root,
      durableFileOps: {
        async isReparsePoint(target) {
          if (!released && path.resolve(target) === path.resolve(lockPath)) {
            released = true;
            await fs.rm(lockPath, { force: true });
          }
          return (await fs.lstat(target)).isSymbolicLink();
        },
      },
    });
    await library.open();
    assert.equal(released, true);
    assert.deepEqual(await library.listProjects(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('waits out a transient Windows lock sharing violation during validation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-lock-sharing-race-'));
  const lockPath = path.join(root, '.library-write.lock');
  const originalRealpath = fs.realpath;
  let sharingViolation = false;
  try {
    await fs.writeFile(lockPath, 'stale\n', 'utf8');
    const staleAt = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, staleAt, staleAt);
    fs.realpath = async (target, ...arguments_) => {
      if (!sharingViolation && path.resolve(target) === path.resolve(lockPath)) {
        sharingViolation = true;
        const error = new Error('The lock is temporarily held by another opener.');
        error.code = 'EPERM';
        throw error;
      }
      return originalRealpath(target, ...arguments_);
    };
    const library = createFileProjectLibrary({ root });
    await library.open();
    assert.equal(sharingViolation, true);
    assert.deepEqual(await library.listProjects(), []);
  } finally {
    fs.realpath = originalRealpath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retries a transient Windows lock sharing violation during lease acquisition', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-lock-open-race-'));
  const lockPath = path.join(root, '.library-write.lock');
  const originalOpen = fs.open;
  let sharingViolation = false;
  try {
    fs.open = async (target, ...arguments_) => {
      if (!sharingViolation
        && path.resolve(target) === path.resolve(lockPath)
        && arguments_[0] === 'wx') {
        sharingViolation = true;
        const error = new Error('The lock is temporarily held by another opener.');
        error.code = 'EPERM';
        throw error;
      }
      return originalOpen(target, ...arguments_);
    };
    const library = createFileProjectLibrary({ root });
    await library.open();
    assert.equal(sharingViolation, true);
    assert.deepEqual(await library.listProjects(), []);
  } finally {
    fs.open = originalOpen;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uses the production DurableFileOps backend for a durable library write', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-durability-'));
  try {
    const library = createProductionFileProjectLibrary({ root });
    await library.open();
    const applied = await library.saveSnapshot(
      projectRecord('project-production-durability', 'Production durability', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );
    assert.equal(applied.code, 'applied');
    assert.equal((await library.openProject('project-production-durability')).revision, 'r1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects a Windows junction selected as the managed library root', async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-junction-target-'));
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-junction-parent-'));
  const junction = path.join(parent, 'library');
  try {
    await fs.symlink(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
    const library = createProductionFileProjectLibrary({ root: junction });
    await assert.rejects(library.open(), (error) => error.code === 'path_escape');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  }
});

test('does not let a caller replace the production DurableFileOps backend', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-noop-durability-'));
  try {
    const library = createProductionFileProjectLibrary({ root, durableFileOps: TEST_DURABLE_FILE_OPS });
    await library.open();
    assert.equal(await fs.stat(path.join(root, 'library.json')).then(() => true).catch(() => false), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fails closed without a selected DurableFileOps backend', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-unwrapped-test-ops-'));
  try {
    const library = createNoDurabilityFileProjectLibrary({ root });
    await assert.rejects(library.open(), (error) => error.code === 'durability_unavailable');
    assert.equal(await fs.stat(path.join(root, 'library.json')).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ignores a forged native DurableFileOps object from a caller', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-forged-native-'));
  try {
    const library = createProductionFileProjectLibrary({
      root,
      nativeDurableFileOps: {
        ...TEST_DURABLE_FILE_OPS,
        platform: process.platform,
        native: true,
        conformance: 'forged',
      },
    });
    await library.open();
    assert.equal(await fs.stat(path.join(root, 'library.json')).then(() => true).catch(() => false), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('creates, saves, opens, and lists a ProjectRecord snapshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();

    const record = {
      id: 'project-1',
      name: 'First project',
      createdAt: 1,
      updatedAt: 2,
      nodeCount: 0,
      schemaVersion: 1,
      revision: 'r1',
      nodesJson: '{"nodes":[],"imagePool":[]}',
      edgesJson: '[]',
      viewportJson: '{"x":0,"y":0,"zoom":1}',
      historyJson: '{"past":[],"future":[]}',
    };

    const applied = await library.saveSnapshot(record, await projectMutationOptions(library, 'absent'));
    assert.equal(applied.code, 'applied');
    assert.equal(applied.revision, 'r1');
    assert.equal(applied.record.id, record.id);

    const opened = await library.openProject(record.id);
    assert.equal(opened.id, record.id);
    assert.equal(opened.name, record.name);
    assert.equal(opened.revision, record.revision);
    assert.deepEqual(JSON.parse(opened.nodesJson), JSON.parse(record.nodesJson));
    assert.deepEqual(JSON.parse(opened.edgesJson), JSON.parse(record.edgesJson));
    assert.deepEqual(JSON.parse(opened.viewportJson), JSON.parse(record.viewportJson));
    assert.deepEqual(JSON.parse(opened.historyJson), JSON.parse(record.historyJson));
    assert.deepEqual(await library.listProjects(), [{
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      nodeCount: record.nodeCount,
    }]);

    const head = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    assert.match(head.commitId, /^c_[0-9a-f]{32}$/u);
    assert.match(head.previousCommitId, /^c_[0-9a-f]{32}$/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('syncs every final payload parent through the library root before journaling the head', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-parent-sync-'));
  const synchronized = [];
  let synchronizedBeforeJournal = null;
  let enforcePublication = false;
  try {
    const library = createFileProjectLibrary({
      root,
      durableFileOps: {
        syncDirectory: async (directory) => {
          synchronized.push(path.resolve(directory));
        },
        atomicReplaceManaged: async (managedRoot, temporary, target) => {
          await fs.rename(path.join(managedRoot, temporary), path.join(managedRoot, target));
        },
        atomicReplaceIfLeaseCurrentManaged: async (managedRoot, temporary, target, leasePath, expectedContents, expiresAt) => {
          if (enforcePublication && path.basename(target) === 'head.previous.json') {
            synchronizedBeforeJournal = new Set(synchronized);
          }
          if (Date.now() >= expiresAt || await fs.readFile(path.join(managedRoot, leasePath), 'utf8') !== expectedContents) return false;
          await fs.rename(path.join(managedRoot, temporary), path.join(managedRoot, target));
          return true;
        },
      },
    });
    await library.open();
    synchronized.length = 0;
    enforcePublication = true;
    await library.saveSnapshot(
      projectRecord('project-parent-sync', 'Parent sync', 'r1'),
      await projectMutationOptions(library, 'absent'),
    );

    const head = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    const commit = JSON.parse(await fs.readFile(path.join(root, 'commits', `${head.commitId}.json`), 'utf8'));
    const snapshotDirectory = path.dirname(path.join(root, commit.projects[0].manifestPath));
    const expectedDirectories = [];
    for (let current = snapshotDirectory; ; current = path.dirname(current)) {
      expectedDirectories.push(current);
      if (path.resolve(current) === path.resolve(root)) break;
    }
    assert.ok(synchronizedBeforeJournal);
    for (const directory of expectedDirectories) {
      assert.equal(synchronizedBeforeJournal.has(path.resolve(directory)), true, directory);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('round-trips the legacy array-shaped nodesJson without a page-model rewrite', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-array-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const record = projectRecord('project-array', 'Array nodes', 'r1');
     record.nodesJson = '[{"id":"node-1","type":"textAnnotationNode","position":{"x":1,"y":2},"data":{"content":"legacy note"}}]';
    await library.saveSnapshot(record, await projectMutationOptions(library, 'absent'));
    const opened = await library.openProject(record.id);
    assert.deepEqual(JSON.parse(opened.nodesJson), JSON.parse(record.nodesJson));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('requires a complete catalog and project revision for every project mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-project-preconditions-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const record = projectRecord('project-preconditions', 'Preconditions', 'r1');
    await assert.rejects(
      library.saveSnapshot(record, { expectedRevision: 'absent' }),
      (error) => error.code === 'catalog_precondition_required',
    );
    const initialCatalog = (await library.open()).revision;
    await assert.rejects(
      library.saveSnapshot(record, { expectedCatalog: initialCatalog }),
      (error) => error.code === 'project_precondition_required',
    );
    const saved = await library.saveSnapshot(record, {
      expectedCatalog: initialCatalog,
      expectedRevision: 'absent',
    });
    await assert.rejects(
      library.rename(record.id, 'Revision only', 3, { expectedRevision: 'r1' }),
      (error) => error.code === 'catalog_precondition_required',
    );
    await assert.rejects(
      library.rename(record.id, 'Catalog only', 3, { expectedCatalog: saved.catalog }),
      (error) => error.code === 'project_precondition_required',
    );
    await assert.rejects(
      library.rename(record.id, 'Incomplete catalog', 3, {
        expectedCatalog: { commitId: saved.catalog.commitId, sequence: saved.catalog.sequence },
        expectedRevision: 'r1',
      }),
      (error) => error.code === 'catalog_precondition_required',
    );
    assert.equal((await library.openProject(record.id)).name, record.name);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fences stale project mutations and serializes concurrent writers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-'));
  try {
    const first = createFileProjectLibrary({ root });
    const second = createFileProjectLibrary({ root });
    await first.open();
    const initial = projectRecord('project-revision', 'Initial', 'r1');
    await first.saveSnapshot(initial, await projectMutationOptions(first, 'absent'));

    const viewport = await first.updateViewport(
      initial.id,
      '{"x":4,"y":5,"zoom":1.25}',
      await projectMutationOptions(first, 'r1'),
    );
    assert.equal(viewport.code, 'applied');
    assert.equal(viewport.revision, 'r2');

    const headBeforeStale = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    await assert.rejects(
      first.rename(initial.id, 'stale rename', 4, await projectMutationOptions(first, 'r1')),
      (error) => error.code === 'stale_revision' && error.actualRevision === 'r2',
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8')),
      headBeforeStale,
    );

    const renamed = await second.rename(initial.id, 'Renamed', 4, await projectMutationOptions(second, 'r2'));
    assert.equal(renamed.revision, 'r3');
    assert.equal((await second.openProject(initial.id)).name, 'Renamed');

    const deleted = await first.delete(initial.id, await projectDeleteOptions(first, initial.id, 'r3', renamed.catalog));
    assert.equal(deleted.code, 'deleted');
    assert.equal(await first.openProject(initial.id), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('serializes Promise.all writers at the library lease boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-concurrent-'));
  try {
    const first = createFileProjectLibrary({ root });
    const second = createFileProjectLibrary({ root });
    await Promise.all([first.open(), second.open()]);
    const initial = projectRecord('project-promise-all', 'Initial', 'r1');
    await first.saveSnapshot(initial, await projectMutationOptions(first, 'absent'));

    const expectedCatalog = (await first.open()).revision;
    const outcomes = await Promise.allSettled([
      first.rename(initial.id, 'Writer one', 3, { expectedCatalog, expectedRevision: 'r1' }),
      second.rename(initial.id, 'Writer two', 4, { expectedCatalog, expectedRevision: 'r1' }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.equal(rejected.reason.code, 'stale_catalog');
    assert.equal((await first.openProject(initial.id)).revision, 'r2');
    assert.match((await first.openProject(initial.id)).name, /^Writer (?:one|two)$/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects a non-monotonic requested project revision before publication', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-revision-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const initial = projectRecord('project-monotonic', 'Initial', 'r1');
    await library.saveSnapshot(initial, await projectMutationOptions(library, 'absent'));
    const before = await fs.readFile(path.join(root, 'head.json'));
    await assert.rejects(
      library.saveSnapshot(
        { ...initial, name: 'Skipped', revision: 'r3' },
        await projectMutationOptions(library, 'r1'),
      ),
      (error) => error.code === 'non_monotonic_revision',
    );
    assert.deepEqual(await fs.readFile(path.join(root, 'head.json')), before);
    assert.equal((await library.openProject(initial.id)).revision, 'r1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
