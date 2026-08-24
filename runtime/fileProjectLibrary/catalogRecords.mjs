import { validateProjectRevision } from './admission.mjs';
import { CorruptLibraryError, DIGEST_PATTERN, LIBRARY_FORMAT, LIBRARY_VERSION, QUARANTINE_RETENTION_MS, assertExactFields, assertSortedUnique, canonicalize, compareUtf8, encoder, parseStrictJson, validateLibraryKey, validateLogicalId } from './core.mjs';
import { isManagedPublicationPath, isManagedQuarantineRetainedPath } from './cleanupPlans.mjs';

export function parseLibraryManifest(bytes) {
  const value = parseStrictJson(bytes, 'library manifest');
  assertExactFields(
    value,
    ['format', 'version', 'libraryId', 'libraryRootId', 'importOperationNamespace'],
    [],
    'library manifest',
  );
  if (
    value.format !== LIBRARY_FORMAT
    || value.version !== LIBRARY_VERSION
    || typeof value.libraryId !== 'string'
    || !/^[0-9a-f-]{36}$/u.test(value.libraryId)
    || !/^[0-9a-f]{32}$/u.test(value.libraryRootId)
    || !/^[0-9a-f]{32}$/u.test(value.importOperationNamespace)
  ) {
    throw new CorruptLibraryError('Library manifest schema is unsupported.');
  }
  return value;
}

export function parseHead(bytes) {
  const value = parseStrictJson(bytes, 'head');
  assertExactFields(value, ['format', 'version', 'commitId', 'commitSha256', 'previousCommitId'], [], 'head');
  if (value.format !== 'lumina-library-head' || value.version !== 1) {
    throw new CorruptLibraryError('Head schema is unsupported.');
  }
  return value;
}

export function parseCommit(bytes) {
  const value = parseStrictJson(bytes, 'catalog commit');
  assertExactFields(
    value,
    ['format', 'version', 'commitId', 'previousCommitId', 'sequence', 'runtimeAttachment', 'projects', 'assets', 'completedImports'],
    [],
    'catalog commit',
  );
  if (
    value.format !== 'lumina-library-commit'
    || value.version !== 1
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || !Array.isArray(value.projects)
    || !Array.isArray(value.assets)
  ) {
    throw new CorruptLibraryError('Catalog commit schema is unsupported.');
  }
  validateLibraryKey(value.commitId, 'c');
  if (value.previousCommitId !== null) validateLibraryKey(value.previousCommitId, 'c');
  if (value.previousCommitId === value.commitId) throw new CorruptLibraryError('Catalog commit cannot point to itself.');
  if (value.runtimeAttachment !== null || !Array.isArray(value.completedImports) || value.completedImports.length !== 0) {
    throw new CorruptLibraryError('Catalog commit optional state is unsupported.');
  }
  value.projects.forEach((entry) => {
    assertExactFields(
      entry,
      ['projectId', 'projectKey', 'snapshotKey', 'revision', 'manifestPath', 'manifestSha256'],
      [],
      'project catalog entry',
    );
    validateProjectRevision(entry.revision, 'project catalog revision');
  });
  value.assets.forEach((entry) => {
    assertExactFields(
      entry,
      ['assetId', 'projectId', 'assetKey', 'metadataFormat', 'metadataVersion', 'metadataPath', 'metadataSha256', 'bytesPath', 'byteCount', 'bytesSha256'],
      [],
      'asset catalog entry',
    );
  });
  assertSortedUnique(value.projects, (entry) => entry.projectId, 'project catalog');
  assertSortedUnique(value.assets, (entry) => entry.assetId, 'asset catalog');
  return value;
}

