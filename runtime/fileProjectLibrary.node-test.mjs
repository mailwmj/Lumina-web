import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalize,
  createFileProjectLibrary as createRawFileProjectLibrary,
  sha256,
  validateLibraryKey,
} from './fileProjectLibrary.mjs';

const TEST_DURABLE_FILE_OPS = Object.freeze({
  async flushFile() {},
  async atomicReplace(temporary, target) {
    await fs.rename(temporary, target);
  },
  async atomicReplaceIfLeaseCurrent(temporary, target, leasePath, expectedContents, expiresAt) {
    if (Date.now() >= expiresAt || await fs.readFile(leasePath, 'utf8') !== expectedContents) return false;
    await fs.rename(temporary, target);
    return true;
  },
  async removeIfUnchanged(target, expectedContents) {
    try {
      if (await fs.readFile(target, 'utf8') !== expectedContents) return false;
      await fs.rm(target, { force: true });
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  },
  async syncDirectory() {},
});
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function createFileProjectLibrary(options = {}) {
  return createRawFileProjectLibrary({
    ...options,
    durableFileOps: { ...TEST_DURABLE_FILE_OPS, ...(options.durableFileOps ?? {}) },
  });
}

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

test('writes asset metadata and bytes with stable integrity checks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    const result = await library.writeAsset({
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
      library.writeAsset({
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
    const result = await library.writeAsset({
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
    await library.writeAsset({
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
    for (const assetId of ['asset-cas-a', 'asset-cas-b']) {
      await first.writeAsset({
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
      { expectedRevision: 'absent', expectedAssets },
    ).catch((error) => error);
    assert.equal(firstResult.code, 'applied');
    await assert.rejects(
      second.setDeletionCandidates(
        'project-asset-cas',
        ['asset-cas-b'],
        { expectedRevision: 'absent', expectedAssets },
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
    await library.writeAsset({
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
    await library.writeAsset({
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
    }, { expectedRevision: 'absent' });
    await library.deleteProject('project-delete-reference', { expectedRevision: 'r1' });
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
    await library.writeAsset({
      assetId: 'asset-survives',
      projectId: 'project-survives',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([9, 8, 7])], { type: 'image/png' }),
    });
    failPublication = true;
    await assert.rejects(
      library.saveSnapshot(projectRecord('project-survives', 'Failed snapshot', 'r1'), { expectedRevision: 'absent' }),
      /simulated disk-full/u,
    );

    const recovered = createFileProjectLibrary({ root });
    await recovered.open();
    assert.deepEqual(
      [...new Uint8Array(await (await recovered.readAsset('asset-survives')).arrayBuffer())],
      [9, 8, 7],
    );
    assert.equal(await recovered.openProject('project-survives'), null);
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
    await library.writeAsset({
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

test('rejects duplicate, malformed, and unknown persisted JSON members', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-schema-'));
  const unknownRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-unknown-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(projectRecord('project-schema', 'Schema', 'r1'), { expectedRevision: 'absent' });
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
    await unknownLibrary.saveSnapshot(projectRecord('project-unknown', 'Unknown', 'r1'), { expectedRevision: 'absent' });
    const head = JSON.parse(await fs.readFile(path.join(unknownRoot, 'head.json'), 'utf8'));
    const catalog = JSON.parse(await fs.readFile(path.join(unknownRoot, 'commits', `${head.commitId}.json`), 'utf8'));
    const entry = catalog.projects.find((candidate) => candidate.projectId === 'project-unknown');
    const projectPath = path.join(unknownRoot, entry.manifestPath.replace(/manifest\.json$/u, 'project.json'));
    const projectDocument = JSON.parse(await fs.readFile(projectPath, 'utf8'));
    await fs.writeFile(projectPath, JSON.stringify({ ...projectDocument, unknown: true }), 'utf8');
    const unknownRecovery = createFileProjectLibrary({ root: unknownRoot });
    await unknownRecovery.open();
    assert.equal(await unknownRecovery.openProject('project-unknown'), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(unknownRoot, { recursive: true, force: true });
  }
});

test('restores the last validated catalog when the current head is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-file-library-missing-head-'));
  try {
    const library = createFileProjectLibrary({ root });
    await library.open();
    await library.saveSnapshot(projectRecord('project-journal', 'First', 'r1'), { expectedRevision: 'absent' });
    await library.rename('project-journal', 'Second', 3, { expectedRevision: 'r1' });
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
        removeIfUnchanged: async (target, expectedContents) => {
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
        atomicReplace: async (temporary, target) => {
          if (armReplacement && path.resolve(target) === path.resolve(path.join(root, 'head.json'))) {
            await fs.writeFile(lockPath, replacementContents, 'utf8');
          }
          await fs.rename(temporary, target);
        },
        atomicReplaceIfLeaseCurrent: async (temporary, target, leasePath, expectedContents, expiresAt) => {
          if (armReplacement && path.resolve(target) === path.resolve(path.join(root, 'head.json'))) {
            await fs.writeFile(lockPath, replacementContents, 'utf8');
          }
          if (Date.now() >= expiresAt || await fs.readFile(leasePath, 'utf8') !== expectedContents) return false;
          await fs.rename(temporary, target);
          return true;
        },
      },
    });
    await library.open();
    const headBefore = await fs.readFile(path.join(root, 'head.json'));
    armReplacement = true;

    await assert.rejects(
      library.saveSnapshot(projectRecord('project-head-lease', 'Lease changed', 'r1'), { expectedRevision: 'absent' }),
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
        atomicReplace: async (temporary, target) => {
          if (armReplacement && path.resolve(target) === path.resolve(journalPath)) {
            await fs.writeFile(lockPath, replacementContents, 'utf8');
          }
          await fs.rename(temporary, target);
        },
        atomicReplaceIfLeaseCurrent: async (temporary, target, leasePath, expectedContents, expiresAt) => {
          if (armReplacement && path.resolve(target) === path.resolve(journalPath)) {
            await fs.writeFile(lockPath, replacementContents, 'utf8');
          }
          if (Date.now() >= expiresAt || await fs.readFile(leasePath, 'utf8') !== expectedContents) return false;
          await fs.rename(temporary, target);
          return true;
        },
      },
    });
    await library.open();
    const headBefore = await fs.readFile(path.join(root, 'head.json'));
    armReplacement = true;

    await assert.rejects(
      library.saveSnapshot(projectRecord('project-journal-lease', 'Journal lease changed', 'r1'), { expectedRevision: 'absent' }),
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
    await library.writeAsset({
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
    const before = await fs.readFile(path.join(root, 'head.json'));
    const unsafe = projectRecord('secret-project', 'Unsafe', 'r1');
    unsafe.nodesJson = JSON.stringify({
      nodes: [{ id: 'node-1', type: 'imageNode', position: { x: 0, y: 0 }, data: { prompt: 'keep prompt', apiKey: 'provider-secret' } }],
      imagePool: [],
    });
    await assert.rejects(
      library.saveSnapshot(unsafe, { expectedRevision: 'absent' }),
      (error) => error.code === 'project_secret_admission_failed',
    );
    await assert.rejects(
      library.writeAsset({
        assetId: 'secret-asset',
        projectId: 'secret-project',
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
      library.saveSnapshot(record, { expectedRevision: 'absent' }),
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
      library.saveSnapshot(missingNodeData, { expectedRevision: 'absent' }),
      (error) => error.code === 'project_secret_admission_failed',
    );

    const invalidViewport = projectRecord('project-invalid-viewport', 'Invalid viewport', 'r1');
    invalidViewport.viewportJson = '{"x":0,"y":0,"zoom":0}';
    await assert.rejects(
      library.saveSnapshot(invalidViewport, { expectedRevision: 'absent' }),
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
        library.saveSnapshot(record, { expectedRevision: 'absent' }),
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
      library.saveSnapshot(record, { expectedRevision: 'absent' }),
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
    await library.saveSnapshot(record, { expectedRevision: 'absent' });
    const opened = await library.openProject(record.id);
    assert.deepEqual(opened.recovery, record.recovery);
    await assert.rejects(
      library.saveSnapshot({ ...record, name: 'Changed' }, { expectedRevision: 'r1' }),
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
    await library.writeAsset({
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
    }, { expectedRevision: 'absent' });
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
    await library.writeAsset({
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
    }, { expectedRevision: 'absent' });
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
    armed = true;
    await assert.rejects(
      library.writeAsset({
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
      await assert.rejects(
        writer.writeAsset({
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
    await library.saveSnapshot(projectRecord('project-lineage-cleanup', 'First', 'r1'), { expectedRevision: 'absent' });
    await library.rename('project-lineage-cleanup', 'Second', 3, { expectedRevision: 'r1' });
    await library.rename('project-lineage-cleanup', 'Third', 4, { expectedRevision: 'r2' });

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
    await library.saveSnapshot(projectRecord('project-journal-root', 'First', 'r1'), { expectedRevision: 'absent' });
    const firstHead = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    await library.rename('project-journal-root', 'Second', 3, { expectedRevision: 'r1' });
    const secondHead = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    await library.rename('project-journal-root', 'Third', 4, { expectedRevision: 'r2' });
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
  try {
    const reader = createFileProjectLibrary({ root });
    const writer = createFileProjectLibrary({ root });
    const cleaner = createFileProjectLibrary({ root, clock: () => clockNow });
    await Promise.all([reader.open(), writer.open(), cleaner.open()]);
    await writer.saveSnapshot(projectRecord('project-reader-pin', 'First', 'r1'), { expectedRevision: 'absent' });
    const initialHead = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    const initialCommit = JSON.parse(await fs.readFile(
      path.join(root, 'commits', `${initialHead.commitId}.json`),
      'utf8',
    ));
    const initialProjectPath = path.join(
      root,
      initialCommit.projects[0].manifestPath.replace(/manifest\.json$/u, 'project.json'),
    );

    const originalReadFile = fs.readFile;
    let blockProjectRead = true;
    let initialProjectReads = 0;
    let signalReadStarted;
    const readStarted = new Promise((resolve) => { signalReadStarted = resolve; });
    const readMayContinue = new Promise((resolve) => { releaseRead = resolve; });
    fs.readFile = async (target, ...arguments_) => {
      if (path.resolve(target) === path.resolve(initialProjectPath)) {
        initialProjectReads += 1;
      }
      if (blockProjectRead && initialProjectReads === 2) {
        blockProjectRead = false;
        signalReadStarted();
        await readMayContinue;
      }
      return originalReadFile(target, ...arguments_);
    };
    try {
      const reading = reader.openProject('project-reader-pin');
      await readStarted;
      await writer.rename('project-reader-pin', 'Second', 3, { expectedRevision: 'r1' });
      await writer.rename('project-reader-pin', 'Third', 4, { expectedRevision: 'r2' });
      await cleaner.cleanupOrphans();
      assert.equal(await fs.stat(initialProjectPath).then(() => true).catch(() => false), true);

      releaseRead();
      assert.equal((await reading).name, 'First');
    } finally {
      releaseRead?.();
      fs.readFile = originalReadFile;
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

function projectRecord(id, name, revision) {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 2,
    nodeCount: 0,
    schemaVersion: 1,
    revision,
    nodesJson: '{"nodes":[],"imagePool":[]}',
    edgesJson: '[]',
    viewportJson: '{"x":0,"y":0,"zoom":1}',
    historyJson: '{"past":[],"future":[]}',
  };
}
