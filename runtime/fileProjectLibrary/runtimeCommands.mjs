import { validateProjectRevision } from './admission.mjs';
import { FileProjectLibraryError, assertExpectedCatalogRevision, canonicalize, compareUtf8, makeLibraryKey, sha256, validateCatalogRevisionPrecondition, validateLogicalId } from './core.mjs';
import { managedPath, readCanonicalFile, writeCanonicalFile } from './filesystem.mjs';

const COMMAND_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_COMMAND_ENTRIES = 4_096;

export async function authorizeRuntimeCommand(state, catalog, request) {
  const normalized = normalizeCommandRequest(request);
  assertExpectedCatalogRevision(normalized.expectedCatalog, catalog.revision);
  const requestSha256 = sha256(canonicalize(commandRequestValue(normalized)));
  if (normalized.authorization.commandRequestSha256 !== requestSha256) {
    throw authorizationDenied();
  }
  await verifyAuthorization(state, normalized.authorization, normalized, requestSha256);
  const now = validNow(state);
  if (normalized.authorization.expiresAt <= now) throw authorizationDenied();
  const ledger = await readCommandLedger(state);
  pruneExpiredCommands(ledger, now);
  if (ledger.entries.length >= MAX_COMMAND_ENTRIES) {
    throw new FileProjectLibraryError('command_capacity_exhausted', 'The runtime command ledger is at capacity.');
  }
  if (ledger.lastAllocatedSequence >= Number.MAX_SAFE_INTEGER) {
    throw new FileProjectLibraryError('command_id_exhausted', 'The runtime command ledger ID range is exhausted.');
  }
  const sequence = ledger.lastAllocatedSequence + 1;
  const commandId = `rc_${ledger.namespace}_${sequence}`;
  ledger.lastAllocatedSequence = sequence;
  ledger.entries.push({
    commandId,
    action: normalized.action,
    subject: normalized.subject,
    expectedCatalog: normalized.expectedCatalog,
    commandRequestSha256: requestSha256,
    authorizationExpiresAt: normalized.authorization.expiresAt,
    state: 'authorized',
    transactionId: null,
    intendedCatalog: null,
    result: null,
    completedAt: null,
    retainedUntil: null,
  });
  ledger.entries.sort((left, right) => compareUtf8(left.commandId, right.commandId));
  await writeCommandLedger(state, ledger);
  return {
    commandId,
    expectedCatalog: normalized.expectedCatalog,
    authorization: normalized.authorization,
  };
}

export async function consumeRuntimeCommand(state, catalog, context, action, subject, body) {
  const normalized = normalizeContext(context);
  const request = normalizeCommandRequest({
    action,
    subject,
    expectedCatalog: normalized.expectedCatalog,
    body,
    authorization: normalized.authorization,
  });
  const requestSha256 = sha256(canonicalize(commandRequestValue(request)));
  if (normalized.authorization.commandRequestSha256 !== requestSha256) {
    throw new FileProjectLibraryError('command_body_mismatch', 'The runtime command context does not bind this request.');
  }
  const ledger = await readCommandLedger(state);
  const entry = ledger.entries.find((candidate) => candidate.commandId === normalized.commandId);
  if (!entry) {
    throw new FileProjectLibraryError('command_outcome_expired', 'The runtime command outcome is no longer retained.');
  }
  if (entry.action !== action
    || canonicalize(entry.subject) !== canonicalize(request.subject)
    || canonicalize(entry.expectedCatalog) !== canonicalize(request.expectedCatalog)
    || entry.commandRequestSha256 !== requestSha256) {
    throw new FileProjectLibraryError('command_body_mismatch', 'The runtime command context was retargeted.');
  }
  if (entry.state === 'completed') return { replay: entry.result };
  if (entry.state === 'pending' && entry.action === 'empty-trash') {
    return { commandId: normalized.commandId, pendingEmptyTrashReceipt: true };
  }
  assertExpectedCatalogRevision(normalized.expectedCatalog, catalog.revision);
  const now = validNow(state);
  if (entry.state !== 'authorized' || entry.authorizationExpiresAt <= now) throw authorizationDenied();
  await verifyAuthorization(state, normalized.authorization, request, requestSha256);
  return { commandId: normalized.commandId };
}