export function parsePublish(bytes) {
  const value = parseStrictJson(bytes, 'publish record');
  assertExactFields(
    value,
    ['format', 'version', 'transactionId', 'operation', 'expectedCatalog', 'expectedProjectRevisions', 'priorCommitId', 'priorCommitSha256', 'intendedCommitId', 'intendedSequence', 'intendedCommitSha256', 'payloads', 'createdAt'],
    [],
    'publish record',
  );
  if (
    value.format !== 'lumina-library-publish'
    || value.version !== 1
    || typeof value.transactionId !== 'string'
    || typeof value.intendedCommitId !== 'string'
    || typeof value.intendedCommitSha256 !== 'string'
  ) {
    throw new CorruptLibraryError('Publish record schema is unsupported.');
  }
  validateLibraryKey(value.transactionId, 't');
  validateLibraryKey(value.priorCommitId, 'c');
  validateLibraryKey(value.intendedCommitId, 'c');
  if (!DIGEST_PATTERN.test(value.priorCommitSha256)
    || !Number.isSafeInteger(value.intendedSequence)
    || value.intendedSequence < 0
    || !DIGEST_PATTERN.test(value.intendedCommitSha256)
    || !Number.isSafeInteger(value.createdAt)) {
    throw new CorruptLibraryError('Publish record fields are invalid.');
  }
  assertExactFields(value.expectedCatalog, ['commitId', 'sequence', 'commitSha256'], [], 'publish catalog precondition');
  if (value.expectedCatalog.commitId !== value.priorCommitId
    || !Number.isSafeInteger(value.expectedCatalog.sequence)
    || value.expectedCatalog.sequence < 0
    || value.expectedCatalog.sequence + 1 !== value.intendedSequence
    || value.expectedCatalog.commitSha256 !== value.priorCommitSha256) {
    throw new CorruptLibraryError('Publish record catalog precondition is invalid.');
  }
  if (!Array.isArray(value.expectedProjectRevisions)) {
    throw new CorruptLibraryError('Publish record project preconditions are invalid.');
  }
  let previousProjectId = null;
  for (const entry of value.expectedProjectRevisions) {
    assertExactFields(entry, ['projectId', 'expectedRevision'], [], 'publish project precondition');
    if (typeof entry.projectId !== 'string'
      || (previousProjectId !== null && compareUtf8(previousProjectId, entry.projectId) >= 0)
      || typeof entry.expectedRevision !== 'string') {
      throw new CorruptLibraryError('Publish record project preconditions are invalid.');
    }
    try {
      validateLogicalId(entry.projectId, 'publish project precondition projectId');
    } catch (error) {
      throw new CorruptLibraryError('Publish record project preconditions are invalid.', { cause: error });
    }
    if (entry.expectedRevision !== 'absent') validateProjectRevision(entry.expectedRevision, 'publish expected revision');
    previousProjectId = entry.projectId;
  }
  validatePublishPayloads(value.payloads);
  if (!value.payloads.some((entry) => (
    entry.path === `commits/${value.intendedCommitId}.json`
    && entry.sha256 === value.intendedCommitSha256
  ))) {
    throw new CorruptLibraryError('Publish record does not retain its intended catalog payload.');
  }
  return value;
}

export function parseTrashManifest(bytes, deletionId) {
  const value = parseStrictJson(bytes, 'trash manifest');
  assertExactFields(value, ['format', 'version', 'deletionId', 'catalog', 'assets', 'createdAt'], [], 'trash manifest');
  if (value.format !== 'lumina-library-trash' || value.version !== 1 || value.deletionId !== deletionId
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Array.isArray(value.assets)) {
    throw new CorruptLibraryError('Trash manifest identity is invalid.');
  }
  validateLibraryKey(deletionId, 'd');
  assertExactFields(value.catalog, ['commitId', 'sequence', 'commitSha256'], [], 'trash manifest catalog');
  validateLibraryKey(value.catalog.commitId, 'c');
  if (!Number.isSafeInteger(value.catalog.sequence) || value.catalog.sequence < 0
    || !DIGEST_PATTERN.test(value.catalog.commitSha256)) {
    throw new CorruptLibraryError('Trash manifest catalog is invalid.');
  }
  let previousAssetId = null;
  for (const entry of value.assets) {
    assertExactFields(
      entry,
      ['assetId', 'projectId', 'assetKey', 'metadataPath', 'metadataSha256', 'bytesPath', 'bytesSha256', 'byteCount', 'trashMetadataPath', 'trashBytesPath'],
      [],
      'trash manifest asset',
    );
    validateLogicalId(entry.assetId, 'trash manifest assetId');
    validateLogicalId(entry.projectId, 'trash manifest projectId');
    validateLibraryKey(entry.assetKey, 'a');
    if (previousAssetId !== null && compareUtf8(previousAssetId, entry.assetId) >= 0) {
      throw new CorruptLibraryError('Trash manifest assets are not sorted.');
    }
    if (entry.metadataPath !== `assets/${entry.assetKey}/metadata/${entry.metadataSha256}.json`
      || entry.bytesPath !== `assets/${entry.assetKey}/bytes.bin`
      || entry.trashMetadataPath !== `trash/${deletionId}/assets/${entry.assetKey}/metadata/${entry.metadataSha256}.json`
      || entry.trashBytesPath !== `trash/${deletionId}/assets/${entry.assetKey}/bytes.bin`
      || !DIGEST_PATTERN.test(entry.metadataSha256)
      || !DIGEST_PATTERN.test(entry.bytesSha256)
      || !Number.isSafeInteger(entry.byteCount)
      || entry.byteCount < 0) {
      throw new CorruptLibraryError('Trash manifest asset is invalid.');
    }
    previousAssetId = entry.assetId;
  }
  return value;
}

