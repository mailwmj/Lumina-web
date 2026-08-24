import { collectAssetReferences } from './admission.mjs';
import { parseCommit, parseHead, parseQuarantineCleanup, parseQuarantineManifest, parseTrashCleanup, parseTrashExpiry, parseTrashManifest, validateCatalogForHead, validateCatalogPayloads } from './catalog.mjs';
import { ACTIVE_READER_PINS, CorruptLibraryError, DIGEST_PATTERN, FileProjectLibraryError, KEY_PATTERN, canonicalize, compareUtf8, parseJsonString, sha256, validateLibraryKey } from './core.mjs';
import { listDirectories, managedPath, readCanonicalFile } from './filesystem.mjs';
import { readProjectRecovery, readProjectSnapshot } from './projects.mjs';

export function rootSetDigest(reachable) {
  return sha256(canonicalize([...reachable].sort(compareUtf8)));
}

export async function addCatalogReachablePaths(state, reachable, commit) {
  reachable.add(`commits/${commit.commitId}.json`);
  for (const entry of commit.projects) {
    reachable.add(entry.manifestPath);
    reachable.add(entry.manifestPath.replace(/manifest\.json$/u, 'project.json'));
    reachable.add(entry.manifestPath.replace(/manifest\.json$/u, 'history.json'));
    const recovery = await readProjectRecovery(state, entry);
    if (recovery) {
      reachable.add(recovery.sourceProjectPath);
      reachable.add(recovery.sourceHistoryPath);
    }
  }
  for (const entry of commit.assets) {
    reachable.add(entry.metadataPath);
    reachable.add(entry.bytesPath);
  }
}

export async function addActiveReaderPinPaths(state, reachable, now) {
  const pins = ACTIVE_READER_PINS.get(state.root);
  if (!pins) return;
  for (const [pinId, pin] of pins) {
    if (pin.expiresAt <= now) {
      pins.delete(pinId);
      continue;
    }
    try {
      validateLibraryKey(pinId, 'r');
      validateLibraryKey(pin.commitId, 'c');
      if (!DIGEST_PATTERN.test(pin.commitSha256)
        || !Number.isSafeInteger(pin.sequence)
        || pin.sequence < 0
        || !Number.isSafeInteger(pin.expiresAt)) {
        throw new CorruptLibraryError('Reader pin is invalid.');
      }
      const commit = parseCommit(await readCanonicalFile(
        state,
        managedPath(state, `commits/${pin.commitId}.json`),
        'reader-pinned catalog',
      ));
      if (commit.commitId !== pin.commitId
        || commit.sequence !== pin.sequence
        || sha256(canonicalize(commit)) !== pin.commitSha256) {
        throw new CorruptLibraryError('Reader pin does not match its catalog.');
      }
      await validateCatalogPayloads(state, commit);
      await addCatalogReachablePaths(state, reachable, commit);
    } catch (error) {
      throw new FileProjectLibraryError(
        'reader_pin_invalid',
        'A live reader pin cannot be validated for garbage collection.',
        { pinId, cause: error },
      );
    }
  }
  if (pins.size === 0) ACTIVE_READER_PINS.delete(state.root);
}

export async function collectDeletionProtectedAssetIds(state, catalog, now = state.clock()) {
  const protectedAssetIds = new Set();
  for (const project of catalog.commit.projects) {
    const record = await readProjectSnapshot(state, project);
    if (record.recovery) {
      for (const asset of catalog.commit.assets) {
        if (asset.projectId === project.projectId) protectedAssetIds.add(asset.assetId);
      }
      continue;
    }
    for (const assetId of collectAssetReferences({
      nodes: parseJsonString(record.nodesJson, 'nodes'),
      history: parseJsonString(record.historyJson, 'history'),
    })) {
      protectedAssetIds.add(assetId);
    }
  }

  const retainedPaths = new Set();
  await addActiveReaderPinPaths(state, retainedPaths, now);
  await addQuarantineReachablePaths(state, retainedPaths, now);
  await addTrashReachablePaths(state, retainedPaths, now, null, protectedAssetIds);
  for (const asset of catalog.commit.assets) {
    if (retainedPaths.has(asset.metadataPath) || retainedPaths.has(asset.bytesPath)) {
      protectedAssetIds.add(asset.assetId);
    }
  }
  return protectedAssetIds;
}

