import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { createFileProjectLibrary } from '../../fileProjectLibrary.mjs';
import { MAX_DURABLE_ASSET_BYTES, sha256 } from '../core.mjs';
import { createTestDurableFileOps } from '../durableFileOps.mjs';
import { createTestManagedLibraryRoot, resolveManagedLibraryRoot } from '../managedRoot.mjs';
import { createSecureTemporaryDirectory } from '../testSupport.mjs';

const TEST_DURABLE_FILE_OPS = Object.freeze({
  async flushFile() {},
  async ensureDirectory(root, relative) {
    await fs.mkdir(path.join(root, relative), { recursive: true });
  },
  async ensureRootDirectory(root) {
    await fs.mkdir(root, { recursive: true });
  },
  async createNewManagedFileManaged(root, relative) {
    return fs.open(path.join(root, relative), 'wx');
  },
  async writeManagedFileManaged(_root, handle, bytes) {
    return (await handle.write(bytes)).bytesWritten;
  },
  async closeManagedFileManaged(_root, handle) {
    await handle.close();
  },
  async isReparsePoint(target) {
    return (await fs.lstat(target)).isSymbolicLink();
  },
  async atomicReplace(temporary, target) {
    await fs.rename(temporary, target);
  },
  async atomicReplaceIfLeaseCurrent(temporary, target, leasePath, expectedContents, expiresAt) {
    if (Date.now() >= expiresAt || await fs.readFile(leasePath, 'utf8') !== expectedContents) return false;
    await fs.rename(temporary, target);
    return true;
  },
  async atomicReplaceManaged(root, temporary, target) {
    await fs.rename(path.join(root, temporary), path.join(root, target));
  },
  async atomicReplaceIfLeaseCurrentManaged(root, temporary, target, leasePath, expectedContents, expiresAt) {
    if (Date.now() >= expiresAt || await fs.readFile(path.join(root, leasePath), 'utf8') !== expectedContents) return false;
    await fs.rename(path.join(root, temporary), path.join(root, target));
    return true;
  },
  async copyFileManaged(root, source, target) {
    await fs.copyFile(path.join(root, source), path.join(root, target), fs.constants?.COPYFILE_EXCL ?? 1);
  },
  async removeDirectoryManaged(root, relative) {
    await fs.rmdir(path.join(root, relative));
    return true;
  },
  async removeIfUnchanged(root, relative, expectedContents) {
    const target = path.join(root, relative);
    try {
      const actual = await fs.readFile(target);
      if (typeof expectedContents === 'string') {
        if (actual.toString('utf8') !== expectedContents) return false;
      } else if (!expectedContents || sha256(actual) !== expectedContents.sha256) {
        return false;
      }
      await fs.rm(target, { force: true });
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  },
  async syncDirectory() {},
});

function createLibrary(root, options = {}) {
  return createFileProjectLibrary({
    ...options,
    testManagedRoot: createTestManagedLibraryRoot(root),
    testDurableFileOps: createTestDurableFileOps({
      ...TEST_DURABLE_FILE_OPS,
      ...(options.durableFileOps ?? {}),
    }),
  });
}

function projectRecord(id, overrides = {}) {
  return {
    id,
    name: `Project ${id}`,
    createdAt: 1,
    updatedAt: 2,
    nodeCount: 0,
    schemaVersion: 1,
    nodesJson: '{"nodes":[],"imagePool":[]}',
    edgesJson: '[]',
    viewportJson: '{"x":0,"y":0,"zoom":1}',
    historyJson: '{"past":[],"future":[]}',
    ...overrides,
  };
}

async function temporaryRoot(prefix) {
  return createSecureTemporaryDirectory(prefix);
}

async function exists(target) {
  return fs.stat(target).then(() => true).catch(() => false);
}

test('selects the documented managed library root for each supported platform', () => {
  assert.equal(
    resolveManagedLibraryRoot({
      platform: 'darwin',
      homeDirectory: '/Users/test',
      environment: {},
    }),
    path.join('/Users/test', 'Library', 'Application Support', 'Lumina', 'library'),
  );
  assert.equal(
    resolveManagedLibraryRoot({
      platform: 'win32',
      homeDirectory: 'C:\\Users\\test',
      environment: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    }),
    path.win32.join('C:\\Users\\test\\AppData\\Local', 'Lumina', 'library'),
  );
  assert.equal(
    resolveManagedLibraryRoot({
      platform: 'linux',
      homeDirectory: '/home/test',
      environment: {},
    }),
    path.join('/home/test', '.local', 'share', 'Lumina', 'library'),
  );
  assert.equal(
    resolveManagedLibraryRoot({
      platform: 'linux',
      homeDirectory: '/home/test',
      environment: { XDG_DATA_HOME: '/srv/data' },
    }),
    path.join('/srv/data', 'Lumina', 'library'),
  );
});

test('uses only a managed root capability and starts with an empty atomic head', async () => {
  const root = await temporaryRoot('lumina-runtime-library-root-');
  try {
    assert.throws(() => createFileProjectLibrary({ root }), (error) => error.code === 'invalid_root');
    const library = createLibrary(root);
    await library.open();
    assert.deepEqual(await library.listProjects(), []);
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'))), [
      'assets', 'format', 'projects', 'version',
    ]);
    for (const obsolete of ['commits', 'attachments', 'migrations', 'maintenance', 'quarantine', 'trash']) {
      assert.equal(await exists(path.join(root, obsolete)), false);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('persists complete project snapshots across runtime restarts without revisions', async () => {
  const root = await temporaryRoot('lumina-runtime-library-project-');
  try {
    const first = createLibrary(root);
    const saved = await first.saveSnapshot(projectRecord('project-1'));
    assert.equal(saved.id, 'project-1');
    assert.equal(Object.hasOwn(saved, 'revision'), false);
    assert.deepEqual(await first.listProjects(), [{
      id: 'project-1',
      name: 'Project project-1',
      createdAt: 1,
      updatedAt: 2,
      nodeCount: 0,
    }]);
    await first.close();

    const second = createLibrary(root);
    const opened = await second.openProject('project-1');
    assert.deepEqual(opened, saved);
    await second.renameProject('project-1', 'Renamed', 3);
    await second.updateViewport('project-1', '{"x":8,"y":9,"zoom":1.5}');
    const updated = await second.openProject('project-1');
    assert.equal(updated.name, 'Renamed');
    assert.deepEqual(JSON.parse(updated.viewportJson), { x: 8, y: 9, zoom: 1.5 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('streams project-owned assets and verifies bytes on every read', async () => {
  const root = await temporaryRoot('lumina-runtime-library-asset-');
  try {
    class StreamingBlob extends Blob {
      arrayBuffer() {
        throw new Error('whole-buffer asset reads are forbidden during writes');
      }
    }
    const library = createLibrary(root);
    await library.saveSnapshot(projectRecord('project-assets'));
    const metadata = await library.writeAsset({
      assetId: 'asset-1',
      projectId: 'project-assets',
      kind: 'image',
      sourceKind: 'import',
      blob: new StreamingBlob([Uint8Array.from([1, 2, 3, 4])], { type: 'image/png' }),
      width: 2,
      height: 2,
      createdAt: 4,
      sourceMetadata: { fileName: 'fixture.png' },
    });
    assert.deepEqual(metadata, {
      assetId: 'asset-1',
      projectId: 'project-assets',
      kind: 'image',
      mimeType: 'image/png',
      byteCount: 4,
      createdAt: 4,
      sourceKind: 'import',
      width: 2,
      height: 2,
      durationMs: null,
      sourceMetadata: { fileName: 'fixture.png' },
    });
    assert.deepEqual(
      [...new Uint8Array(await (await library.readAsset('asset-1')).arrayBuffer())],
      [1, 2, 3, 4],
    );

    const head = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    await fs.writeFile(path.join(root, head.assets[0].bytesPath), Uint8Array.from([9, 9, 9, 9]));
    await assert.rejects(library.readAsset('asset-1'), (error) => error.code === 'corrupt_schema');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('protects assets referenced only by project history and deletes unreferenced assets immediately', async () => {
  const root = await temporaryRoot('lumina-runtime-library-reference-');
  try {
    const library = createLibrary(root);
    await library.saveSnapshot(projectRecord('project-reference'));
    await library.writeAsset({
      assetId: 'asset-history',
      projectId: 'project-reference',
      kind: 'image',
      sourceKind: 'derived',
      blob: new Blob([Uint8Array.from([5, 6])], { type: 'image/png' }),
      createdAt: 3,
    });
    const historyNode = {
      id: 'image-history',
      type: 'imageNode',
      position: { x: 1, y: 2 },
      data: {
        assetId: 'asset-history',
        aspectRatio: '1:1',
        prompt: 'history fixture',
        model: 'fal/nano-banana-2',
        size: '1K',
        extraParams: { thinking_level: 'off' },
      },
    };
    await library.saveSnapshot(projectRecord('project-reference', {
      historyJson: JSON.stringify({ past: [{ nodes: [historyNode], edges: [] }], future: [] }),
    }));
    await assert.rejects(
      library.deleteAsset('asset-history'),
      (error) => error.code === 'asset_still_referenced',
    );

    await library.saveSnapshot(projectRecord('project-reference', { updatedAt: 4 }));
    assert.equal(await library.deleteAsset('asset-history'), true);
    assert.equal(await library.getAssetMetadata('asset-history'), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('publishes project and owned-asset removal in one head before contained cleanup', async () => {
  const root = await temporaryRoot('lumina-runtime-library-delete-');
  try {
    const library = createLibrary(root);
    await library.saveSnapshot(projectRecord('project-delete'));
    await library.writeAsset({
      assetId: 'asset-delete',
      projectId: 'project-delete',
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([7])], { type: 'image/png' }),
      createdAt: 3,
    });
    assert.equal(await library.deleteProject('project-delete'), true);
    assert.equal(await library.openProject('project-delete'), null);
    assert.equal(await library.readAsset('asset-delete'), null);
    const head = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    assert.deepEqual(head.projects, []);
    assert.deepEqual(head.assets, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a failed head replacement leaves the previous complete snapshot visible after restart', async () => {
  const root = await temporaryRoot('lumina-runtime-library-atomic-');
  let failPublication = false;
  try {
    const library = createLibrary(root, {
      faultInjector: async (phase, details) => {
        if (failPublication && phase === 'before-secure-replace' && path.basename(details.target) === 'head.json') {
          throw new Error('simulated publication interruption');
        }
      },
    });
    await library.saveSnapshot(projectRecord('project-atomic'));
    failPublication = true;
    await assert.rejects(
      library.saveSnapshot(projectRecord('project-atomic', { name: 'Invisible interrupted update', updatedAt: 3 })),
      /simulated publication interruption/u,
    );
    await library.close();

    const reopened = createLibrary(root);
    assert.equal((await reopened.openProject('project-atomic')).name, 'Project project-atomic');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup removes only known interrupted staging transactions', async () => {
  const root = await temporaryRoot('lumina-runtime-library-staging-');
  try {
    const first = createLibrary(root);
    await first.open();
    await first.close();
    const interrupted = path.join(root, 'staging', 't_00000000000000000000000000000000');
    await fs.mkdir(interrupted);
    await fs.writeFile(path.join(interrupted, 'payload.tmp'), 'interrupted');
    await fs.writeFile(path.join(root, 'unmanaged-evidence.txt'), 'keep');

    const second = createLibrary(root);
    await second.open();
    assert.equal(await exists(interrupted), false);
    assert.equal(await fs.readFile(path.join(root, 'unmanaged-evidence.txt'), 'utf8'), 'keep');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects a second writer when the process lease is held through publication', async () => {
  const root = await temporaryRoot('lumina-runtime-library-lock-');
  let releasePublication;
  const publicationReleased = new Promise((resolve) => { releasePublication = resolve; });
  let publicationReached;
  const reachedPublication = new Promise((resolve) => { publicationReached = resolve; });
  let block = false;
  try {
    const first = createLibrary(root, {
      faultInjector: async (phase, details) => {
        if (block && phase === 'before-secure-replace' && path.basename(details.target) === 'head.json') {
          publicationReached();
          await publicationReleased;
        }
      },
    });
    await first.open();
    block = true;
    const firstSave = first.saveSnapshot(projectRecord('project-lock'));
    await reachedPublication;

    const second = createLibrary(root, { lockTimeoutMs: 25 });
    await assert.rejects(second.saveSnapshot(projectRecord('project-other')), (error) => error.code === 'library_busy');
    releasePublication();
    await firstSave;
  } finally {
    releasePublication?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recovers a corrupt current head from the last complete recovery anchor', async () => {
  const root = await temporaryRoot('lumina-runtime-library-head-recovery-');
  try {
    const first = createLibrary(root);
    await first.saveSnapshot(projectRecord('project-recovered'));
    await first.close();
    await fs.writeFile(path.join(root, 'head.json'), '{"broken":true}', 'utf8');

    const reopened = createLibrary(root);
    assert.equal((await reopened.openProject('project-recovered')).id, 'project-recovered');
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8')),
      JSON.parse(await fs.readFile(path.join(root, 'head.previous.json'), 'utf8')),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recovers an interrupted empty initialization but never replaces existing payload with an empty head', async () => {
  const emptyRoot = await temporaryRoot('lumina-runtime-library-empty-bootstrap-');
  const dataRoot = await temporaryRoot('lumina-runtime-library-missing-head-');
  try {
    const empty = createLibrary(emptyRoot);
    await empty.open();
    await empty.close();
    await fs.rm(path.join(emptyRoot, 'head.json'));
    await fs.rm(path.join(emptyRoot, 'head.previous.json'));
    assert.deepEqual(await createLibrary(emptyRoot).listProjects(), []);

    const populated = createLibrary(dataRoot);
    await populated.saveSnapshot(projectRecord('project-preserved'));
    await populated.close();
    await fs.rm(path.join(dataRoot, 'head.json'));
    await fs.rm(path.join(dataRoot, 'head.previous.json'));
    await assert.rejects(
      createLibrary(dataRoot).open(),
      (error) => error.code === 'recovery_required',
    );
    assert.equal(
      (await fs.readdir(path.join(dataRoot, 'projects'), { recursive: true })).length > 0,
      true,
    );
  } finally {
    await fs.rm(emptyRoot, { recursive: true, force: true });
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test('keeps traversal-shaped logical IDs opaque and rejects obsolete project concurrency fields', async () => {
  const root = await temporaryRoot('lumina-runtime-library-opaque-ids-');
  try {
    const library = createLibrary(root);
    const projectId = '../../outside-project';
    await library.saveSnapshot(projectRecord(projectId));
    await library.writeAsset({
      assetId: '../outside-asset',
      projectId,
      kind: 'image',
      sourceKind: 'import',
      blob: new Blob([Uint8Array.from([1])], { type: 'image/png' }),
      createdAt: 3,
    });
    const head = JSON.parse(await fs.readFile(path.join(root, 'head.json'), 'utf8'));
    assert.match(head.projects[0].snapshotPath, /^projects\/p_[0-9a-f]{32}\/snapshots\/[0-9a-f]{64}\.json$/u);
    assert.match(head.assets[0].bytesPath, /^assets\/a_[0-9a-f]{32}\/bytes\.bin$/u);
    assert.equal(head.projects[0].snapshotPath.includes(projectId), false);
    assert.equal(head.assets[0].bytesPath.includes('outside-asset'), false);

    await assert.rejects(
      library.saveSnapshot({ ...projectRecord('legacy-revision'), revision: 'r1' }),
      (error) => error.code === 'invalid_project',
    );
    await assert.rejects(
      library.saveSnapshot({
        ...projectRecord('legacy-recovery'),
        recovery: { reason: 'migration_failed' },
      }),
      (error) => error.code === 'invalid_project',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects oversized assets before opening a staging file', async () => {
  const root = await temporaryRoot('lumina-runtime-library-asset-limit-');
  try {
    class OversizedBlob extends Blob {
      get size() {
        return MAX_DURABLE_ASSET_BYTES + 1;
      }
    }
    const library = createLibrary(root);
    await library.saveSnapshot(projectRecord('project-limit'));
    await assert.rejects(
      library.writeAsset({
        assetId: 'oversized-asset',
        projectId: 'project-limit',
        kind: 'image',
        sourceKind: 'import',
        blob: new OversizedBlob([], { type: 'image/png' }),
      }),
      (error) => error.code === 'asset_too_large',
    );
    assert.deepEqual(await fs.readdir(path.join(root, 'staging')), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects a symlink or junction selected as the managed root', async (t) => {
  const target = await temporaryRoot('lumina-runtime-library-link-target-');
  const parent = await temporaryRoot('lumina-runtime-library-link-parent-');
  const link = path.join(parent, 'library');
  try {
    try {
      await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
        t.skip('symlink creation is unavailable in this environment');
        return;
      }
      throw error;
    }
    await assert.rejects(createLibrary(link).open(), (error) => error.code === 'path_escape');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  }
});