export function parseTrashCleanup(bytes, deletionId) {
  const value = parseStrictJson(bytes, 'trash cleanup receipt');
  assertExactFields(
    value,
    ['format', 'version', 'deletionId', 'trashManifestSha256', 'expectedCatalog', 'rootSetSha256', 'authorizationClass', 'entries', 'authorizedAt', 'state', 'terminalAt', 'retainedUntil'],
    [],
    'trash cleanup receipt',
  );
  if (value.format !== 'lumina-library-trash-cleanup' || value.version !== 1 || value.deletionId !== deletionId
    || !DIGEST_PATTERN.test(value.trashManifestSha256) || !Array.isArray(value.entries)
    || !DIGEST_PATTERN.test(value.rootSetSha256)
    || value.authorizationClass !== 'empty-trash'
    || !Number.isSafeInteger(value.authorizedAt) || value.authorizedAt < 0
    || !['authorized', 'complete', 'cancelled'].includes(value.state)) {
    throw new CorruptLibraryError('Trash cleanup receipt is invalid.');
  }
  validateLibraryKey(deletionId, 'd');
  assertExactFields(value.expectedCatalog, ['commitId', 'sequence', 'commitSha256'], [], 'trash cleanup catalog precondition');
  validateLibraryKey(value.expectedCatalog.commitId, 'c');
  if (!Number.isSafeInteger(value.expectedCatalog.sequence) || value.expectedCatalog.sequence < 0
    || !DIGEST_PATTERN.test(value.expectedCatalog.commitSha256)) {
    throw new CorruptLibraryError('Trash cleanup catalog precondition is invalid.');
  }
  let previousPath = null;
  for (const entry of value.entries) {
    assertExactFields(entry, ['path', 'sha256'], [], 'trash cleanup entry');
    if (typeof entry.path !== 'string' || !entry.path.startsWith(`trash/${deletionId}/assets/`)
      || !DIGEST_PATTERN.test(entry.sha256)
      || (previousPath !== null && compareUtf8(previousPath, entry.path) >= 0)) {
      throw new CorruptLibraryError('Trash cleanup entry is invalid.');
    }
    previousPath = entry.path;
  }
  if (value.state === 'authorized') {
    if (value.terminalAt !== null || value.retainedUntil !== null) {
      throw new CorruptLibraryError('Authorized trash cleanup receipt is invalid.');
    }
  } else if (!Number.isSafeInteger(value.terminalAt) || value.terminalAt < value.authorizedAt
    || value.retainedUntil !== value.terminalAt + QUARANTINE_RETENTION_MS) {
    throw new CorruptLibraryError('Completed trash cleanup receipt is invalid.');
  }
  return value;
}

export function parseTrashExpiry(bytes, deletionId) {
  const value = parseStrictJson(bytes, 'trash expiry receipt');
  assertExactFields(
    value,
    ['format', 'version', 'deletionId', 'trashManifestSha256', 'cleanupSha256', 'terminalRootSetSha256', 'authorizedAt', 'state', 'completedAt', 'retainedUntil'],
    [],
    'trash expiry receipt',
  );
  if (value.format !== 'lumina-library-trash-expiry' || value.version !== 1 || value.deletionId !== deletionId
    || !DIGEST_PATTERN.test(value.trashManifestSha256) || !DIGEST_PATTERN.test(value.cleanupSha256)
    || !DIGEST_PATTERN.test(value.terminalRootSetSha256)
    || !Number.isSafeInteger(value.authorizedAt) || value.authorizedAt < 0
    || !['authorized', 'complete'].includes(value.state)) {
    throw new CorruptLibraryError('Trash expiry receipt is invalid.');
  }
  validateLibraryKey(deletionId, 'd');
  if (value.state === 'authorized') {
    if (value.completedAt !== null || value.retainedUntil !== null) {
      throw new CorruptLibraryError('Authorized trash expiry receipt is invalid.');
    }
  } else if (!Number.isSafeInteger(value.completedAt) || value.completedAt < value.authorizedAt
    || value.retainedUntil !== value.completedAt + QUARANTINE_RETENTION_MS) {
    throw new CorruptLibraryError('Completed trash expiry receipt is invalid.');
  }
  return value;
}

