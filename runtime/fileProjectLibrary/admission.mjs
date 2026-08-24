import { ADMISSION_REGISTRY, ADMITTED_NODE_TYPES, CorruptLibraryError, DERIVED_DISPLAY_URL_FIELDS, DIGEST_PATTERN, FileProjectLibraryError, MAX_DURABLE_ASSET_BYTES, MAX_HISTORY_DOCUMENT_BYTES, MAX_PROJECT_DOCUMENT_BYTES, StaleProjectRevisionError, assertExactFields, canonicalize, containsCredentialLikeString, containsUnsafeUrl, encoder, isSensitiveName, parseJsonString, sha256, validateLogicalId, walk } from './core.mjs';

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

export function normalizeProjectRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new FileProjectLibraryError('invalid_project', 'Project record is invalid.');
  }
  assertInputFields(record, [
    'id', 'name', 'createdAt', 'updatedAt', 'nodeCount', 'schemaVersion', 'revision', 'recovery',
    'nodesJson', 'edgesJson', 'viewportJson', 'historyJson',
  ], 'project record');
  validateLogicalId(record.id, 'projectId');
  if (typeof record.name !== 'string' || encoder.encode(record.name).byteLength > 1024) {
    throw new FileProjectLibraryError('invalid_project', 'Project name is invalid.');
  }
  if (containsCredentialLikeString(record.name) || containsUnsafeUrl(record.name)) {
    throw admissionFailure('Project name contains unsafe text.');
  }
  for (const field of ['createdAt', 'updatedAt', 'nodeCount']) {
    if (!Number.isSafeInteger(record[field]) || record[field] < 0) {
      throw new FileProjectLibraryError('invalid_project', `Project ${field} is invalid.`);
    }
  }
  for (const field of ['nodesJson', 'edgesJson', 'viewportJson']) {
    if (typeof record[field] !== 'string') {
      throw new FileProjectLibraryError('invalid_project', `${field} must be JSON text.`);
    }
    if (encoder.encode(record[field]).byteLength > MAX_PROJECT_DOCUMENT_BYTES) {
      throw new FileProjectLibraryError('project_too_large', `${field} exceeds the v1 limit.`);
    }
  }
  if (typeof record.historyJson !== 'string') {
    throw new FileProjectLibraryError('invalid_project', 'historyJson must be JSON text.');
  }
  if (encoder.encode(record.historyJson).byteLength > MAX_HISTORY_DOCUMENT_BYTES) {
    throw new FileProjectLibraryError('history_too_large', 'historyJson exceeds the v1 limit.');
  }
  const nodes = parseJsonString(record.nodesJson, 'nodes');
  const edges = parseJsonString(record.edgesJson, 'edges');
  const viewport = parseJsonString(record.viewportJson, 'viewport');
  const history = parseJsonString(record.historyJson, 'history');
  const admittedEdges = admitCanvasEdges(edges, 'project edges');
  const nodeList = Array.isArray(nodes) ? nodes : nodes?.nodes;
  const admittedNodeList = admitCanvasNodes(nodeList, 'project nodes');
  let admittedNodes = admittedNodeList;
  if (!Array.isArray(nodes)) {
    assertExactInputFields(nodes, ['nodes', 'imagePool'], 'project nodes payload');
    admittedNodes = {
      nodes: admittedNodeList,
      imagePool: validateImagePool(nodes.imagePool, 'project imagePool'),
    };
  }
  const admittedViewport = admitObject(viewport, 'Viewport', 'viewport');
  assertExactInputFields(history, ['past', 'future'], 'history');
  if (!Array.isArray(history.past) || !Array.isArray(history.future)) throw admissionFailure('Project history is invalid.');
  const admittedHistory = {
    past: admitHistorySnapshots(history.past, 'history past'),
    future: admitHistorySnapshots(history.future, 'history future'),
  };
  rejectProjectSecrets({ nodes: admittedNodes, edges: admittedEdges, viewport: admittedViewport, history: admittedHistory });
  if (record.revision !== undefined && record.revision !== null) validateProjectRevision(record.revision, 'revision');
  if (record.recovery !== undefined && record.recovery !== null) validateRecovery(record.recovery);
  if (record.schemaVersion !== undefined && record.schemaVersion !== null
    && (!Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 0 || record.schemaVersion > 1)) {
    throw new FileProjectLibraryError('invalid_project', 'Project schemaVersion is invalid.');
  }
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
    schemaVersion: record.schemaVersion === undefined || record.schemaVersion === null || record.schemaVersion === 0
      ? 1
      : record.schemaVersion,
    ...(record.revision !== undefined && record.revision !== null ? { revision: record.revision } : {}),
    ...(record.recovery ? { recovery: validateRecovery(record.recovery) } : {}),
    nodesJson: canonicalize(admittedNodes),
    edgesJson: canonicalize(admittedEdges),
    viewportJson: canonicalize(admittedViewport),
    historyJson: canonicalize(admittedHistory),
  };
}

