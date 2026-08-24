import { CorruptLibraryError, DEFAULT_SAFETY_WINDOW_MS, DIGEST_PATTERN, assertExactFields, compareUtf8, parseStrictJson, path, validateLibraryKey } from './core.mjs';

export function parseCleanupPlan(bytes, transactionId) {
  const value = parseStrictJson(bytes, 'garbage-collection plan');
  assertExactFields(
    value,
    ['format', 'version', 'transactionId', 'visibleCommitId', 'rootSetSha256', 'entries', 'plannedAt', 'notBefore', 'state', 'authorizedAt', 'completedAt', 'retainedUntil'],
    [],
    'garbage-collection plan',
  );
  if (value.format !== 'lumina-library-gc' || value.version !== 1 || value.transactionId !== transactionId) {
    throw new CorruptLibraryError('Garbage-collection plan identity is invalid.');
  }
  validateLibraryKey(value.transactionId, 't');
  validateLibraryKey(value.visibleCommitId, 'c');
  if (!DIGEST_PATTERN.test(value.rootSetSha256)
    || !Array.isArray(value.entries)
    || value.entries.length > 100_000
    || !Number.isSafeInteger(value.plannedAt)
    || !Number.isSafeInteger(value.notBefore)
    || !['planned', 'authorized', 'complete', 'cancelled'].includes(value.state)) {
    throw new CorruptLibraryError('Garbage-collection plan fields are invalid.');
  }
  if (value.authorizedAt !== null && !Number.isSafeInteger(value.authorizedAt)) {
    throw new CorruptLibraryError('Garbage-collection authorization timestamp is invalid.');
  }
  if (value.completedAt !== null && !Number.isSafeInteger(value.completedAt)) {
    throw new CorruptLibraryError('Garbage-collection completion timestamp is invalid.');
  }
  if (value.retainedUntil !== null && !Number.isSafeInteger(value.retainedUntil)) {
    throw new CorruptLibraryError('Garbage-collection retention timestamp is invalid.');
  }
  const minimumNotBefore = value.plannedAt + DEFAULT_SAFETY_WINDOW_MS;
  if (value.plannedAt < 0
    || !Number.isSafeInteger(minimumNotBefore)
    || value.notBefore !== minimumNotBefore) {
    throw new CorruptLibraryError('Garbage-collection plan has an invalid safety window.');
  }
  if (value.state === 'planned') {
    if (value.authorizedAt !== null || value.completedAt !== null || value.retainedUntil !== null) {
      throw new CorruptLibraryError('Planned garbage-collection state has terminal timestamps.');
    }
  } else if (value.state === 'authorized') {
    if (value.authorizedAt === null || value.authorizedAt < value.notBefore
      || value.completedAt !== null || value.retainedUntil !== null) {
      throw new CorruptLibraryError('Authorized garbage-collection state is invalid.');
    }
  } else if (value.state === 'complete') {
    if (value.authorizedAt === null || value.authorizedAt < value.notBefore
      || value.completedAt === null || value.completedAt < value.authorizedAt
      || value.retainedUntil !== value.completedAt + DEFAULT_SAFETY_WINDOW_MS) {
      throw new CorruptLibraryError('Completed garbage-collection state is invalid.');
    }
  } else if (value.completedAt === null || value.completedAt < value.plannedAt
    || value.retainedUntil !== value.completedAt + DEFAULT_SAFETY_WINDOW_MS
    || (value.authorizedAt !== null
      && (value.authorizedAt < value.notBefore || value.authorizedAt > value.completedAt))) {
    throw new CorruptLibraryError('Cancelled garbage-collection state is invalid.');
  }
  let previousPath = null;
  for (const entry of value.entries) {
    assertExactFields(entry, ['path', 'sha256'], [], 'garbage-collection entry');
    const normalizedPath = typeof entry.path === 'string' ? path.posix.normalize(entry.path) : null;
    if (typeof entry.path !== 'string' || entry.path.length === 0 || entry.path.includes('\\')
      || entry.path.startsWith('/') || normalizedPath !== entry.path
      || !isManagedCleanupPath(entry.path)
      || !DIGEST_PATTERN.test(entry.sha256)
      || (previousPath !== null && compareUtf8(previousPath, entry.path) >= 0)) {
      throw new CorruptLibraryError('Garbage-collection entry is invalid.');
    }
    previousPath = entry.path;
  }
  return value;
}

export function isManagedCleanupPath(relative) {
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/u.test(segment))) {
    return false;
  }
  if (segments[0] === 'commits') {
    return segments.length === 2 && /^c_[0-9a-f]{32}\.json$/u.test(segments[1]);
  }
  if (segments[0] === 'attachments') {
    return segments.length === 2 && /^b_[0-9a-f]{32}\.json$/u.test(segments[1]);
  }
  if (segments[0] === 'assets') {
    return segments.length >= 3 && /^a_[0-9a-f]{32}$/u.test(segments[1]);
  }
  if (segments[0] === 'projects') {
    return segments.length >= 5
      && /^p_[0-9a-f]{32}$/u.test(segments[1])
      && segments[2] === 'snapshots'
      && /^s_[0-9a-f]{32}$/u.test(segments[3]);
  }
  return false;
}

export function isManagedPublicationPath(relative) {
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/u.test(segment))) {
    return false;
  }
  if (segments[0] === 'commits') {
    return segments.length === 2 && /^c_[0-9a-f]{32}\.json$/u.test(segments[1]);
  }
  if (segments[0] === 'attachments') {
    return segments.length === 2 && /^b_[0-9a-f]{32}\.json$/u.test(segments[1]);
  }
  if (segments[0] === 'assets') {
    if (!/^a_[0-9a-f]{32}$/u.test(segments[1])) return false;
    return (segments.length === 3 && segments[2] === 'bytes.bin')
      || (segments.length === 4 && segments[2] === 'metadata' && /^[0-9a-f]{64}\.json$/u.test(segments[3]));
  }
  if (segments[0] === 'projects') {
    if (segments.length === 5
      && /^p_[0-9a-f]{32}$/u.test(segments[1])
      && segments[2] === 'snapshots'
      && /^s_[0-9a-f]{32}$/u.test(segments[3])
      && ['manifest.json', 'project.json', 'history.json'].includes(segments[4])) {
      return true;
    }
    return segments.length === 6
      && /^p_[0-9a-f]{32}$/u.test(segments[1])
      && segments[2] === 'snapshots'
      && /^s_[0-9a-f]{32}$/u.test(segments[3])
      && segments[4] === 'recovery'
      && /^r_[0-9a-f]{32}-source-(?:project|history)\.json$/u.test(segments[5]);
  }
  return false;
}

export function isManagedQuarantineRetainedPath(relative, transactionId) {
  if (isManagedPublicationPath(relative)) return true;
  const segments = relative.split('/');
  return segments.length >= 3
    && segments[0] === 'quarantine'
    && segments[1] === transactionId
    && segments.slice(2).every((segment) => /^[A-Za-z0-9_.-]+$/u.test(segment))
    && !(segments.length === 3 && ['manifest.json', 'cleanup.json'].includes(segments[2]));
}
