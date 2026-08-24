import { parseHead, parsePublish, parseQuarantineManifest, readCatalog, validateCatalogForHead } from './catalog.mjs';
import { CorruptLibraryError, FileProjectLibraryError, KEY_PATTERN, QUARANTINE_RETENTION_MS, assertExactFields, canonicalize, compareUtf8, fs, parseStrictJson, path, sha256, validateLibraryKey } from './core.mjs';
import { assertWriteLeaseCurrent, collectFiles, ensureDirectory, ensureNoSymlinkPath, ensureParentDirectory, fault, fileDigestIfExists, flushFile, hashFileBytes, listDirectories, managedPath, pathExists, readCanonicalFile, syncDirectory, writeCanonicalFile, writeCanonicalHeadBytes } from './filesystem.mjs';
import { recoverCorruptProjectSnapshots } from './projects.mjs';

export async function loadRecoveryState(state) {
  const markerPath = managedPath(state, 'control/recovery.json');
  try {
    const value = parseStrictJson(await readCanonicalFile(markerPath, 'recovery marker'), 'recovery marker');
    assertExactFields(
      value,
      ['format', 'version', 'reason', 'priorCommitId', 'recoveredAt'],
      [],
      'recovery marker',
    );
    if (
      value.format !== 'lumina-library-recovery'
      || value.version !== 1
      || value.reason !== 'head_recovered'
      || !Number.isSafeInteger(value.recoveredAt)
    ) {
      throw new CorruptLibraryError('Recovery marker schema is unsupported.');
    }
    validateLibraryKey(value.priorCommitId, 'c');
    state.recovery = Object.freeze({
      reason: value.reason,
      priorCommitId: value.priorCommitId,
      recoveredAt: value.recoveredAt,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof CorruptLibraryError || error?.code === 'path_escape') throw error;
    throw new FileProjectLibraryError('recovery_required', 'The durable recovery marker is invalid.', { cause: error });
  }
}

export async function writeRecoveryMarker(state, recovery) {
  await writeCanonicalFile(state, managedPath(state, 'control/recovery.json'), {
    format: 'lumina-library-recovery',
    version: 1,
    reason: recovery.reason,
    priorCommitId: recovery.priorCommitId,
    recoveredAt: recovery.recoveredAt,
  });
}

export async function recoverUnderLease(state) {
  await loadRecoveryState(state);
  await cleanupTransientTemps(state);
  let catalog;
  try {
    catalog = await readCatalog(state);
  } catch (error) {
    if (!(error instanceof CorruptLibraryError) && error?.code !== 'ENOENT') throw error;
    const previousPath = managedPath(state, 'head.previous.json');
    try {
      const previousBytes = await readCanonicalFile(previousPath, 'previous head');
      const previousHead = parseHead(previousBytes);
      await validateCatalogForHead(state, previousHead);
      const recovery = Object.freeze({
        reason: 'head_recovered',
        priorCommitId: previousHead.commitId,
        recoveredAt: Date.now(),
      });
      await writeRecoveryMarker(state, recovery);
      await assertWriteLeaseCurrent(state);
      await writeCanonicalHeadBytes(state, managedPath(state, 'head.json'), previousBytes);
      catalog = await readCatalog(state);
      state.recovery = recovery;
    } catch (fallbackError) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'The library has no valid current or journaled head.',
        { cause: fallbackError },
      );
    }
  }

  await recoverCorruptProjectSnapshots(state, catalog);
  const stagingEntries = await listDirectories(state, 'staging');
  for (const transactionId of stagingEntries) {
    if (!KEY_PATTERN.test(transactionId) || transactionId[0] !== 't') {
      continue;
    }
    const publishPath = managedPath(state, `staging/${transactionId}/publish.json`);
    let publish;
    try {
      publish = parsePublish(await readCanonicalFile(publishPath, 'publish record'));
    } catch {
      await quarantineTransaction(state, transactionId, null, 'invalid_publish_record');
      continue;
    }
    if (publish.transactionId !== transactionId) {
      await quarantineTransaction(state, transactionId, null, 'transaction_id_mismatch');
      continue;
    }
    const visibleIntendedCommit = publish.intendedCommitId === catalog.head.commitId
      && publish.intendedCommitSha256 === catalog.head.commitSha256
      && publish.intendedSequence === catalog.commit.sequence;
    const visiblePriorCommit = publish.priorCommitId === catalog.head.commitId
      && publish.priorCommitSha256 === catalog.head.commitSha256;
    if (visibleIntendedCommit) {
      await fs.rm(managedPath(state, `staging/${transactionId}`), { recursive: true, force: true });
    } else if (!visiblePriorCommit) {
      await quarantineTransaction(state, transactionId, publish, 'not_visible');
    } else {
      await quarantineTransaction(state, transactionId, publish, 'not_published');
    }
  }
  return catalog;
}