export function toProjectDocument(record) {
  const nodes = JSON.parse(record.nodesJson);
  const nodeList = Array.isArray(nodes) ? nodes : nodes.nodes;
  return {
    schemaVersion: record.schemaVersion ?? 1,
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
    revision: record.revision ?? 'r0',
    nodes: nodeList,
    ...(Array.isArray(nodes) ? {} : { imagePool: nodes.imagePool ?? [] }),
    edges: JSON.parse(record.edgesJson),
    viewport: JSON.parse(record.viewportJson),
  };
}

export function collectAssetReferences(value) {
  const references = new Set();
  const referenceFields = new Set([
    'assetId', 'previewAssetId', 'lastFrameAssetId',
    'referenceImageIds', 'referenceAudioIds', 'referenceVideoIds',
  ]);
  walk(value, (key, item) => {
    if (!referenceFields.has(key)) return;
    if (typeof item === 'string') references.add(item);
    if (Array.isArray(item)) {
      for (const reference of item) if (typeof reference === 'string') references.add(reference);
    }
  });
  return references;
}

const OMIT_MEMBER = Symbol('omit-member');

export function admissionFailure(message, details = {}) {
  return new FileProjectLibraryError('project_secret_admission_failed', message, details);
}

export function schemaDefinition(name) {
  return ADMISSION_REGISTRY.schemas[name] ?? ADMISSION_REGISTRY.nodeData[name] ?? null;
}

export function schemaFields(name) {
  const schema = schemaDefinition(name);
  if (!schema) throw admissionFailure(`Admission schema ${name} is not implemented.`);
  const inherited = schema.inherits ? schemaFields(schema.inherits) : {};
  return { ...inherited, ...(schema.fields ?? {}) };
}

export function admitObject(value, schemaName, label, context = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw admissionFailure(`${label} must be an object.`);
  const fields = schemaFields(schemaName);
  const localContext = schemaName === 'CanvasNode' ? { ...context, nodeType: value.type } : context;
  const output = {};
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) throw admissionFailure(`${label} contains unknown member ${key}.`);
  }
  for (const [key, descriptor] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) {
      const profile = descriptor.profile
        ? ADMISSION_REGISTRY.fieldProfiles[descriptor.profile]
        : null;
      if (descriptor.required === true || profile?.required === true) {
        throw admissionFailure(`${label} is missing member ${key}.`);
      }
      continue;
    }
    const fieldContext = schemaName === 'StoryboardFrameItem'
      ? {
        ...localContext,
        assetIdForUrl: value.assetId,
        previewAssetIdForUrl: value.previewAssetId,
        urlField: key,
      }
      : localContext;
    const admitted = admitDescriptor(value[key], descriptor, `${label}.${key}`, fieldContext);
    if (admitted !== OMIT_MEMBER) output[key] = admitted;
  }
  return output;
}

