import {
  FileProjectLibraryError,
  containsCredentialLikeString,
  containsUnsafeUrl,
  isSensitiveName,
  walk,
} from './core.mjs';

export function admissionFailure(message, details = {}) {
  return new FileProjectLibraryError('project_secret_admission_failed', message, details);
}

export function assertInputFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FileProjectLibraryError('invalid_project', `${label} must be an object.`);
  }
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      throw new FileProjectLibraryError('invalid_project', `${label} contains unknown member ${key}.`);
    }
  }
}

export function assertExactInputFields(value, required, label) {
  assertInputFields(value, required, label);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new FileProjectLibraryError('invalid_project', `${label} is missing member ${key}.`);
    }
  }
}

export function rejectProjectSecrets(value) {
  walk(value, (key, item) => {
    if (key && isSensitiveName(key)) {
      throw new FileProjectLibraryError(
        'project_secret_admission_failed',
        'Project data contains a forbidden secret field.',
      );
    }
    if (typeof item === 'string' && (
      item.startsWith('blob:')
      || item.startsWith('data:')
      || containsCredentialLikeString(item)
      || containsUnsafeUrl(item)
    )) {
      throw new FileProjectLibraryError(
        'project_secret_admission_failed',
        'Project data contains temporary or credential-like text.',
      );
    }
  });
}
