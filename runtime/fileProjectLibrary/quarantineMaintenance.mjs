import { parseQuarantineCleanup, parseQuarantineManifest } from './catalog.mjs';
import { CorruptLibraryError, FileProjectLibraryError, KEY_PATTERN, QUARANTINE_RETENTION_MS, canonicalize, compareUtf8, fs, path, sha256 } from './core.mjs';
import { assertWriteLeaseCurrent, collectFiles, ensureNoSymlinkPath, fault, fileDigestIfExists, listDirectories, managedPath, readCanonicalFile, removeExactManagedTree, removeIfUnchanged, syncDirectory, writeCanonicalFile } from './filesystem.mjs';
import { collectReachablePaths, rootSetDigest } from './maintenanceReachability.mjs';
import { withReaderPinBarrier } from './readerPins.mjs';

export async function cleanupExpiredQuarantines(state, catalog, now) {
  const transactionIds = (await listDirectories(state, 'quarantine')).sort(compareUtf8);
  for (const transactionId of transactionIds) {
    if (!KEY_PATTERN.test(transactionId) || transactionId[0] !== 't') continue;
    const manifestPath = managedPath(state, `quarantine/${transactionId}/manifest.json`);
    let manifestBytes;
    try {
      manifestBytes = await readCanonicalFile(state, manifestPath, 'quarantine manifest');
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
    const cleanupPath = managedPath(state, `quarantine/${transactionId}/cleanup.json`);
    let cleanup = null;
    try {
      cleanup = parseQuarantineCleanup(
        await readCanonicalFile(state, cleanupPath, 'quarantine cleanup receipt'),
        transactionId,
      );
      assertQuarantineCleanupMatches(manifestBytes, manifest, cleanup);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (cleanup?.state === 'complete') {
      if (now >= cleanup.retainedUntil) {
        await expireQuarantine(state, transactionId, manifest, cleanup);
        return { code: 'quarantine_expired', transactionId };
      }
      continue;
    }
    if (cleanup?.state === 'authorized') {
      return completeQuarantineCleanup(state, catalog, manifestBytes, manifest, cleanup, now);
    }
    if (now < manifest.retainedUntil) continue;
    return authorizeQuarantineCleanup(state, catalog, manifestBytes, manifest, now);
  }
  return null;
}

export function assertQuarantineCleanupMatches(manifestBytes, manifest, cleanup) {
  if (cleanup.manifestSha256 !== sha256(manifestBytes)
    || canonicalize(cleanup.entries) !== canonicalize(manifest.retained)) {
    throw new CorruptLibraryError('Quarantine cleanup receipt does not match its manifest.');
  }
}

export async function authorizeQuarantineCleanup(state, catalog, manifestBytes, manifest, now) {
  return withReaderPinBarrier(state, async () => {
    const reachable = await collectReachablePaths(state, catalog, now, {
      excludeQuarantineTransactionId: manifest.transactionId,
    });
    await verifyQuarantineCleanupClosure(state, manifest, reachable, true);
    const cleanup = {
      format: 'lumina-library-quarantine-cleanup',
      version: 1,
      transactionId: manifest.transactionId,
      manifestSha256: sha256(manifestBytes),
      rootSetSha256: rootSetDigest(reachable),
      entries: manifest.retained,
      checkedAt: now,
      state: 'authorized',
      completedAt: null,
      retainedUntil: null,
    };
    await fault(state, 'before-quarantine-cleanup-authorize', { transactionId: manifest.transactionId });
    await writeCanonicalFile(state, managedPath(state, `quarantine/${manifest.transactionId}/cleanup.json`), cleanup);
    await fault(state, 'after-quarantine-cleanup-authorize', { transactionId: manifest.transactionId });
    return completeQuarantineCleanup(state, catalog, manifestBytes, manifest, cleanup, now, true);
  });
}

export async function completeQuarantineCleanup(state, catalog, manifestBytes, manifest, cleanup, now, readerBarrierHeld = false) {
  const complete = async () => {
    assertQuarantineCleanupMatches(manifestBytes, manifest, cleanup);
    const reachable = await collectReachablePaths(state, catalog, now, {
      excludeQuarantineTransactionId: manifest.transactionId,
    });
    if (cleanup.rootSetSha256 !== rootSetDigest(reachable)) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'The quarantine root set changed after cleanup authorization.',
        { transactionId: manifest.transactionId },
      );
    }
    await verifyQuarantineCleanupClosure(state, manifest, reachable);
    const removed = [];
    for (const entry of cleanup.entries) {
      await fault(state, 'before-quarantine-cleanup-delete', { transactionId: manifest.transactionId, path: entry.path });
      const actual = await fileDigestIfExists(state, entry.path);
      if (actual) {
        if (actual.sha256 !== entry.sha256) {
          throw new FileProjectLibraryError(
            'recovery_required',
            'A retained quarantine payload changed after authorization.',
            { transactionId: manifest.transactionId, path: entry.path },
          );
        }
        const target = managedPath(state, entry.path);
        await assertWriteLeaseCurrent(state);
        await fault(state, 'after-quarantine-cleanup-revalidate', {
          transactionId: manifest.transactionId,
          path: entry.path,
        });
        if (!(await removeIfUnchanged(state, target, { sha256: entry.sha256 }))) {
          throw new FileProjectLibraryError(
            'recovery_required',
            'A retained quarantine payload changed before exact deletion.',
            { transactionId: manifest.transactionId, path: entry.path },
          );
        }
        await syncDirectory(state, path.dirname(target));
        removed.push(entry.path);
      }
      await fault(state, 'after-quarantine-cleanup-delete', { transactionId: manifest.transactionId, path: entry.path });
    }
    const completed = {
      ...cleanup,
      state: 'complete',
      completedAt: now,
      retainedUntil: now + QUARANTINE_RETENTION_MS,
    };
    await fault(state, 'before-quarantine-cleanup-complete', { transactionId: manifest.transactionId });
    await writeCanonicalFile(state, managedPath(state, `quarantine/${manifest.transactionId}/cleanup.json`), completed);
    await fault(state, 'after-quarantine-cleanup-complete', { transactionId: manifest.transactionId });
    return { code: 'quarantine_cleanup_complete', transactionId: manifest.transactionId, removed: removed.sort(compareUtf8) };
  };
  return readerBarrierHeld ? complete() : withReaderPinBarrier(state, complete);
}