export async function cleanupTransientTemps(state) {
  const ownedTransactions = new Map();
  for (const transactionId of await listDirectories(state, 'staging')) {
    if (!KEY_PATTERN.test(transactionId) || transactionId[0] !== 't') continue;
    try {
      const publish = parsePublish(
        await readCanonicalFile(
          managedPath(state, `staging/${transactionId}/publish.json`),
          'publish record',
        ),
      );
      if (publish.transactionId === transactionId) ownedTransactions.set(transactionId, publish);
    } catch {
      // An ownerless or malformed transaction is quarantined below; retain its
      // temporary files until that transaction can be moved as one unit.
    }
  }
  const ownedRootTargets = new Map();
  const addOwnedRootDigest = (target, digest) => {
    if (!ownedRootTargets.has(target)) ownedRootTargets.set(target, new Set());
    ownedRootTargets.get(target).add(digest);
  };
  let currentHeadBytes = null;
  try {
    currentHeadBytes = await readCanonicalFile(managedPath(state, 'head.json'), 'head');
  } catch {
    // A damaged head is handled by the journal recovery path; do not claim
    // ownership of root-level temporary pointers without its exact bytes.
  }
  for (const publish of ownedTransactions.values()) {
    for (const payload of publish.payloads) addOwnedRootDigest(payload.path, payload.sha256);
    if (currentHeadBytes) {
      try {
        const currentHead = parseHead(currentHeadBytes);
        if (currentHead.commitId === publish.priorCommitId
          && currentHead.commitSha256 === publish.priorCommitSha256) {
          addOwnedRootDigest('head.previous.json', sha256(currentHeadBytes));
          addOwnedRootDigest('head.json', sha256(canonicalize({
            format: 'lumina-library-head',
            version: 1,
            commitId: publish.intendedCommitId,
            commitSha256: publish.intendedCommitSha256,
            previousCommitId: publish.priorCommitId,
          })));
        }
      } catch {
        // Invalid current-head bytes cannot establish a publication owner.
      }
    }
  }
  for (const absolute of await collectFiles(state.root)) {
    const name = path.basename(absolute);
    if (!/\.\d+\.[0-9a-f-]{36}\.tmp$/u.test(name)) continue;
    const relative = path.relative(state.root, absolute).replaceAll('\\', '/');
    const transactionMatch = /^staging\/(t_[0-9a-f]{32})\//u.exec(relative);
    const ownedByTransaction = transactionMatch && ownedTransactions.has(transactionMatch[1]);
    const targetRelative = relative.replace(/\.\d+\.[0-9a-f-]{36}\.tmp$/u, '');
    if (ownedByTransaction) {
      await ensureNoSymlinkPath(state.root, absolute);
      await fs.rm(absolute, { force: true });
      continue;
    }
    const expectedDigests = ownedRootTargets.get(targetRelative);
    if (!expectedDigests) continue;
    await ensureNoSymlinkPath(state.root, absolute);
    const actualDigest = (await hashFileBytes(absolute)).sha256;
    if (!expectedDigests.has(actualDigest)) continue;
    await fs.rm(absolute, { force: true });
  }
}