export async function completeRuntimeCommand(state, commandId, result) {
  const ledger = await readCommandLedger(state);
  const entry = ledger.entries.find((candidate) => candidate.commandId === commandId);
  if (!entry) throw new FileProjectLibraryError('command_recovery_failed', 'The authorized runtime command is missing.');
  if (entry.state === 'completed') return structuredClone(entry.result);
  if (!['authorized', 'pending'].includes(entry.state)) throw new FileProjectLibraryError('command_recovery_failed', 'The runtime command cannot complete from its current state.');
  const now = validNow(state);
  entry.state = 'completed';
  entry.result = normalizeCommandResult(entry.action, result);
  entry.completedAt = now;
  entry.retainedUntil = now + COMMAND_RETENTION_MS;
  await writeCommandLedger(state, ledger);
  return structuredClone(entry.result);
}

export async function markRuntimeCommandPending(state, commandId, transactionId, intendedCatalog) {
  const ledger = await readCommandLedger(state);
  const entry = ledger.entries.find((candidate) => candidate.commandId === commandId);
  if (!entry || entry.state !== 'authorized'
    || (entry.action === 'empty-trash' ? transactionId !== null : !isTransactionId(transactionId))
    || !isCatalogRevision(intendedCatalog)) {
    throw new FileProjectLibraryError('command_recovery_failed', 'The runtime command cannot be bound to its publication.');
  }
  entry.state = 'pending';
  entry.transactionId = transactionId;
  entry.intendedCatalog = structuredClone(intendedCatalog);
  await writeCommandLedger(state, ledger);
}

export async function resetPendingEmptyTrashCommand(state, commandId) {
  const ledger = await readCommandLedger(state);
  const entry = ledger.entries.find((candidate) => candidate.commandId === commandId);
  if (!entry || entry.state !== 'pending' || entry.action !== 'empty-trash') return;
  entry.state = 'authorized';
  entry.transactionId = null;
  entry.intendedCatalog = null;
  await writeCommandLedger(state, ledger);
}

export async function readCommandLedger(state) {
  try {
    const bytes = await readCanonicalFile(state, managedPath(state, 'control/runtime-command-ledger.json'), 'runtime command ledger');
    return parseCommandLedger(bytes, state.libraryManifest?.libraryRootId);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!state.libraryManifest?.libraryRootId) {
      throw new FileProjectLibraryError('recovery_required', 'The runtime command ledger has no library identity.');
    }
    return {
      format: 'lumina-runtime-command-ledger',
      version: 1,
      namespace: state.libraryManifest.libraryRootId,
      lastAllocatedSequence: 0,
      entries: [],
    };
  }
}

export function parseCommandLedger(bytes, namespace) {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (canonicalize(value) !== new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    || !value || typeof value !== 'object' || Array.isArray(value)
    || !sameKeys(value, ['format', 'version', 'namespace', 'lastAllocatedSequence', 'entries'])
    || value.format !== 'lumina-runtime-command-ledger'
    || value.version !== 1
    || value.namespace !== namespace
    || !/^[0-9a-f]{32}$/u.test(value.namespace)
    || !Number.isSafeInteger(value.lastAllocatedSequence)
    || value.lastAllocatedSequence < 0
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_COMMAND_ENTRIES) {
    throw new FileProjectLibraryError('recovery_required', 'The runtime command ledger is invalid.');
  }
  let previousCommandId = null;
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !sameKeys(entry, ['commandId', 'action', 'subject', 'expectedCatalog', 'commandRequestSha256', 'authorizationExpiresAt', 'state', 'transactionId', 'intendedCatalog', 'result', 'completedAt', 'retainedUntil'])
      || typeof entry.commandId !== 'string'
      || !new RegExp(`^rc_${value.namespace}_[1-9][0-9]*$`, 'u').test(entry.commandId)
      || commandIdSequence(entry.commandId) > value.lastAllocatedSequence
      || (previousCommandId !== null && compareUtf8(previousCommandId, entry.commandId) >= 0)
      || !isSupportedAction(entry.action)
      || !isSubjectForAction(entry.action, entry.subject)
      || !isCatalogRevision(entry.expectedCatalog)
      || !/^[0-9a-f]{64}$/u.test(entry.commandRequestSha256)
      || !Number.isSafeInteger(entry.authorizationExpiresAt)
      || !['authorized', 'pending', 'completed'].includes(entry.state)
      || (entry.state === 'authorized' && (entry.transactionId !== null || entry.intendedCatalog !== null || entry.result !== null || entry.completedAt !== null || entry.retainedUntil !== null))
      || (entry.state === 'pending' && ((entry.action === 'empty-trash'
        ? entry.transactionId !== null
        : !isTransactionId(entry.transactionId))
        || !isCatalogRevision(entry.intendedCatalog)
        || entry.result !== null || entry.completedAt !== null || entry.retainedUntil !== null))
      || (entry.state === 'completed' && (!isCommandResult(entry.action, entry.result)
        || !Number.isSafeInteger(entry.completedAt)
        || entry.retainedUntil !== entry.completedAt + COMMAND_RETENTION_MS))) {
      throw new FileProjectLibraryError('recovery_required', 'The runtime command ledger entry is invalid.');
    }
    previousCommandId = entry.commandId;
  }
  return value;
}

function normalizeCommandRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || !sameKeys(request, ['action', 'subject', 'expectedCatalog', 'body', 'authorization'])
    || !isSupportedAction(request.action)
    || !isSubjectForAction(request.action, request.subject)
    || !isCatalogRevision(request.expectedCatalog)
    || !isCommandBody(request.action, request.body, request.subject)) {
    throw new FileProjectLibraryError('runtime_command_context_required', 'A complete runtime command request is required.');
  }
  return {
    action: request.action,
    subject: structuredClone(request.subject),
    expectedCatalog: validateCatalogRevisionPrecondition(request.expectedCatalog),
    body: structuredClone(request.body),
    authorization: normalizeAuthorization(request.authorization, request.action, request.subject),
  };
}

function normalizeContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || !sameKeys(context, ['commandId', 'expectedCatalog', 'authorization'])
    || typeof context.commandId !== 'string'
    || !isCatalogRevision(context.expectedCatalog)) {
    throw new FileProjectLibraryError('runtime_command_context_required', 'A verified runtime command context is required.');
  }
  return {
    commandId: context.commandId,
    expectedCatalog: validateCatalogRevisionPrecondition(context.expectedCatalog),
    authorization: normalizeAuthorization(context.authorization, null, null),
  };
}

function normalizeAuthorization(value, action, subject) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !sameKeys(value, ['format', 'version', 'action', 'subject', 'commandRequestSha256', 'bridgeSessionId', 'issuedAt', 'expiresAt', 'proof'])
    || value.format !== 'lumina-runtime-command-authorization'
    || value.version !== 1
    || !isSupportedAction(value.action)
    || !isSubjectForAction(value.action, value.subject)
    || !/^[0-9a-f]{64}$/u.test(value.commandRequestSha256)
    || typeof value.bridgeSessionId !== 'string' || value.bridgeSessionId.length === 0
    || !Number.isSafeInteger(value.issuedAt)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.issuedAt
    || typeof value.proof !== 'string' || value.proof.length === 0
    || (action !== null && (value.action !== action || canonicalize(value.subject) !== canonicalize(subject)))) {
    throw authorizationDenied();
  }
  return structuredClone(value);
}

async function verifyAuthorization(state, authorization, request, requestSha256) {
  if (authorization.commandRequestSha256 !== requestSha256) throw authorizationDenied();
  if (typeof state.testRuntimeCommandAuthorizationVerifier !== 'function') throw authorizationDenied();
  let verified;
  try {
    verified = await state.testRuntimeCommandAuthorizationVerifier(structuredClone(authorization), {
      action: request.action,
      subject: structuredClone(request.subject),
      expectedCatalog: structuredClone(request.expectedCatalog),
      commandRequestSha256: requestSha256,
    });
  } catch {
    throw authorizationDenied();
  }
  if (!verified || typeof verified !== 'object' || Array.isArray(verified)
    || !sameKeys(verified, ['bridgeSessionId', 'issuedAt', 'expiresAt'])
    || verified.bridgeSessionId !== authorization.bridgeSessionId
    || verified.issuedAt !== authorization.issuedAt
    || verified.expiresAt !== authorization.expiresAt) {
    throw authorizationDenied();
  }
}

function commandRequestValue(request) {
  return {
    format: 'lumina-runtime-command-request',
    version: 1,
    action: request.action,
    expectedCatalog: request.expectedCatalog,
    subject: request.subject,
    body: request.body,
  };
}

function pruneExpiredCommands(ledger, now) {
  ledger.entries = ledger.entries.filter((entry) => (
    entry.state === 'pending'
      || (entry.state === 'authorized'
        ? entry.authorizationExpiresAt > now
        : entry.retainedUntil > now)
  ));
}

async function writeCommandLedger(state, ledger) {
  await writeCanonicalFile(state, managedPath(state, 'control/runtime-command-ledger.json'), ledger);
}

function normalizeCommandResult(action, result) {
  if (!isCommandResult(action, result)) {
    throw new FileProjectLibraryError('command_recovery_failed', 'The runtime command produced an unsafe result.');
  }
  return structuredClone(result);
}

