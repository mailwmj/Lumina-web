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

function createFileProjectLibrary(options = {}) {
  return createRawFileProjectLibrary({
    ...options,
    // Functional fixtures exercise library behavior, not native durability.
    testDurableFileOps: createTestDurableFileOps({
      ...TEST_DURABLE_FILE_OPS,
      ...(options.durableFileOps ?? {}),
      ...(options.testDurableFileOps ?? {}),
    }),
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
    { expectedRevision: 'absent' },
  );
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
  canonicalize,
  createAssetOwner,
  createFileProjectLibrary,
  createRawFileProjectLibrary,
  fs,
  NATIVE_DURABLE_FILE_OPS_CONFORMANCE,
  os,
  path,
  projectRecord,
  sha256,
  test,
  TEST_DURABLE_FILE_OPS,
  THIRTY_DAYS_MS,
  validateLibraryKey,
  writeOwnedAsset,
};
