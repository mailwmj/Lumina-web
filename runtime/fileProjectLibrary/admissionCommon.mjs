import { CorruptLibraryError, FileProjectLibraryError, StaleProjectRevisionError, containsCredentialLikeString, containsUnsafeUrl, isSensitiveName, sha256, validateLogicalId, walk } from './core.mjs';

export function admissionFailure(message, details = {}) {
  return new FileProjectLibraryError('project_secret_admission_failed', message, details);
}

export function validateRecovery(value) {
  if (!value || typeof value !== 'object' || !['unsupported_schema', 'migration_failed'].includes(value.reason)) {
    throw new FileProjectLibraryError('invalid_project', 'Project recovery state is invalid.');
  }
  assertInputFields(value, ['reason'], 'project recovery');
  return { reason: value.reason };
}

export function validateProjectRevision(value, label = 'revision') {
  validateLogicalId(value, label);
  if (/^r[0-9]+$/u.test(value)) {
    const sequence = Number(value.slice(1));
    if (!Number.isSafeInteger(sequence)) {
      throw new CorruptLibraryError(`${label} is not a safe integer revision.`);
    }
  }
  return value;
}

export function assertInputFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FileProjectLibraryError('invalid_project', `${label} must be an object.`);
  }
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) throw new FileProjectLibraryError('invalid_project', `${label} contains unknown member ${key}.`);
  }
}

export function assertExactInputFields(value, required, label) {
  assertInputFields(value, required, label);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new FileProjectLibraryError('invalid_project', `${label} is missing member ${key}.`);
  }
}

export function rejectProjectSecrets(value) {
  walk(value, (key, item) => {
    if (key && isSensitiveName(key)) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Project data contains a forbidden secret field.');
    }
    if (typeof item === 'string' && (
      item.startsWith('blob:')
      || item.startsWith('data:')
      || containsCredentialLikeString(item)
      || containsUnsafeUrl(item)
    )) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Project data contains temporary or credential-like text.');
    }
  });
}

export function assertExpectedRevision(projectId, expected, actual) {
  if (expected === undefined) {
    throw new FileProjectLibraryError(
      'project_precondition_required',
      'A project mutation requires the project revision observed by the caller.',
      { projectId },
    );
  }
  const equivalentEmptyRevision = expected === 'r0' && actual === 'absent';
  if (expected !== actual && !equivalentEmptyRevision) {
    throw new StaleProjectRevisionError(projectId, expected, actual === 'absent' ? null : actual);
  }
}

export function chooseRevision(requested, current) {
  if (!current || current === 'absent') {
    if (requested === undefined || requested === 'r0' || requested === 'r1') return 'r1';
    throw new FileProjectLibraryError('non_monotonic_revision', 'A new project must start at revision r1.');
  }
  const next = nextRevision(current);
  if (requested === undefined || requested === current) return next;
  if (requested !== next) {
    throw new FileProjectLibraryError(
      'non_monotonic_revision',
      `Project revision must advance from ${current} to ${next}.`,
      { currentRevision: current, requestedRevision: requested },
    );
  }
  return requested;
}

export function nextRevision(current) {
  const match = /^r(\d+)$/u.exec(current);
  if (!match) return `r${sha256(current).slice(0, 8)}`;
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER) {
    throw new FileProjectLibraryError('revision_exhausted', 'Project revision sequence is exhausted.');
  }
  return `r${sequence + 1}`;
}

export function emptyCommit(commitId, sequence, previousCommitId, changes = null) {
  return {
    format: 'lumina-library-commit',
    version: 1,
    commitId,
    previousCommitId,
    sequence,
    runtimeAttachment: null,
    projects: changes?.projects ?? [],
    assets: changes?.assets ?? [],
    completedImports: [],
  };
}
