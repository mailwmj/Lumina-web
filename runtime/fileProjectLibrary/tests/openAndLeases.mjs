import process from 'node:process';

import { assert, canonicalize, createAssetOwner, createFileProjectLibrary, createRawFileProjectLibrary, fs, NATIVE_DURABLE_FILE_OPS_CONFORMANCE, os, path, projectRecord, sha256, test, TEST_DURABLE_FILE_OPS, THIRTY_DAYS_MS, validateLibraryKey, writeOwnedAsset } from './testSupport.mjs';

test('requires a complete DurableFileOps seam before writing library data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-durability-'));
  try {
    const library = createRawFileProjectLibrary({ root });
    await assert.rejects(library.open(), (error) => error.code === 'durability_unavailable');
    assert.equal(await fs.stat(path.join(root, 'library.json')).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('fails closed when a caller supplies a no-op DurableFileOps object', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-noop-durability-'));
  try {
    const library = createRawFileProjectLibrary({ root, durableFileOps: TEST_DURABLE_FILE_OPS });
    await assert.rejects(library.open(), (error) => error.code === 'durability_unavailable');
    assert.equal(await fs.stat(path.join(root, 'library.json')).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('does not accept unwrapped test file operations as a durable backend', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-unwrapped-test-ops-'));
  try {
    const library = createRawFileProjectLibrary({ root, testDurableFileOps: TEST_DURABLE_FILE_OPS });
    await assert.rejects(library.open(), (error) => error.code === 'durability_unavailable');
    assert.equal(await fs.stat(path.join(root, 'library.json')).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fails closed when a caller forges native DurableFileOps conformance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-forged-native-'));
  try {
    const library = createRawFileProjectLibrary({
      root,
      nativeDurableFileOps: {
        ...TEST_DURABLE_FILE_OPS,
        platform: process.platform,
        native: true,
        conformance: NATIVE_DURABLE_FILE_OPS_CONFORMANCE,
      },
    });
    await assert.rejects(library.open(), (error) => error.code === 'durability_unavailable');
    assert.equal(await fs.stat(path.join(root, 'library.json')).then(() => true).catch(() => false), false);
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

    const applied = await library.saveSnapshot(record, { expectedRevision: 'absent' });
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
        atomicReplace: async (temporary, target) => {
          await fs.rename(temporary, target);
        },
        atomicReplaceIfLeaseCurrent: async (temporary, target, leasePath, expectedContents, expiresAt) => {
          if (enforcePublication && path.basename(target) === 'head.previous.json') {
            synchronizedBeforeJournal = new Set(synchronized);
          }
          if (Date.now() >= expiresAt || await fs.readFile(leasePath, 'utf8') !== expectedContents) return false;
          await fs.rename(temporary, target);
          return true;
        },
      },
    });
    await library.open();
    synchronized.length = 0;
    enforcePublication = true;
    await library.saveSnapshot(projectRecord('project-parent-sync', 'Parent sync', 'r1'), { expectedRevision: 'absent' });

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
    await library.saveSnapshot(record, { expectedRevision: 'absent' });
    const opened = await library.openProject(record.id);
    assert.deepEqual(JSON.parse(opened.nodesJson), JSON.parse(record.nodesJson));
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
    await first.saveSnapshot(initial, { expectedRevision: 'absent' });

    const viewport = await first.updateViewport(
      initial.id,
      '{"x":4,"y":5,"zoom":1.25}',
      { expectedRevision: 'r1' },
    );
    assert.equal(viewport.code, 'applied');
    assert.equal(viewport.revision, 'r2');

    const headBeforeStale = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    await assert.rejects(
      first.rename(initial.id, 'stale rename', 4, { expectedRevision: 'r1' }),
      (error) => error.code === 'stale_revision' && error.actualRevision === 'r2',
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8')),
      headBeforeStale,
    );

    const renamed = await second.rename(initial.id, 'Renamed', 4, { expectedRevision: 'r2' });
    assert.equal(renamed.revision, 'r3');
    assert.equal((await second.openProject(initial.id)).name, 'Renamed');

    const deleted = await first.delete(initial.id, { expectedRevision: 'r3' });
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
    await first.saveSnapshot(initial, { expectedRevision: 'absent' });

    const outcomes = await Promise.allSettled([
      first.rename(initial.id, 'Writer one', 3, { expectedRevision: 'r1' }),
      second.rename(initial.id, 'Writer two', 4, { expectedRevision: 'r1' }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.equal(rejected.reason.code, 'stale_revision');
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
    await library.saveSnapshot(initial, { expectedRevision: 'absent' });
    const before = await fs.readFile(path.join(root, 'head.json'));
    await assert.rejects(
      library.saveSnapshot({ ...initial, name: 'Skipped', revision: 'r3' }, { expectedRevision: 'r1' }),
      (error) => error.code === 'non_monotonic_revision',
    );
    assert.deepEqual(await fs.readFile(path.join(root, 'head.json')), before);
    assert.equal((await library.openProject(initial.id)).revision, 'r1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