export function parseQuarantineManifest(bytes, transactionId) {
  const value = parseStrictJson(bytes, 'quarantine manifest');
  assertExactFields(
    value,
    ['format', 'version', 'transactionId', 'reason', 'publish', 'retained', 'failedAt', 'retainedUntil'],
    [],
    'quarantine manifest',
  );
  if (value.format !== 'lumina-library-quarantine'
    || value.version !== 1
    || value.transactionId !== transactionId
    || typeof value.reason !== 'string'
    || value.reason.length === 0
    || !Number.isSafeInteger(value.failedAt)
    || value.failedAt < 0
    || !Number.isSafeInteger(value.retainedUntil)
    || value.retainedUntil !== value.failedAt + QUARANTINE_RETENTION_MS) {
    throw new CorruptLibraryError('Quarantine manifest identity is invalid.');
  }
  validateLibraryKey(transactionId, 't');
  let publish = null;
  try {
    if (value.publish !== null) publish = parsePublish(encoder.encode(canonicalize(value.publish)));
  } catch (error) {
    throw new CorruptLibraryError('Quarantine publish record is invalid.', { cause: error });
  }
  if (!Array.isArray(value.retained) || value.retained.length > 100_000) {
    throw new CorruptLibraryError('Quarantine retained payloads are invalid.');
  }
  const retained = new Map();
  let previousPath = null;
  for (const entry of value.retained) {
    assertExactFields(entry, ['path', 'sha256'], [], 'quarantine retained payload');
    if (typeof entry.path !== 'string'
      || !isManagedQuarantineRetainedPath(entry.path, transactionId)
      || !DIGEST_PATTERN.test(entry.sha256)
      || retained.has(entry.path)
      || (previousPath !== null && compareUtf8(previousPath, entry.path) >= 0)) {
      throw new CorruptLibraryError('Quarantine retained payload is invalid.');
    }
    retained.set(entry.path, entry.sha256);
    previousPath = entry.path;
  }
  if (publish) {
    for (const payload of publish.payloads) {
      if (retained.get(payload.path) !== payload.sha256) {
        throw new CorruptLibraryError('Quarantine does not retain every final publication payload.');
      }
    }
  }
  return value;
}

export function parseQuarantineCleanup(bytes, transactionId) {
  const value = parseStrictJson(bytes, 'quarantine cleanup receipt');
  assertExactFields(
    value,
    ['format', 'version', 'transactionId', 'manifestSha256', 'rootSetSha256', 'entries', 'checkedAt', 'state', 'completedAt', 'retainedUntil'],
    [],
    'quarantine cleanup receipt',
  );
  if (value.format !== 'lumina-library-quarantine-cleanup'
    || value.version !== 1
    || value.transactionId !== transactionId
    || !DIGEST_PATTERN.test(value.manifestSha256)
    || !DIGEST_PATTERN.test(value.rootSetSha256)
    || !Number.isSafeInteger(value.checkedAt)
    || !['authorized', 'complete'].includes(value.state)
    || !Array.isArray(value.entries)
    || value.entries.length > 100_000) {
    throw new CorruptLibraryError('Quarantine cleanup receipt is invalid.');
  }
  validateLibraryKey(transactionId, 't');
  if (value.state === 'authorized') {
    if (value.completedAt !== null || value.retainedUntil !== null) {
      throw new CorruptLibraryError('Authorized quarantine cleanup receipt has terminal timestamps.');
    }
  } else if (!Number.isSafeInteger(value.completedAt)
    || !Number.isSafeInteger(value.retainedUntil)
    || value.retainedUntil !== value.completedAt + QUARANTINE_RETENTION_MS) {
    throw new CorruptLibraryError('Completed quarantine cleanup receipt has invalid retention.');
  }
  let previousPath = null;
  for (const entry of value.entries) {
    assertExactFields(entry, ['path', 'sha256'], [], 'quarantine cleanup entry');
    if (typeof entry.path !== 'string'
      || !isManagedQuarantineRetainedPath(entry.path, transactionId)
      || !DIGEST_PATTERN.test(entry.sha256)
      || (previousPath !== null && compareUtf8(previousPath, entry.path) >= 0)) {
      throw new CorruptLibraryError('Quarantine cleanup entry is invalid.');
    }
    previousPath = entry.path;
  }
  return value;
}

export function validatePublishPayloads(payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > 100_000) {
    throw new CorruptLibraryError('Publish record payloads are invalid.');
  }
  let previousPath = null;
  for (const entry of payloads) {
    assertExactFields(entry, ['path', 'sha256'], [], 'publish payload');
    if (typeof entry.path !== 'string'
      || !isManagedPublicationPath(entry.path)
      || !DIGEST_PATTERN.test(entry.sha256)
      || (previousPath !== null && compareUtf8(previousPath, entry.path) >= 0)) {
      throw new CorruptLibraryError('Publish record payload is invalid.');
    }
    previousPath = entry.path;
  }
}
