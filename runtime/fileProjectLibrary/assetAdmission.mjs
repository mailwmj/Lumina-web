import {
  ADMISSION_REGISTRY,
  FileProjectLibraryError,
  MAX_DURABLE_ASSET_BYTES,
  containsCredentialLikeString,
  containsUnsafeUrl,
  encoder,
  isSensitiveName,
  validateLogicalId,
} from './core.mjs';

export async function normalizeAssetInput(input) {
  if (!input || typeof input !== 'object' || !isStreamableBlob(input.blob)) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset input must include a streamable Blob.');
  }
  validateLogicalId(input.projectId, 'projectId');
  if (!['image', 'video', 'audio'].includes(input.kind)
    || !['import', 'generation', 'derived'].includes(input.sourceKind)) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset kind or source kind is invalid.');
  }
  if (!Number.isSafeInteger(input.blob.size) || input.blob.size > MAX_DURABLE_ASSET_BYTES) {
    throw new FileProjectLibraryError('asset_too_large', 'Asset bytes exceed the durable library limit.');
  }
  const mimeType = String(input.blob.type ?? '').toLowerCase();
  if (!isAdmittedMime(input.kind, mimeType)) {
    throw new FileProjectLibraryError('unsupported_media_type', 'Asset MIME type is not admitted.');
  }
  const metadata = {
    projectId: input.projectId,
    kind: input.kind,
    mimeType,
    byteCount: input.blob.size,
    createdAt: input.createdAt === undefined ? Date.now() : input.createdAt,
    sourceKind: input.sourceKind,
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: input.durationMs ?? null,
    sourceMetadata: validateSourceMetadata(input.sourceMetadata ?? {}),
  };
  if (!optionalNonNegativeSafeInteger(metadata.width)
    || !optionalNonNegativeSafeInteger(metadata.height)
    || !optionalNonNegativeSafeInteger(metadata.durationMs)
    || !Number.isSafeInteger(metadata.createdAt)
    || metadata.createdAt < 0) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset dimensions, duration, or createdAt are invalid.');
  }
  return { metadata };
}

export function validateSourceMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FileProjectLibraryError(
      'project_secret_admission_failed',
      'Asset source metadata must be a scalar map.',
    );
  }
  const entries = Object.entries(value);
  if (entries.length > ADMISSION_REGISTRY.limits.maxSourceMetadataEntries) {
    throw new FileProjectLibraryError(
      'project_secret_admission_failed',
      'Asset source metadata has too many entries.',
    );
  }
  const result = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || isSensitiveName(key)) {
      throw new FileProjectLibraryError(
        'project_secret_admission_failed',
        'Asset source metadata contains a forbidden key.',
      );
    }
    if (!(item === null
      || typeof item === 'string'
      || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item)))) {
      throw new FileProjectLibraryError(
        'project_secret_admission_failed',
        'Asset source metadata values must be scalar.',
      );
    }
    if (typeof item === 'string'
      && encoder.encode(item).byteLength > ADMISSION_REGISTRY.limits.maxSourceMetadataStringBytes) {
      throw new FileProjectLibraryError(
        'project_secret_admission_failed',
        'Asset source metadata string is too large.',
      );
    }
    if (typeof item === 'string' && (containsCredentialLikeString(item) || containsUnsafeUrl(item))) {
      throw new FileProjectLibraryError(
        'project_secret_admission_failed',
        'Asset source metadata contains credential-like text.',
      );
    }
    result[key] = item;
  }
  return result;
}

export function optionalNonNegativeSafeInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

export function isAdmittedMime(kind, mimeType) {
  const allowlist = ADMISSION_REGISTRY.media.allowlist;
  return typeof mimeType === 'string'
    && mimeType === mimeType.toLowerCase()
    && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)
    && Array.isArray(allowlist[kind])
    && allowlist[kind].includes(mimeType);
}

export function isAdmittedMimeAny(mimeType) {
  return Object.keys(ADMISSION_REGISTRY.media.allowlist)
    .some((kind) => isAdmittedMime(kind, mimeType));
}

function isStreamableBlob(value) {
  return value
    && typeof value === 'object'
    && Number.isSafeInteger(value.size)
    && value.size >= 0
    && typeof value.type === 'string'
    && typeof value.stream === 'function';
}
