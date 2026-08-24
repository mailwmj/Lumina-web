import { parseCommit, parseHead, parseQuarantineCleanup, parseQuarantineManifest, validateCatalogForHead, validateCatalogPayloads } from './catalog.mjs';
import { ACTIVE_READER_PINS, CorruptLibraryError, DIGEST_PATTERN, FileProjectLibraryError, KEY_PATTERN, canonicalize, compareUtf8, sha256, validateLibraryKey } from './core.mjs';
import { listDirectories, managedPath, readCanonicalFile } from './filesystem.mjs';
import { readProjectRecovery } from './projects.mjs';

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