export function admitDescriptor(value, descriptor, label, context) {
  if (descriptor.profile) return admitProfile(value, descriptor, label, context);
  if (descriptor.type === 'enum' || descriptor.type === 'enum|null') {
    const allowed = descriptor.enum ?? [];
    if (!allowed.includes(value) && !(descriptor.type.endsWith('|null') && value === null)) {
      throw admissionFailure(`${label} is not an admitted enum value.`);
    }
    return value;
  }
  if (descriptor.type === 'allowlisted-media-mime|null') {
    if (value !== null && !isAdmittedMimeAny(value)) throw admissionFailure(`${label} has an unsupported media type.`);
    return value;
  }
  if (descriptor.type?.startsWith('array<') && descriptor.type.endsWith('>')) {
    const itemType = descriptor.type.slice(6, -1);
    if (!Array.isArray(value) || value.length > (descriptor.maxItems ?? Number.MAX_SAFE_INTEGER)) {
      throw admissionFailure(`${label} is invalid.`);
    }
    if (itemType === 'HttpUrl') {
      return value.map((item, index) => admitHttpUrl(item, `${label}[${index}]`, descriptor.itemProfile));
    }
    if (itemType === 'string') {
      const result = [];
      const seen = new Set();
      for (const [index, item] of value.entries()) {
        if (typeof item !== 'string'
          || item.length === 0
          || item.length > (descriptor.itemMaxUtf8Bytes ?? 256)
          || (descriptor.itemPattern && !new RegExp(descriptor.itemPattern, 'u').test(item))) {
          throw admissionFailure(`${label}[${index}] is invalid.`);
        }
        if (descriptor.normalization === 'deduplicate-preserve-order') {
          if (seen.has(item)) continue;
          seen.add(item);
        }
        result.push(item);
      }
      return result;
    }
    return value.map((item, index) => admitObject(item, itemType, `${label}[${index}]`, context));
  }
  if (descriptor.type === 'node-type-discriminated-object') {
    return admitNodeData(context.nodeType, value, label, context);
  }
  if (descriptor.type === 'AssetSourceMetadata') return validateSourceMetadata(value);
  if (descriptor.type === 'object' && descriptor.required === false) {
    if (value === null || (value && typeof value === 'object' && !Array.isArray(value))) return value;
    throw admissionFailure(`${label} is invalid.`);
  }
  if (descriptor.type && schemaDefinition(descriptor.type)) return admitObject(value, descriptor.type, label, context);
  throw admissionFailure(`${label} has an unsupported admission type.`);
}