export async function collectReachablePaths(state, catalog, now = state.clock(), options = {}) {
  const reachable = new Set(['library.json', 'head.json', 'head.previous.json', '.library-write.lock']);
  await addCatalogReachablePaths(state, reachable, catalog.commit);
  try {
    const previousHead = parseHead(await readCanonicalFile(state, managedPath(state, 'head.previous.json'), 'previous head'));
    const journalIsCurrentHead = previousHead.commitId === catalog.head.commitId
      && previousHead.commitSha256 === catalog.head.commitSha256;
    if (!journalIsCurrentHead && previousHead.commitId !== catalog.head.previousCommitId) {
      throw new CorruptLibraryError('Previous head is not the visible catalog predecessor.');
    }
    const previousCommit = await validateCatalogForHead(state, previousHead);
    if (!journalIsCurrentHead) await addCatalogReachablePaths(state, reachable, previousCommit);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await addActiveReaderPinPaths(state, reachable, now);
  await addQuarantineReachablePaths(state, reachable, now, options.excludeQuarantineTransactionId);
  await addTrashReachablePaths(state, reachable, now, options.excludeTrashDeletionId);
  return reachable;
}

export async function addQuarantineReachablePaths(state, reachable, now, excludedTransactionId = null) {
  for (const transactionId of (await listDirectories(state, 'quarantine')).sort(compareUtf8)) {
    if (!KEY_PATTERN.test(transactionId) || transactionId[0] !== 't' || transactionId === excludedTransactionId) {
      continue;
    }
    const manifestPath = `quarantine/${transactionId}/manifest.json`;
    let manifestBytes;
    try {
      manifestBytes = await readCanonicalFile(state, managedPath(state, manifestPath), 'quarantine manifest');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new FileProjectLibraryError(
          'recovery_required',
          'A quarantine directory is missing its durable manifest.',
          { transactionId },
        );
      }
      throw error;
    }
    const manifest = parseQuarantineManifest(manifestBytes, transactionId);
    const cleanupPath = `quarantine/${transactionId}/cleanup.json`;
    let cleanup = null;
    try {
      cleanup = parseQuarantineCleanup(
        await readCanonicalFile(state, managedPath(state, cleanupPath), 'quarantine cleanup receipt'),
        transactionId,
      );
      if (cleanup.manifestSha256 !== sha256(manifestBytes)
        || canonicalize(cleanup.entries) !== canonicalize(manifest.retained)) {
        throw new CorruptLibraryError('Quarantine cleanup receipt does not match its manifest.');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (cleanup?.state === 'authorized') {
      reachable.add(manifestPath);
      reachable.add(cleanupPath);
      for (const entry of manifest.retained) reachable.add(entry.path);
    } else if (cleanup?.state === 'complete') {
      if (now < cleanup.retainedUntil) {
        reachable.add(manifestPath);
        reachable.add(cleanupPath);
      }
    } else if (now < manifest.retainedUntil) {
      reachable.add(manifestPath);
      for (const entry of manifest.retained) reachable.add(entry.path);
    }
  }
}

export async function addTrashReachablePaths(state, reachable, now, excludedDeletionId = null, protectedAssetIds = null) {
  for (const deletionId of (await listDirectories(state, 'trash')).sort(compareUtf8)) {
    if (!KEY_PATTERN.test(deletionId) || deletionId[0] !== 'd' || deletionId === excludedDeletionId) continue;
    const expiryPath = `trash/${deletionId}/expiry.json`;
    let expiry = null;
    try {
      expiry = parseTrashExpiry(
        await readCanonicalFile(state, managedPath(state, expiryPath), 'trash expiry receipt'),
        deletionId,
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (expiry?.state === 'complete') {
      if (now < expiry.retainedUntil) reachable.add(expiryPath);
      continue;
    }
    const manifestPath = `trash/${deletionId}/manifest.json`;
    let manifestBytes;
    try {
      manifestBytes = await readCanonicalFile(state, managedPath(state, manifestPath), 'trash manifest');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new FileProjectLibraryError('recovery_required', 'A trash directory is missing its durable manifest.', { deletionId });
      }
      throw error;
    }
    const manifest = parseTrashManifest(manifestBytes, deletionId);
    if (manifest.project) {
      for (const payload of manifest.project.payloads) reachable.add(payload.path);
      if (protectedAssetIds) {
        for (const asset of manifest.project.assets) protectedAssetIds.add(asset.assetId);
      }
    }
    if (protectedAssetIds) {
      for (const entry of manifest.assets) protectedAssetIds.add(entry.assetId);
    }
    const cleanupPath = `trash/${deletionId}/cleanup.json`;
    let cleanup = null;
    try {
      cleanup = parseTrashCleanup(
        await readCanonicalFile(state, managedPath(state, cleanupPath), 'trash cleanup receipt'),
        deletionId,
      );
      const expected = manifest.assets
        .flatMap((entry) => [
          { path: entry.trashMetadataPath, sha256: entry.metadataSha256 },
          { path: entry.trashBytesPath, sha256: entry.bytesSha256 },
        ])
        .sort((left, right) => compareUtf8(left.path, right.path));
      if (cleanup.trashManifestSha256 !== sha256(manifestBytes)
        || canonicalize(cleanup.entries) !== canonicalize(expected)) {
        throw new CorruptLibraryError('Trash cleanup receipt does not match its manifest.');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (expiry?.state === 'authorized') {
      reachable.add(expiryPath);
      reachable.add(manifestPath);
      if (cleanup) reachable.add(cleanupPath);
      continue;
    }
    if (cleanup?.state === 'complete') {
      if (now <= cleanup.retainedUntil) {
        reachable.add(manifestPath);
        reachable.add(cleanupPath);
      }
      continue;
    }
    reachable.add(manifestPath);
    if (cleanup) reachable.add(cleanupPath);
    for (const entry of manifest.assets) {
      reachable.add(entry.trashMetadataPath);
      reachable.add(entry.trashBytesPath);
    }
  }
}
