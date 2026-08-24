import { ADMISSION_REGISTRY, CorruptLibraryError, DIGEST_PATTERN, FileProjectLibraryError, MAX_DURABLE_ASSET_BYTES, assertExactFields, canonicalize, containsCredentialLikeString, containsUnsafeUrl, encoder, isSensitiveName, sha256, validateLogicalId } from './core.mjs';

export async function normalizeAssetInput(input) {
  if (!input || typeof input !== 'object' || !(input.blob instanceof Blob)) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset input must include a Blob.');
  }
  validateLogicalId(input.projectId, 'projectId');
  if (!['image', 'video', 'audio'].includes(input.kind) || !['import', 'generation', 'derived'].includes(input.sourceKind)) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset kind or source kind is invalid.');
  }
  if (!Number.isSafeInteger(input.blob.size) || input.blob.size > MAX_DURABLE_ASSET_BYTES) {
    throw new FileProjectLibraryError('asset_too_large', 'Asset bytes exceed the durable library limit.');
  }
  const mimeType = String(input.blob.type ?? '').toLowerCase();
  if (!isAdmittedMime(input.kind, mimeType)) {
    throw new FileProjectLibraryError('unsupported_media_type', 'Asset MIME type is not admitted.');
  }
  const sourceMetadata = validateSourceMetadata(input.sourceMetadata ?? {});
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
    sourceMetadata,
  };
  if (!optionalNonNegativeSafeInteger(metadata.width)
    || !optionalNonNegativeSafeInteger(metadata.height)
    || !optionalNonNegativeSafeInteger(metadata.durationMs)) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset dimensions or duration are invalid.');
  }
  if (!Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0) {
    throw new FileProjectLibraryError('invalid_asset', 'Asset createdAt is invalid.');
  }
  return { metadata };
}

export function validateSourceMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata must be a scalar map.');
  }
  const entries = Object.entries(value);
  if (entries.length > ADMISSION_REGISTRY.limits.maxSourceMetadataEntries) {
    throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata has too many entries.');
  }
  const result = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || isSensitiveName(key)) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata contains a forbidden key.');
    }
    if (!(item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata values must be scalar.');
    }
    if (typeof item === 'string'
      && encoder.encode(item).byteLength > ADMISSION_REGISTRY.limits.maxSourceMetadataStringBytes) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata string is too large.');
    }
    if (typeof item === 'string' && (containsCredentialLikeString(item) || containsUnsafeUrl(item))) {
      throw new FileProjectLibraryError('project_secret_admission_failed', 'Asset source metadata contains credential-like text.');
    }
    result[key] = item;
  }
  return result;
}

export function validateAssetCatalogEntry(entry, metadataDocument) {
  assertExactFields(metadataDocument, ['format', 'version', 'metadata'], [], 'asset metadata');
  validateAssetMetadata(metadataDocument.metadata, 'asset metadata');
  if (
    metadataDocument?.format !== 'lumina-library-asset-metadata'
    || metadataDocument.version !== 1
    || metadataDocument.metadata?.assetId !== entry.assetId
    || metadataDocument.metadata?.projectId !== entry.projectId
    || entry.metadataFormat !== metadataDocument.format
    || entry.metadataVersion !== metadataDocument.version
    || entry.metadataPath !== `assets/${entry.assetKey}/metadata/${entry.metadataSha256}.json`
    || entry.bytesPath !== `assets/${entry.assetKey}/bytes.bin`
    || entry.metadataSha256 !== sha256(canonicalize(metadataDocument))
    || entry.byteCount !== metadataDocument.metadata.byteCount
    || !DIGEST_PATTERN.test(entry.bytesSha256)
  ) {
    throw new CorruptLibraryError('Asset metadata and catalog do not agree.');
  }
}

export function validateAssetMetadata(metadata, label, options = {}) {
  assertExactFields(
    metadata,
    ['assetId', 'projectId', 'kind', 'mimeType', 'byteCount', 'createdAt', 'sourceKind', 'width', 'height', 'durationMs', 'sourceMetadata', 'lifecycleState'],
    [],
    label,
  );
  validateLogicalId(metadata.assetId, `${label} assetId`);
  validateLogicalId(metadata.projectId, `${label} projectId`);
  if (!['image', 'video', 'audio'].includes(metadata.kind)
    || !['import', 'generation', 'derived'].includes(metadata.sourceKind)
    || !['active', 'deletion-candidate', ...(options.allowStaging ? ['staging'] : [])].includes(metadata.lifecycleState)) {
    throw new CorruptLibraryError(`${label} kind or lifecycle is invalid.`);
  }
  if (!isAdmittedMime(metadata.kind, metadata.mimeType)
    || !Number.isSafeInteger(metadata.byteCount)
    || metadata.byteCount < 0
    || metadata.byteCount > MAX_DURABLE_ASSET_BYTES
    || !Number.isSafeInteger(metadata.createdAt)
    || metadata.createdAt < 0
    || !optionalNonNegativeSafeInteger(metadata.width)
    || !optionalNonNegativeSafeInteger(metadata.height)
    || !optionalNonNegativeSafeInteger(metadata.durationMs)) {
    throw new CorruptLibraryError(`${label} scalar fields are invalid.`);
  }
  validateSourceMetadata(metadata.sourceMetadata);
}

export function optionalNonNegativeSafeInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

export function isAdmittedMime(kind, mimeType) {
  const allowlist = ADMISSION_REGISTRY.media.allowlist;
  return typeof mimeType === 'string'
    && mimeType === mimeType.toLowerCase()
    && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)
    && allowlist[kind].includes(mimeType);
}

export function isAdmittedMimeAny(mimeType) {
  return Object.keys(ADMISSION_REGISTRY.media.allowlist)
    .some((kind) => isAdmittedMime(kind, mimeType));
}