export function admitProfile(value, profileName, label, context) {
  const profileKey = profileName.profile ?? profileName;
  const profile = ADMISSION_REGISTRY.fieldProfiles[profileKey];
  if (!profile) throw admissionFailure(`${label} uses an unsupported admission profile.`);
  const nullable = profile.type.endsWith('|null');
  if (value === null) {
    if (!nullable) throw admissionFailure(`${label} cannot be null.`);
    return profile.normalization === 'drop' ? OMIT_MEMBER : (profile.classification === 'optional-sensitive' ? OMIT_MEMBER : null);
  }
  if (profile.type.startsWith('string')) {
    if (typeof value !== 'string') throw admissionFailure(`${label} must be text.`);
    const maxBytes = profileName.maxUtf8Bytes ?? profile.maxUtf8Bytes;
    if (maxBytes !== undefined && encoder.encode(value).byteLength > maxBytes) throw admissionFailure(`${label} is too large.`);
  }
  switch (profileKey) {
    case 'requiredId':
    case 'optionalId':
      validateLogicalId(value, label);
      return value;
    case 'requiredSafeInteger':
    case 'optionalSafeInteger':
      if (!Number.isSafeInteger(value)) throw admissionFailure(`${label} must be a safe integer.`);
      break;
    case 'requiredFiniteNumber':
    case 'optionalFiniteNumber':
      if (!Number.isFinite(value)) throw admissionFailure(`${label} must be finite.`);
      break;
    case 'requiredBoolean':
    case 'optionalBoolean':
      if (typeof value !== 'boolean') throw admissionFailure(`${label} must be boolean.`);
      break;
    case 'requiredUserText':
    case 'optionalUserText':
      if (typeof value !== 'string') throw admissionFailure(`${label} must be text.`);
      if (containsCredentialLikeString(value) || containsUnsafeUrl(value)) throw admissionFailure(`${label} contains unsafe text.`);
      break;
    case 'optionalSensitiveText':
      if (typeof value !== 'string') throw admissionFailure(`${label} must be text.`);
      return OMIT_MEMBER;
    case 'requiredHttpUrlOrNull':
    case 'optionalHttpUrlOrNull':
    case 'optionalSensitiveHttpUrl':
    case 'optionalDerivedDisplayUrl':
      {
        const parsed = parseHttpUrl(value, label);
        if (profileKey === 'optionalSensitiveHttpUrl' && parsed.unsafe) return OMIT_MEMBER;
        if (parsed.unsafe) throw admissionFailure(`${label} is not an admitted URL.`);
      }
      if (profileKey === 'optionalDerivedDisplayUrl') {
        const backed = context.history
          || (context.ownedAssetIds && (
            context.ownedAssetIds.has(context.assetIdForUrl)
            || (context.urlField === 'previewImageUrl'
              && context.ownedAssetIds.has(context.previewAssetIdForUrl))
            || (context.urlField === 'previewVideoUrl'
              && context.ownedAssetIds.has(context.previewAssetIdForUrl))
            || (context.urlField === 'lastFrameImageUrl'
              && context.ownedAssetIds.has(context.lastFrameAssetIdForUrl))
          ));
        if (backed) return OMIT_MEMBER;
      }
      return value;
    case 'runtimeOnlyBoolean':
      if (typeof value !== 'boolean') throw admissionFailure(`${label} must be boolean.`);
      return OMIT_MEMBER;
    case 'runtimeOnlyObject':
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw admissionFailure(`${label} must be an object.`);
      return OMIT_MEMBER;
    case 'assetReference':
      validateLogicalId(value, label);
      return value;
    case 'assetReferenceArray':
      if (!Array.isArray(value) || value.length > 256) throw admissionFailure(`${label} is invalid.`);
      value.forEach((item, index) => validateLogicalId(item, `${label}[${index}]`));
      return [...value];
    case 'providerParams':
      return admitObject(value, 'ProviderParams', label, context);
    case 'generationHandle':
      return admitObject(value, 'BrowserGenerationJobHandle', label, context);
    default:
      throw admissionFailure(`${label} uses an unsupported admission profile.`);
  }
  const minimum = profileName.minimum;
  const maximum = profileName.maximum;
  if (minimum !== undefined && value < minimum) throw admissionFailure(`${label} is below its minimum.`);
  if (maximum !== undefined && value > maximum) throw admissionFailure(`${label} exceeds its maximum.`);
  if (profileName.minimumExclusive !== undefined && !(value > profileName.minimumExclusive)) {
    throw admissionFailure(`${label} must be greater than its minimum.`);
  }
  if (profileName.maximumExclusive !== undefined && !(value < profileName.maximumExclusive)) {
    throw admissionFailure(`${label} must be less than its maximum.`);
  }
  return value;
}

export function admitHttpUrl(value, label, profile = 'requiredHttpUrlOrNull') {
  if (value === null && profile !== 'requiredHttpUrlOrNull') return null;
  const parsed = parseHttpUrl(value, label);
  if (parsed.unsafe) throw admissionFailure(`${label} is not an admitted URL.`);
  return value;
}

