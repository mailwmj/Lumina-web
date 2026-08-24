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
} from '../../fileProjectLibrary.mjs';
import { createTestDurableFileOps, NATIVE_DURABLE_FILE_OPS_CONFORMANCE } from '../durableFileOps.mjs';
import { createTestManagedLibraryRoot } from '../managedRoot.mjs';

const TEST_DURABLE_FILE_OPS = Object.freeze({
  async flushFile() {},
  async ensureDirectory(root, relative) {
    await fs.mkdir(path.join(root, relative), { recursive: true });
  },
  async ensureRootDirectory(root) {
    await fs.mkdir(root, { recursive: true });
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
    await fs.copyFile(path.join(root, source), path.join(root, target));
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

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TEST_EMPTY_TRASH_AUTHORIZATION = 'test-empty-trash-authorization';

async function TEST_EMPTY_TRASH_AUTHORIZER(request) {
  return request?.authorization === TEST_EMPTY_TRASH_AUTHORIZATION;
}

function createProductionFileProjectLibrary(options = {}) {
  const { root, dataRoot, ...libraryOptions } = options;
  const selectedRoot = root ?? dataRoot;
  if (typeof selectedRoot !== 'string' || selectedRoot.trim() === '') {
    throw new TypeError('An isolated test library requires a root.');
  }
  return createRawFileProjectLibrary({
    ...libraryOptions,
    testManagedRoot: createTestManagedLibraryRoot(selectedRoot),
  });
}

function createFileProjectLibrary(options = {}) {
  const {
    root,
    dataRoot,
    durableFileOps,
    testDurableFileOps,
    emptyTrashAuthorizer = TEST_EMPTY_TRASH_AUTHORIZER,
    ...libraryOptions
  } = options;
  const selectedRoot = root ?? dataRoot;
  if (typeof selectedRoot !== 'string' || selectedRoot.trim() === '') {
    throw new TypeError('An isolated test library requires a root.');
  }
  return createRawFileProjectLibrary({
    ...libraryOptions,
    emptyTrashAuthorizer,
    testManagedRoot: createTestManagedLibraryRoot(selectedRoot),
    // Functional fixtures exercise library behavior, not native durability.
    testDurableFileOps: createTestDurableFileOps({
      ...TEST_DURABLE_FILE_OPS,
      ...(durableFileOps ?? {}),
      ...(testDurableFileOps ?? {}),
    }),
  });
}

function createNoDurabilityFileProjectLibrary(options = {}) {
  const { root, dataRoot, ...libraryOptions } = options;
  const selectedRoot = root ?? dataRoot;
  if (typeof selectedRoot !== 'string' || selectedRoot.trim() === '') {
    throw new TypeError('An isolated test library requires a root.');
  }
  return createRawFileProjectLibrary({
    ...libraryOptions,
    testManagedRoot: createTestManagedLibraryRoot(selectedRoot),
    testDurableFileOps: createTestDurableFileOps(null),
  });
}

async function writeOwnedAsset(library, input, writeOptions = undefined) {
  const owner = await library.openProject(input.projectId);
  assert.ok(owner, `Test asset owner ${input.projectId} must exist.`);
  const catalog = (await library.open()).revision;
  return library.writeAsset(input, writeOptions ?? {
    expectedCatalog: catalog,
    expectedProjectRevision: owner.revision,
  });
}

async function createAssetOwner(library, projectId) {
  return library.saveSnapshot(
    projectRecord(projectId, `Asset owner ${projectId}`, 'r1'),
    await projectMutationOptions(library, 'absent'),
  );
}

async function projectMutationOptions(library, expectedRevision) {
  return {
    expectedCatalog: (await library.open()).revision,
    expectedRevision,
  };
}

async function assetLifecycleOptions(library, projectId, expectedRevision, assetIds) {
  const expectedAssets = [];
  for (const assetId of assetIds) {
    const metadata = await library.getAssetMetadata(assetId);
    assert.ok(metadata, `Test lifecycle asset ${assetId} must exist.`);
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
  expectedAssets.sort((left, right) => left.assetId.localeCompare(right.assetId));
  return {
    expectedCatalog: (await library.open()).revision,
    expectedRevision,
    expectedAssets,
  };
}

async function emptyTrashOptions(root, deletionId) {
  const manifestBytes = await fs.readFile(path.join(root, 'trash', deletionId, 'manifest.json'));
  return {
    emptyTrash: {
      deletionId,
      trashManifestSha256: sha256(manifestBytes),
      authorization: TEST_EMPTY_TRASH_AUTHORIZATION,
    },
  };
}

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

export {
  assert,
  assetLifecycleOptions,
  canonicalize,
  createAssetOwner,
  createFileProjectLibrary,
  createNoDurabilityFileProjectLibrary,
  createProductionFileProjectLibrary,
  createRawFileProjectLibrary,
  emptyTrashOptions,
  fs,
  NATIVE_DURABLE_FILE_OPS_CONFORMANCE,
  os,
  path,
  projectMutationOptions,
  projectRecord,
  sha256,
  test,
  TEST_DURABLE_FILE_OPS,
  TEST_EMPTY_TRASH_AUTHORIZATION,
  THIRTY_DAYS_MS,
  validateLibraryKey,
  writeOwnedAsset,
};