function isCommandResult(action, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (action === 'empty-trash') {
    return sameKeys(value, ['code', 'deletionId'])
      && ['trash_empty_complete', 'trash_empty_cancelled'].includes(value.code)
      && typeof value.deletionId === 'string';
  }
  if (action === 'project-delete') {
    if (value.code === 'not_found') {
      return sameKeys(value, ['code', 'projectId']) && isLogicalId(value.projectId);
    }
    return sameKeys(value, ['code', 'projectId', 'deletionId', 'trashManifestSha256', 'catalog'])
      && value.code === 'deleted'
      && isLogicalId(value.projectId)
      && /^d_[0-9a-f]{32}$/u.test(value.deletionId)
      && /^[0-9a-f]{64}$/u.test(value.trashManifestSha256)
      && isCatalogRevision(value.catalog);
  }
  if (action === 'project-restore') {
    return sameKeys(value, ['code', 'projectId', 'revision', 'catalog'])
      && value.code === 'restored'
      && isLogicalId(value.projectId)
      && isExpectedProjectRevision(value.revision)
      && value.revision !== 'absent'
      && isCatalogRevision(value.catalog);
  }
  return false;
}

function isCatalogRevision(value) {
  try {
    validateCatalogRevisionPrecondition(value);
    return true;
  } catch {
    return false;
  }
}

function isEmptyTrashSubject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && sameKeys(value, ['projectId', 'assetId', 'deletionId'])
    && value.projectId === null
    && value.assetId === null
    && typeof value.deletionId === 'string'
    && /^d_[0-9a-f]{32}$/u.test(value.deletionId);
}

function isProjectDeleteSubject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && sameKeys(value, ['projectId', 'assetId', 'deletionId'])
    && isLogicalId(value.projectId)
    && value.assetId === null
    && value.deletionId === null;
}

function isProjectRestoreSubject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && sameKeys(value, ['projectId', 'assetId', 'deletionId'])
    && isLogicalId(value.projectId)
    && value.assetId === null
    && typeof value.deletionId === 'string'
    && /^d_[0-9a-f]{32}$/u.test(value.deletionId);
}

function isSupportedAction(action) {
  return ['empty-trash', 'project-delete', 'project-restore'].includes(action);
}

function isSubjectForAction(action, subject) {
  if (action === 'empty-trash') return isEmptyTrashSubject(subject);
  if (action === 'project-delete') return isProjectDeleteSubject(subject);
  if (action === 'project-restore') return isProjectRestoreSubject(subject);
  return false;
}

function isCommandBody(action, body, subject) {
  if (action === 'empty-trash') return isEmptyTrashBody(body, subject.deletionId);
  if (action === 'project-delete') {
    return body && typeof body === 'object' && !Array.isArray(body)
      && sameKeys(body, ['kind', 'projectId', 'expectedRevision'])
      && body.kind === 'delete'
      && body.projectId === subject.projectId
      && isExpectedProjectRevision(body.expectedRevision);
  }
  if (action === 'project-restore') {
    return body && typeof body === 'object' && !Array.isArray(body)
      && sameKeys(body, ['kind', 'projectId', 'expectedRevision', 'deletionId', 'trashManifestSha256'])
      && body.kind === 'restoreProject'
      && body.projectId === subject.projectId
      && body.deletionId === subject.deletionId
      && isExpectedProjectRevision(body.expectedRevision)
      && typeof body.trashManifestSha256 === 'string'
      && /^[0-9a-f]{64}$/u.test(body.trashManifestSha256);
  }
  return false;
}

function isExpectedProjectRevision(value) {
  if (value === 'absent') return true;
  try {
    validateProjectRevision(value, 'runtime command expected revision');
    return true;
  } catch {
    return false;
  }
}

function isLogicalId(value) {
  if (typeof value !== 'string') return false;
  try {
    validateLogicalId(value, 'runtime command subject');
    return true;
  } catch {
    return false;
  }
}

function isEmptyTrashBody(value, deletionId) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && sameKeys(value, ['deletionId', 'trashManifestSha256'])
    && value.deletionId === deletionId
    && typeof value.trashManifestSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(value.trashManifestSha256);
}

function sameKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function commandIdSequence(commandId) {
  const sequence = Number(commandId.slice(commandId.lastIndexOf('_') + 1));
  return Number.isSafeInteger(sequence) ? sequence : Number.POSITIVE_INFINITY;
}

function isTransactionId(value) {
  return typeof value === 'string' && /^t_[0-9a-f]{32}$/u.test(value);
}

function validNow(state) {
  const now = state.clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new FileProjectLibraryError('invalid_clock', 'The library clock returned an invalid timestamp.');
  return now;
}

function authorizationDenied() {
  return new FileProjectLibraryError('authorization_denied', 'The runtime command authorization is invalid or expired.');
}