export function parseHttpUrl(value, label) {
  const maxUtf8Bytes = ADMISSION_REGISTRY.fieldProfiles.requiredHttpUrlOrNull.maxUtf8Bytes;
  if (typeof value !== 'string' || encoder.encode(value).byteLength > maxUtf8Bytes) {
    throw admissionFailure(`${label} is not an admitted URL.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw admissionFailure(`${label} is not an admitted URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw admissionFailure(`${label} is not an admitted URL.`);
  }
  return {
    parsed,
    unsafe: Boolean(parsed.username || parsed.password || parsed.search || parsed.hash),
  };
}

export function admitNodeData(nodeType, value, label, context = {}) {
  if (!ADMITTED_NODE_TYPES.has(nodeType)) throw admissionFailure(`${label} has an unknown node type.`);
  return admitObject(value, nodeType, label, { ...context, nodeType });
}

export function admitCanvasNodes(nodes, label, context = {}) {
  if (!Array.isArray(nodes)
    || nodes.length > ADMISSION_REGISTRY.schemas.projectDocument.fields.nodes.maxItems) {
    throw admissionFailure(`${label} is invalid.`);
  }
  return nodes.map((node, index) => {
    const admitted = admitObject(node, 'CanvasNode', `${label}[${index}]`, context);
    return admitted;
  });
}

export function admitCanvasEdges(edges, label, context = {}) {
  if (!Array.isArray(edges)
    || edges.length > ADMISSION_REGISTRY.schemas.projectDocument.fields.edges.maxItems) {
    throw admissionFailure(`${label} is invalid.`);
  }
  return edges.map((edge, index) => admitObject(edge, 'CanvasEdge', `${label}[${index}]`, context));
}

export function validateCanvasNodes(nodes, label, context = {}) {
  admitCanvasNodes(nodes, label, context);
}

export function validateCanvasEdges(edges, label, context = {}) {
  admitCanvasEdges(edges, label, context);
}

export function validateHistorySnapshots(snapshots, label, context = {}) {
  admitHistorySnapshots(snapshots, label, context);
}

export function admitHistorySnapshots(snapshots, label, context = {}, options = {}) {
  if (!Array.isArray(snapshots)) throw admissionFailure(`${label} is invalid.`);
  const maximum = ADMISSION_REGISTRY.limits.maxPersistedHistorySnapshotsPerDirection;
  if (options.truncate === false && snapshots.length > maximum) {
    throw admissionFailure(`${label} exceeds the persisted history limit.`);
  }
  const retained = options.truncate === false ? snapshots : snapshots.slice(-maximum);
  return retained.map((snapshot, index) => admitObject(
    snapshot,
    'CanvasHistorySnapshot',
    `${label}[${index}]`,
    { ...context, history: true },
  ));
}

export function validatePosition(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new FileProjectLibraryError('project_secret_admission_failed', `${label} is invalid.`);
  }
  assertInputFields(value, ['x', 'y'], label);
}

export function validateImagePool(value, label) {
  if (!Array.isArray(value) || value.length > ADMISSION_REGISTRY.schemas.nodesJson.imagePool.maxItems) {
    throw admissionFailure(`${label} is invalid.`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || !isSafeHttpUrl(item)) {
      throw admissionFailure(`${label} contains an invalid URL.`);
    }
  }
  return [...value];
}

export function isSafeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export function stripDerivedDisplayUrls(project, ownedAssetIds) {
  const next = structuredClone(project);
  const nodes = Array.isArray(next.nodes) ? next.nodes : [];
  for (const node of nodes) stripNodeDisplayUrls(node, ownedAssetIds, false);
  return next;
}

export function stripHistoryDisplayUrls(history) {
  for (const snapshot of [...(history.past ?? []), ...(history.future ?? [])]) {
    for (const node of snapshot.nodes ?? []) stripNodeDisplayUrls(node, new Set(), true);
  }
}

export function stripNodeDisplayUrls(node, ownedAssetIds, history) {
  if (!node?.data || typeof node.data !== 'object' || Array.isArray(node.data)) return;
  if (history) {
    for (const field of DERIVED_DISPLAY_URL_FIELDS) delete node.data[field];
    return;
  }
  const mainAsset = typeof node.data.assetId === 'string' && ownedAssetIds.has(node.data.assetId);
  const previewAsset = typeof node.data.previewAssetId === 'string' && ownedAssetIds.has(node.data.previewAssetId);
  const lastFrameAsset = typeof node.data.lastFrameAssetId === 'string' && ownedAssetIds.has(node.data.lastFrameAssetId);
  if (mainAsset) {
    for (const field of ['imageUrl', 'videoUrl', 'audioUrl']) delete node.data[field];
  }
  if (mainAsset || previewAsset) {
    for (const field of ['previewImageUrl', 'previewVideoUrl']) delete node.data[field];
  }
  if (lastFrameAsset) delete node.data.lastFrameImageUrl;
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

export function validateViewportValue(value, label) {
  return admitObject(value, 'Viewport', label);
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
  const equivalentEmptyRevision = expected === 'r0' && actual === 'absent';
  if (expected !== undefined && expected !== actual && !equivalentEmptyRevision) {
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
