import type { Viewport } from '@xyflow/react';

import type {
  CanvasEdge,
  CanvasNode,
  CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import {
  canvasNodeDefinitions,
  getNodeAgentAccess,
} from '@/features/canvas/domain/nodeRegistry';
import {
  CANVAS_AGENT_PROTOCOL_VERSION,
  type CanvasAgentCapabilities,
  type CanvasAgentImagePreview,
  type CanvasAgentSnapshot,
} from '@/features/canvas-agent/domain/types';

const AGENT_OPERATIONS = [
  'create_node',
  'update_node',
  'move_node',
  'connect_nodes',
] as const;

const AGENT_ACTIONS = [
  'import_images',
  'run_nodes',
  'get_node_images',
] as const;

const AGENT_RESTRICTIONS = [
  'active_project_only',
  'direct_apply',
  'no_delete',
  'no_arbitrary_result_node_creation',
  'explicit_image_reads',
] as const;

const nodeDataFingerprintCache = new WeakMap<
  object,
  Map<CanvasNodeType, string>
>();

export function buildCanvasAgentCapabilities(): CanvasAgentCapabilities {
  return {
    operations: AGENT_OPERATIONS,
    actions: AGENT_ACTIONS,
    restrictions: AGENT_RESTRICTIONS,
    nodeTypes: Object.values(canvasNodeDefinitions).map((definition) => ({
      nodeType: definition.type,
      labelKey: definition.menuLabelKey,
      creatable: definition.agent.creatable,
      readableFields: definition.agent.readableFields,
      writableFields: definition.agent.writableFields,
      sourceHandle: definition.connectivity.sourceHandle,
      targetHandle: definition.connectivity.targetHandle,
      sourceHandleIds: definition.connectivity.sourceHandle
        ? definition.connectivity.sourceHandleIds ?? ['source']
        : [],
      targetHandleIds: definition.connectivity.targetHandle
        ? definition.connectivity.targetHandleIds ?? ['target']
        : [],
      sourceDataTypes: [...definition.connectivity.sourceDataTypes],
      targetDataTypes: [...definition.connectivity.targetDataTypes],
    })),
  };
}

interface BuildCanvasAgentSnapshotInput {
  projectId: string;
  projectName: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeIds: string[];
  viewport: Viewport;
  selectedImagePreviews?: CanvasAgentImagePreview[];
}

export function buildCanvasAgentSnapshot({
  projectId,
  projectName,
  nodes,
  edges,
  selectedNodeIds,
  viewport,
  selectedImagePreviews = [],
}: BuildCanvasAgentSnapshotInput): CanvasAgentSnapshot {
  const selectedIds = new Set(selectedNodeIds);
  const agentNodes = nodes.map((node) => {
    const access = getNodeAgentAccess(node.type);
    return {
      id: node.id,
      type: node.type,
      position: { x: node.position.x, y: node.position.y },
      ...(typeof node.width === 'number' ? { width: node.width } : {}),
      ...(typeof node.height === 'number' ? { height: node.height } : {}),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      selected: selectedIds.has(node.id),
      data: selectReadableData(node.data as Record<string, unknown>, access.readableFields),
    };
  });
  const agentEdges = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    ...(edge.data?.valueType ? { valueType: edge.data.valueType } : {}),
    ...(typeof edge.data?.inputOrder === 'number' ? { inputOrder: edge.data.inputOrder } : {}),
  }));
  const revision = createCanvasRevision(projectId, agentNodes, agentEdges, nodes);

  return {
    protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION,
    projectId,
    projectName,
    revision,
    nodes: agentNodes,
    edges: agentEdges,
    selectedNodeIds: [...selectedNodeIds],
    viewport: {
      x: viewport.x,
      y: viewport.y,
      zoom: viewport.zoom,
    },
    selectedImagePreviews,
    capabilities: buildCanvasAgentCapabilities(),
  };
}

function selectReadableData(
  data: Record<string, unknown>,
  readableFields: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    readableFields.flatMap((field) => (
      Object.prototype.hasOwnProperty.call(data, field)
        ? [[field, data[field]]]
        : []
    ))
  );
}

function createCanvasRevision(
  projectId: string,
  nodes: CanvasAgentSnapshot['nodes'],
  edges: CanvasAgentSnapshot['edges'],
  sourceNodes: CanvasNode[]
): string {
  const serialized = stableStringify({
    projectId,
    nodes: nodes.map(({ selected: _selected, data, ...node }, index) => ({
      ...node,
      dataFingerprint: createNodeDataFingerprint(sourceNodes[index], data),
    })),
    edges,
  });
  const hash = hashString(serialized);
  return `v1-${hash.toString(16).padStart(16, '0')}-${serialized.length.toString(16)}`;
}

function createNodeDataFingerprint(
  sourceNode: CanvasNode | undefined,
  readableData: Record<string, unknown>
): string {
  if (!sourceNode) {
    return createFingerprint(readableData);
  }
  const data = sourceNode.data as Record<string, unknown>;
  const cacheKey = data as object;
  const cachedByType = nodeDataFingerprintCache.get(cacheKey);
  const cached = cachedByType?.get(sourceNode.type);
  if (cached) {
    return cached;
  }
  const fingerprint = createFingerprint({
    data: readableData,
    media: collectMediaIdentities(data),
  });
  const nextCachedByType = cachedByType ?? new Map<CanvasNodeType, string>();
  nextCachedByType.set(sourceNode.type, fingerprint);
  if (!cachedByType) {
    nodeDataFingerprintCache.set(cacheKey, nextCachedByType);
  }
  return fingerprint;
}

function createFingerprint(value: unknown): string {
  const serialized = stableStringify(value);
  return `${hashString(serialized).toString(16).padStart(16, '0')}-${serialized.length.toString(16)}`;
}

function collectMediaIdentities(data: Record<string, unknown>): string[] {
  const identities: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && value) {
      identities.push(`${hashString(value).toString(16)}:${value.length}`);
    }
  };
  ['imageUrl', 'previewImageUrl', 'videoUrl', 'previewVideoUrl', 'audioUrl'].forEach((field) => {
    add(data[field]);
  });
  if (Array.isArray(data.referenceImages)) {
    data.referenceImages.forEach(add);
  }
  if (Array.isArray(data.frames)) {
    data.frames.forEach((frame) => {
      if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
        const record = frame as Record<string, unknown>;
        add(record.imageUrl);
        add(record.previewImageUrl);
      }
    });
  }
  return identities;
}

function hashString(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
