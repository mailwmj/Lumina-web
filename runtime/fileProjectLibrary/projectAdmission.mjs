import {
  FileProjectLibraryError,
  MAX_HISTORY_DOCUMENT_BYTES,
  MAX_PROJECT_DOCUMENT_BYTES,
  canonicalize,
  containsCredentialLikeString,
  containsUnsafeUrl,
  encoder,
  parseJsonString,
  validateLogicalId,
  walk,
} from './core.mjs';
import {
  admissionFailure,
  assertExactInputFields,
  assertInputFields,
  rejectProjectSecrets,
  validateProjectRevision,
  validateRecovery,
} from './admissionCommon.mjs';
import {
  admitCanvasEdges,
  admitCanvasNodes,
  admitHistorySnapshots,
  admitObject,
  validateImagePool,
} from './canvasAdmission.mjs';

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