export async function quarantineTransaction(state, transactionId, publish, reason) {
  const source = managedPath(state, `staging/${transactionId}`);
  const target = managedPath(state, `quarantine/${transactionId}`);
  validateLibraryKey(transactionId, 't');
  if (await pathExists(target)) {
    const manifestPath = path.join(target, 'manifest.json');
    try {
      const existing = parseQuarantineManifest(
        await readCanonicalFile(manifestPath, 'quarantine manifest'),
        transactionId,
      );
      await finishExistingQuarantine(state, source, existing);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof FileProjectLibraryError && error.code === 'recovery_required') throw error;
        throw new FileProjectLibraryError(
          'recovery_required',
          'The existing quarantine manifest is invalid.',
          { transactionId, cause: error },
        );
      }
    }
    if (!(await pathExists(source))) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'An incomplete quarantine has no staging payload to resume.',
        { transactionId },
      );
    }
    // A partial copy has no durable manifest yet, while its staging source is
    // still intact. Discard only that exact partial destination and rebuild it.
    await ensureNoSymlinkPath(state.root, target);
    await fs.rm(target, { recursive: true, force: true });
    await syncDirectory(state, path.dirname(target));
  }
  await ensureDirectory(state, `quarantine/${transactionId}`);
  let entries;
  try {
    entries = await collectFiles(source);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    entries = [];
  }
  const retained = new Map();
  if (publish) {
    for (const payload of publish.payloads) {
      const actual = await fileDigestIfExists(state, payload.path);
      if (actual && actual.sha256 !== payload.sha256) {
        throw new FileProjectLibraryError(
          'recovery_required',
          'A materialized publication payload conflicts with its journal digest.',
          { transactionId, path: payload.path },
        );
      }
      retained.set(payload.path, payload.sha256);
    }
  }
  for (const sourcePath of entries) {
    const relative = path.relative(source, sourcePath);
    const targetPath = path.join(target, relative);
    await ensureNoSymlinkPath(state.root, sourcePath);
    await ensureParentDirectory(state, targetPath);
    await ensureNoSymlinkPath(state.root, targetPath, true);
    await fs.copyFile(sourcePath, targetPath);
    await flushFile(state, targetPath);
    await syncDirectory(state, path.dirname(targetPath));
    const retainedPath = `quarantine/${transactionId}/${relative.replaceAll('\\', '/')}`;
    retained.set(retainedPath, (await hashFileBytes(targetPath)).sha256);
  }
  const failedAt = state.clock();
  if (!Number.isSafeInteger(failedAt) || failedAt < 0) {
    throw new FileProjectLibraryError('invalid_clock', 'The library clock returned an invalid timestamp.');
  }
  const manifest = {
    format: 'lumina-library-quarantine',
    version: 1,
    transactionId,
    reason,
    publish: publish ?? null,
    retained: [...retained.entries()]
      .map(([path, sha256]) => ({ path, sha256 }))
      .sort((left, right) => compareUtf8(left.path, right.path)),
    failedAt,
    retainedUntil: failedAt + QUARANTINE_RETENTION_MS,
  };
  await writeCanonicalFile(state, path.join(target, 'manifest.json'), manifest);
  await fs.rm(source, { recursive: true, force: true });
  await syncDirectory(state, path.dirname(source));
}

export async function finishExistingQuarantine(state, source, manifest) {
  for (const entry of manifest.retained) {
    const actual = await fileDigestIfExists(state, entry.path);
    if ((!actual && entry.path.startsWith(`quarantine/${manifest.transactionId}/`))
      || (actual && actual.sha256 !== entry.sha256)) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'The existing quarantine does not retain its exact payload closure.',
        { transactionId: manifest.transactionId, path: entry.path },
      );
    }
  }
  if (!(await pathExists(source))) return;
  const retained = new Map(manifest.retained.map((entry) => [entry.path, entry.sha256]));
  for (const sourcePath of await collectFiles(source)) {
    const relative = path.relative(source, sourcePath).replaceAll('\\', '/');
    const retainedPath = `quarantine/${manifest.transactionId}/${relative}`;
    const sourceDigest = (await hashFileBytes(sourcePath)).sha256;
    const targetDigest = await fileDigestIfExists(state, retainedPath);
    if (retained.get(retainedPath) !== sourceDigest || targetDigest?.sha256 !== sourceDigest) {
      throw new FileProjectLibraryError(
        'recovery_required',
        'The existing quarantine does not retain the exact staging payloads.',
        { transactionId: manifest.transactionId },
      );
    }
  }
  await fs.rm(source, { recursive: true, force: true });
  await syncDirectory(state, path.dirname(source));
}