export async function verifyQuarantineCleanupClosure(state, manifest, reachable, requireQuarantineCopies = false) {
  for (const entry of manifest.retained) {
    if (reachable.has(entry.path)) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'A retained quarantine payload is reachable from the current root set.',
        { transactionId: manifest.transactionId, path: entry.path },
      );
    }
    const actual = await fileDigestIfExists(state, entry.path);
    if (!actual) {
      if (requireQuarantineCopies && entry.path.startsWith(`quarantine/${manifest.transactionId}/`)) {
        throw new FileProjectLibraryError(
          'recovery_required',
          'A quarantined control payload is missing before cleanup.',
          { transactionId: manifest.transactionId, path: entry.path },
        );
      }
      continue;
    }
    if (actual.sha256 !== entry.sha256) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'A retained quarantine payload digest no longer matches.',
        { transactionId: manifest.transactionId, path: entry.path },
      );
    }
  }
}

export async function expireQuarantine(state, transactionId, manifest, cleanup) {
  for (const entry of cleanup.entries) {
    if (await fileDigestIfExists(state, entry.path)) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'A completed quarantine still contains a retained payload.',
        { transactionId, path: entry.path },
      );
    }
  }
  const directory = managedPath(state, `quarantine/${transactionId}`);
  const allowed = new Set([
    path.resolve(directory, 'manifest.json'),
    path.resolve(directory, 'cleanup.json'),
  ]);
  for (const file of await collectFiles(state, directory)) {
    if (!allowed.has(path.resolve(file))) {
      throw new CorruptLibraryError('Completed quarantine contains unexpected retained data.');
    }
  }
  // Remove the receipt first: a replacement or interrupted expiry leaves a
  // recoverable manifest rather than an unrecognizable quarantine directory.
  await removeExactQuarantineControlFile(state, path.join(directory, 'cleanup.json'), cleanup, 'quarantine cleanup receipt');
  await removeExactQuarantineControlFile(state, path.join(directory, 'manifest.json'), manifest, 'quarantine manifest');
  await removeExactManagedTree(state, directory, [], 'Completed quarantine');
}

async function removeExactQuarantineControlFile(state, target, expectedValue, label) {
  const bytes = await readCanonicalFile(state, target, label);
  if (sha256(bytes) !== sha256(canonicalize(expectedValue))) {
    throw new FileProjectLibraryError(
      'recovery_required',
      'A completed quarantine control record changed before exact expiry.',
    );
  }
  if (!(await removeIfUnchanged(state, target, { sha256: sha256(bytes) }))) {
    throw new FileProjectLibraryError(
      'recovery_required',
      'A completed quarantine control record changed before exact expiry.',
    );
  }
  await syncDirectory(state, path.dirname(target));
}
