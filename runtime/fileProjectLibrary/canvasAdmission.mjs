import {
  ADMISSION_REGISTRY,
  ADMITTED_NODE_TYPES,
  DERIVED_DISPLAY_URL_FIELDS,
  FileProjectLibraryError,
  containsCredentialLikeString,
  containsUnsafeUrl,
  encoder,
  validateLogicalId,
} from './core.mjs';
import { admissionFailure, assertInputFields } from './admissionCommon.mjs';
import { isAdmittedMimeAny, validateSourceMetadata } from './assetAdmission.mjs';

const OMIT_MEMBER = Symbol('omit-member');

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
  return nodes.map((node, index) => admitObject(node, 'CanvasNode', `${label}[${index}]`, context));
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

export function validateViewportValue(value, label) {
  return admitObject(value, 'Viewport', label);
}
