import type { Connection } from '@xyflow/react';

import {
  CANVAS_NODE_TYPES,
  type CanvasDataType,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeType,
} from '../domain/canvasNodes';
import {
  getConnectMenuNodeTypes,
  getNodeDefinition,
  getNodeSourceDataTypes,
  getNodeTargetDataTypes,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '../domain/nodeRegistry';

export interface BatchConnectionPlan {
  connections: Connection[];
  skippedDuplicateCount: number;
  invalidSourceIds: string[];
}

type CanvasConnectionLike = {
  source?: string | null;
  target?: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export function canNodeTypeBeManualConnectionSource(type: CanvasNodeType): boolean {
  const connectivity = getNodeDefinition(type).connectivity;
  return connectivity.sourceHandle && connectivity.sourceDataTypes.length > 0;
}

export function inferCanvasConnectionValueType(sourceNode: CanvasNode): CanvasDataType | null {
  const sourceTypes = getNodeSourceDataTypes(sourceNode.type);
  return sourceTypes.length === 1 ? sourceTypes[0] : null;
}

function wouldCreateDirectedCycle(sourceId: string, targetId: string, edges: CanvasEdge[]): boolean {
  const targetsBySource = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = targetsBySource.get(edge.source) ?? [];
    targets.push(edge.target);
    targetsBySource.set(edge.source, targets);
  }

  const pending = [targetId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    if (current === sourceId) {
      return true;
    }
    visited.add(current);
    pending.push(...(targetsBySource.get(current) ?? []));
  }
  return false;
}

export function canNodeBeManualConnectionSource(
  nodeId: string | null | undefined,
  nodes: CanvasNode[]
): boolean {
  if (!nodeId) {
    return false;
  }
  const node = nodes.find((item) => item.id === nodeId);
  return node ? canNodeTypeBeManualConnectionSource(node.type) : false;
}

function getConnectMenuTargetTypesForSource(sourceType: CanvasNodeType): CanvasNodeType[] {
  const candidateTypes = getConnectMenuNodeTypes('source');
  const sourceDataTypes = getNodeSourceDataTypes(sourceType);

  return candidateTypes.filter((candidateType) =>
    sourceDataTypes.some((valueType) =>
      getNodeTargetDataTypes(candidateType).includes(valueType)
    )
  );
}

/** Returns menu targets that can accept every selected source in one batch. */
export function getBatchConnectMenuNodeTypes(
  sourceNodeIds: string[],
  nodes: CanvasNode[]
): CanvasNodeType[] {
  const uniqueSourceIds = [...new Set(sourceNodeIds)];
  const sourceNodes = uniqueSourceIds
    .map((sourceId) => nodes.find((node) => node.id === sourceId))
    .filter((node): node is CanvasNode => Boolean(node));

  if (sourceNodes.length !== uniqueSourceIds.length || sourceNodes.length === 0) {
    return [];
  }

  const candidateTypes = sourceNodes
    .map((sourceNode) => getConnectMenuTargetTypesForSource(sourceNode.type))
    .reduce<CanvasNodeType[]>(
      (sharedTypes, nextTypes) => sharedTypes.filter((type) => nextTypes.includes(type)),
      getConnectMenuTargetTypesForSource(sourceNodes[0].type)
    );

  return candidateTypes.filter((targetType) => {
    const targetNode: CanvasNode = {
      id: `batch-connect-menu-target-${targetType}`,
      type: targetType,
      position: { x: 0, y: 0 },
      data: getNodeDefinition(targetType).createDefaultData(),
    };
    const plan = buildBatchConnectionPlan(
      uniqueSourceIds,
      targetNode.id,
      [...nodes, targetNode],
      []
    );

    return (
      plan.invalidSourceIds.length === 0 &&
      plan.connections.length === uniqueSourceIds.length
    );
  });
}

function isAudioSource(node: CanvasNode): boolean {
  return (
    node.type === CANVAS_NODE_TYPES.audioUpload ||
    node.type === CANVAS_NODE_TYPES.audioUploadRef
  );
}

function isVideoSource(node: CanvasNode): boolean {
  return (
    node.type === CANVAS_NODE_TYPES.videoUpload ||
    node.type === CANVAS_NODE_TYPES.videoUploadRef
  );
}

export function getDefaultCanvasTargetHandle(
  sourceType: CanvasNodeType,
  targetType: CanvasNodeType
): string {
  const sourceDataType = getNodeSourceDataTypes(sourceType)[0];
  const connectivity = getNodeDefinition(targetType).connectivity;
  if (sourceDataType) {
    const configuredHandle = connectivity.defaultTargetHandleByDataType?.[sourceDataType];
    if (configuredHandle) {
      return configuredHandle;
    }
  }
  return connectivity.targetHandleIds?.[0] ?? 'target';
}

function resolveBatchTargetHandle(
  sourceNode: CanvasNode,
  targetNode: CanvasNode,
  edges: CanvasEdge[],
  explicitTargetHandle?: string
): string | null {
  if (explicitTargetHandle) {
    return explicitTargetHandle;
  }

  const targetConnectivity = getNodeDefinition(targetNode.type).connectivity;
  const defaultHandle = getDefaultCanvasTargetHandle(sourceNode.type, targetNode.type);
  const candidates = [
    defaultHandle,
    ...(targetConnectivity.targetHandleIds ?? []),
  ].filter((handle, index, values) => values.indexOf(handle) === index);

  return candidates.find((handle) => {
    const limit = targetConnectivity.targetHandleInputLimits?.[handle];
    if (typeof limit !== 'number') {
      return true;
    }
    const existingCount = edges.filter(
      (edge) => edge.target === targetNode.id && (edge.targetHandle ?? 'target') === handle
    ).length;
    return existingCount < limit;
  }) ?? null;
}

function isCanvasConnectionValidWithPolicy(
  connection: CanvasConnectionLike,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  requireManualSource: boolean,
  enforceDynamicRules: boolean
): boolean {
  const sourceId = connection.source;
  const targetId = connection.target;

  if (!sourceId || !targetId || sourceId === targetId) {
    return false;
  }

  if (requireManualSource && !canNodeBeManualConnectionSource(sourceId, nodes)) {
    return false;
  }

  const sourceNode = nodes.find((node) => node.id === sourceId);
  const targetNode = nodes.find((node) => node.id === targetId);
  if (
    !sourceNode ||
    !targetNode ||
    !nodeHasSourceHandle(sourceNode.type) ||
    !nodeHasTargetHandle(targetNode.type)
  ) {
    return false;
  }

  if (wouldCreateDirectedCycle(sourceId, targetId, edges)) {
    return false;
  }

  if (connectionAlreadyExists(connection, edges)) {
    return false;
  }

  const valueType = inferCanvasConnectionValueType(sourceNode);
  if (!valueType || !getNodeTargetDataTypes(targetNode.type).includes(valueType)) {
    return false;
  }

  const targetConnectivity = getNodeDefinition(targetNode.type).connectivity;
  const targetHandle = connection.targetHandle
    ?? getDefaultCanvasTargetHandle(sourceNode.type, targetNode.type);
  if (targetConnectivity.targetHandleIds && !targetConnectivity.targetHandleIds.includes(targetHandle)) {
    return false;
  }

  const seedanceInputMode = (targetNode.data as { inputMode?: string }).inputMode ?? 'automatic';
  if (targetNode.type === CANVAS_NODE_TYPES.seedanceAutoVideo && seedanceInputMode === 'first-last') {
    if (valueType === 'video' || valueType === 'audio') {
      return false;
    }
    if (valueType === 'image') {
      const imageCount = edges.filter((edge) => {
        if (edge.target !== targetId) {
          return false;
        }
        if (edge.data?.valueType) {
          return edge.data.valueType === 'image';
        }
        const existingSource = nodes.find((node) => node.id === edge.source);
        return existingSource ? inferCanvasConnectionValueType(existingSource) === 'image' : false;
      }).length;
      if (imageCount >= 2) {
        return false;
      }
    }
  }

  const sourceIsAudioUpload = isAudioSource(sourceNode);
  const sourceIsVideoUpload = isVideoSource(sourceNode);

  const targetInputLimit = targetConnectivity.targetInputLimits?.[valueType];
  if (typeof targetInputLimit === 'number') {
    const existingInputCount = edges.filter((edge) => {
      if (edge.target !== targetId) {
        return false;
      }
      if (edge.data?.valueType) {
        return edge.data.valueType === valueType;
      }
      const existingSource = nodes.find((node) => node.id === edge.source);
      return existingSource
        ? inferCanvasConnectionValueType(existingSource) === valueType
        : false;
    }).length;
    if (existingInputCount >= targetInputLimit) {
      return false;
    }
  }

  if (targetNode.type === CANVAS_NODE_TYPES.sd2VideoGen) {
    const expectedHandle = targetConnectivity.defaultTargetHandleByDataType?.[valueType];
    if (expectedHandle && targetHandle !== expectedHandle) {
      return false;
    }
  }

  if (!enforceDynamicRules) {
    return true;
  }

  if (targetNode.type === CANVAS_NODE_TYPES.textGeneration && valueType === 'image') {
    const imageInputCount = edges.filter((edge) => {
      if (edge.target !== targetId) {
        return false;
      }
      if (edge.data?.valueType) {
        return edge.data.valueType === 'image';
      }
      const existingSource = nodes.find((node) => node.id === edge.source);
      return existingSource ? inferCanvasConnectionValueType(existingSource) === 'image' : false;
    }).length;
    if (imageInputCount >= 10) {
      return false;
    }
  }

  if (targetNode.type === CANVAS_NODE_TYPES.sd2VideoGen) {
    const mode = ((targetNode.data as { generationMode?: string }).generationMode ?? 'multimodal') as
      'multimodal' | 'edit' | 'extend' | 'websearch';
    const limits: Record<
      'multimodal' | 'edit' | 'extend' | 'websearch',
      { images: number; audios: number; videos: number }
    > = {
      multimodal: { images: 9, audios: 3, videos: 3 },
      edit: { images: 9, audios: 0, videos: 1 },
      extend: { images: 0, audios: 0, videos: 3 },
      websearch: { images: 0, audios: 0, videos: 0 },
    };
    const modeLimit = limits[mode];

    if (sourceNode.type === CANVAS_NODE_TYPES.upload) {
      if (targetHandle !== 'target-images' || modeLimit.images <= 0) {
        return false;
      }
      const count = edges.filter(
        (edge) =>
          edge.target === targetId &&
          (edge.targetHandle ?? 'target-images') === 'target-images'
      ).length;
      return count < modeLimit.images;
    }

    if (sourceIsAudioUpload) {
      if (targetHandle !== 'target-audios' || modeLimit.audios <= 0) {
        return false;
      }
      const count = edges.filter(
        (edge) => edge.target === targetId && (edge.targetHandle ?? '') === 'target-audios'
      ).length;
      return count < modeLimit.audios;
    }

    if (sourceIsVideoUpload) {
      if (targetHandle !== 'target-videos' || modeLimit.videos <= 0) {
        return false;
      }
      const count = edges.filter(
        (edge) => edge.target === targetId && (edge.targetHandle ?? '') === 'target-videos'
      ).length;
      return count < modeLimit.videos;
    }

    return false;
  }

  return true;
}

export function isCanvasConnectionValid(
  connection: CanvasConnectionLike,
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): boolean {
  return isCanvasConnectionValidWithPolicy(connection, nodes, edges, true, true);
}

export function isCanvasProgrammaticConnectionValid(
  connection: CanvasConnectionLike,
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): boolean {
  return isCanvasConnectionValidWithPolicy(connection, nodes, edges, false, true);
}

/** Validates persisted graph structure without deleting edges due to mutable mode/cap rules. */
export function isCanvasStoredConnectionValid(
  connection: CanvasConnectionLike,
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): boolean {
  return isCanvasConnectionValidWithPolicy(connection, nodes, edges, false, false);
}

function connectionAlreadyExists(connection: CanvasConnectionLike, edges: CanvasEdge[]): boolean {
  return edges.some(
    (edge) =>
      edge.source === connection.source &&
      edge.target === connection.target &&
      (edge.sourceHandle ?? 'source') === (connection.sourceHandle ?? 'source') &&
      (edge.targetHandle ?? 'target') === (connection.targetHandle ?? 'target')
  );
}

export function buildBatchConnectionPlan(
  sourceNodeIds: string[],
  targetNodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  explicitTargetHandle?: string
): BatchConnectionPlan {
  const targetNode = nodes.find((node) => node.id === targetNodeId);
  if (!targetNode) {
    return {
      connections: [],
      skippedDuplicateCount: 0,
      invalidSourceIds: [...new Set(sourceNodeIds)],
    };
  }

  const uniqueSourceIds = [...new Set(sourceNodeIds)].filter((sourceId) => sourceId !== targetNodeId);
  const connections: Connection[] = [];
  const invalidSourceIds: string[] = [];
  let skippedDuplicateCount = 0;
  let simulatedEdges = [...edges];

  for (const sourceId of uniqueSourceIds) {
    const sourceNode = nodes.find((node) => node.id === sourceId);
    if (!sourceNode) {
      invalidSourceIds.push(sourceId);
      continue;
    }

    const targetHandle = resolveBatchTargetHandle(
      sourceNode,
      targetNode,
      simulatedEdges,
      explicitTargetHandle
    );
    if (!targetHandle) {
      invalidSourceIds.push(sourceId);
      continue;
    }

    const connection: Connection = {
      source: sourceId,
      target: targetNodeId,
      sourceHandle: 'source',
      targetHandle,
    };

    if (connectionAlreadyExists(connection, simulatedEdges)) {
      skippedDuplicateCount += 1;
      continue;
    }

    if (!isCanvasConnectionValid(connection, nodes, simulatedEdges)) {
      invalidSourceIds.push(sourceId);
      continue;
    }

    connections.push(connection);
    simulatedEdges = [
      ...simulatedEdges,
      {
        ...connection,
        id: `batch-preview-${sourceId}-${targetNodeId}-${targetHandle}`,
        type: 'disconnectableEdge',
      },
    ];
  }

  return { connections, skippedDuplicateCount, invalidSourceIds };
}
