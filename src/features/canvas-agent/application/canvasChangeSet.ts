import { v4 as uuidv4 } from 'uuid';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import {
  inferCanvasConnectionValueType,
  isCanvasProgrammaticConnectionValid,
} from '@/features/canvas/application/canvasConnection';
import {
  CANVAS_NODE_TYPES,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_SIZES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  type StoryboardGenFrameItem,
  type StoryboardGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  getNodeAgentAccess,
  getNodeDefinition,
} from '@/features/canvas/domain/nodeRegistry';
import { TEXT_REASONING_EFFORTS } from '@/features/canvas/models/types';
import type {
  CanvasChangeApplyResult,
  CanvasChangeOperation,
  CanvasChangeSet,
  PendingCanvasChangeProposal,
} from '@/features/canvas-agent/domain/types';
import { resolveCanvasAgentColumnLayout } from './canvasAgentLayout';

const MAX_OPERATIONS = 100;
const MAX_POSITION = 10_000_000;
const MAX_DATA_JSON_LENGTH = 64_000;
const MAX_AGENT_DISPLAY_NAME_LENGTH = 80;
const NODE_TYPES = new Set<string>(Object.values(CANVAS_NODE_TYPES));

export class CanvasChangeSetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CanvasChangeSetError';
  }
}

interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface AppliedCanvasChangeSet extends CanvasGraph {
  result: CanvasChangeApplyResult;
}

export function applyCanvasChangeSet(
  graph: CanvasGraph,
  changeSet: CanvasChangeSet
): AppliedCanvasChangeSet {
  if (!Array.isArray(changeSet.operations) || changeSet.operations.length === 0) {
    throw new CanvasChangeSetError('EMPTY_CHANGE_SET', 'The canvas change set is empty.');
  }
  if (changeSet.operations.length > MAX_OPERATIONS) {
    throw new CanvasChangeSetError('TOO_MANY_OPERATIONS', 'The canvas change set is too large.');
  }

  let nodes = [...graph.nodes];
  let edges = [...graph.edges];
  const nodeIdMap = new Map<string, string>();
  const createdNodeIds: string[] = [];
  const updatedNodeIds = new Set<string>();
  const movedNodeIds = new Set<string>();
  const connectedEdgeIds: string[] = [];
  const affectedStoryboardNodeIds = new Set<string>();
  const automaticPositions = new Map(
    resolveCanvasAgentColumnLayout(
      graph.nodes,
      changeSet.operations.flatMap((operation) => (
        operation.type === 'create_node' && !operation.position
          ? [{ key: operation.clientId, nodeType: operation.nodeType }]
          : []
      ))
    ).map((placement) => [placement.key, placement.position])
  );

  changeSet.operations.forEach((operation, index) => {
    if (operation.type === 'create_node') {
      if (
        !operation.clientId
        || nodeIdMap.has(operation.clientId)
        || nodes.some((node) => node.id === operation.clientId)
      ) {
        throw new CanvasChangeSetError(
          'DUPLICATE_CLIENT_NODE_ID',
          `Operation ${index + 1} has a duplicate client node ID.`
        );
      }
      if (!isCanvasNodeType(operation.nodeType)) {
        throw new CanvasChangeSetError('UNKNOWN_NODE_TYPE', `Unknown node type: ${operation.nodeType}`);
      }
      const access = getNodeAgentAccess(operation.nodeType);
      if (!access.creatable) {
        throw new CanvasChangeSetError(
          'NODE_TYPE_NOT_CREATABLE',
          `External Agents cannot create node type ${operation.nodeType}.`
        );
      }
      const position = operation.position
        ? validatePosition(operation.position)
        : automaticPositions.get(operation.clientId);
      if (!position) {
        throw new CanvasChangeSetError(
          'POSITION_NOT_RESOLVED',
          `Operation ${index + 1} could not resolve a node position.`
        );
      }
      const data = applyDefaultDisplayName(
        operation.nodeType,
        validateNodeDataPatch(operation.nodeType, operation.data ?? {}),
        nodes
      );
      const node = canvasNodeFactory.createNode(
        operation.nodeType,
        position,
        data as Partial<CanvasNodeData>
      );
      nodes = [...nodes, node];
      nodeIdMap.set(operation.clientId, node.id);
      createdNodeIds.push(node.id);
      if (node.type === CANVAS_NODE_TYPES.storyboardGen) {
        affectedStoryboardNodeIds.add(node.id);
      }
      return;
    }

    if (operation.type === 'update_node') {
      const nodeId = resolveNodeId(operation.nodeId, nodeIdMap);
      const nodeIndex = nodes.findIndex((node) => node.id === nodeId);
      if (nodeIndex < 0) {
        throw new CanvasChangeSetError('NODE_NOT_FOUND', `Node not found: ${operation.nodeId}`);
      }
      const node = nodes[nodeIndex];
      const data = validateNodeDataPatch(node.type, operation.data);
      if (Object.keys(data).length === 0) {
        throw new CanvasChangeSetError('EMPTY_NODE_PATCH', 'A node update must change at least one field.');
      }
      const nextNode: CanvasNode = {
        ...node,
        data: {
          ...node.data,
          ...data,
        } as CanvasNodeData,
      };
      nodes = nodes.map((candidate, candidateIndex) => (
        candidateIndex === nodeIndex ? nextNode : candidate
      ));
      updatedNodeIds.add(nodeId);
      if (
        node.type === CANVAS_NODE_TYPES.storyboardGen
        && ('gridRows' in data || 'gridCols' in data || 'frames' in data)
      ) {
        affectedStoryboardNodeIds.add(nodeId);
      }
      return;
    }

    if (operation.type === 'move_node') {
      const nodeId = resolveNodeId(operation.nodeId, nodeIdMap);
      if (!nodes.some((node) => node.id === nodeId)) {
        throw new CanvasChangeSetError('NODE_NOT_FOUND', `Node not found: ${operation.nodeId}`);
      }
      const position = validatePosition(operation.position);
      nodes = nodes.map((node) => node.id === nodeId ? { ...node, position } : node);
      movedNodeIds.add(nodeId);
      return;
    }

    if (operation.type === 'connect_nodes') {
      const sourceNodeId = resolveNodeId(operation.sourceNodeId, nodeIdMap);
      const targetNodeId = resolveNodeId(operation.targetNodeId, nodeIdMap);
      const sourceNode = nodes.find((node) => node.id === sourceNodeId);
      const targetNode = nodes.find((node) => node.id === targetNodeId);
      if (!sourceNode || !targetNode) {
        throw new CanvasChangeSetError(
          'NODE_NOT_FOUND',
          `Connection references a missing node in operation ${index + 1}.`
        );
      }
      const valueType = inferCanvasConnectionValueType(sourceNode);
      const sourceHandle = operation.sourceHandle ?? 'source';
      const targetHandle = operation.targetHandle
        ?? resolveDefaultTargetHandle(targetNode.type, valueType);
      validateConnectionHandle(sourceNode.type, 'source', sourceHandle);
      validateConnectionHandle(targetNode.type, 'target', targetHandle);
      if (
        targetNode.type === CANVAS_NODE_TYPES.videoFrame
        && edges.some((edge) => (
          edge.target === targetNodeId && edge.targetHandle === targetHandle
        ))
      ) {
        throw new CanvasChangeSetError(
          'TARGET_HANDLE_OCCUPIED',
          `Target handle ${targetHandle} already has an input.`
        );
      }
      const connection = {
        source: sourceNodeId,
        target: targetNodeId,
        sourceHandle,
        targetHandle,
      };
      if (!isCanvasProgrammaticConnectionValid(connection, nodes, edges)) {
        throw new CanvasChangeSetError(
          'INVALID_CONNECTION',
          `Connection ${operation.sourceNodeId} -> ${operation.targetNodeId} is not compatible.`
        );
      }
      const edgeId = uuidv4();
      const inputOrder = valueType
        ? edges.reduce((highest, edge) => {
          if (edge.target !== targetNodeId || edge.data?.valueType !== valueType) {
            return highest;
          }
          const order = Number.isFinite(edge.data?.inputOrder)
            ? Number(edge.data?.inputOrder)
            : -1;
          return Math.max(highest, order);
        }, -1) + 1
        : undefined;
      edges = [...edges, {
        id: edgeId,
        source: sourceNodeId,
        target: targetNodeId,
        sourceHandle,
        targetHandle,
        type: 'disconnectableEdge',
        data: {
          ...(valueType ? { valueType } : {}),
          ...(typeof inputOrder === 'number' ? { inputOrder } : {}),
        },
      }];
      connectedEdgeIds.push(edgeId);
      return;
    }

    const exhaustiveOperation: never = operation;
    throw new CanvasChangeSetError(
      'UNKNOWN_OPERATION',
      `Unknown operation: ${String((exhaustiveOperation as { type?: unknown }).type)}`
    );
  });

  nodes = normalizeStoryboardFrames(nodes, affectedStoryboardNodeIds);

  return {
    nodes,
    edges,
    result: {
      createdNodeIds,
      updatedNodeIds: [...updatedNodeIds],
      movedNodeIds: [...movedNodeIds],
      connectedEdgeIds,
      nodeIdMap: Object.fromEntries(nodeIdMap),
    },
  };
}

export function parsePendingCanvasChangeProposal(value: unknown): PendingCanvasChangeProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanvasChangeSetError('INVALID_PROPOSAL', 'The canvas proposal payload is invalid.');
  }
  const record = value as Record<string, unknown>;
  const changeSet = record.changeSet;
  if (
    typeof record.proposalId !== 'string'
    || !record.proposalId
    || typeof record.createdAt !== 'number'
    || !changeSet
    || typeof changeSet !== 'object'
    || Array.isArray(changeSet)
  ) {
    throw new CanvasChangeSetError('INVALID_PROPOSAL', 'The canvas proposal payload is incomplete.');
  }
  const changeSetRecord = changeSet as Record<string, unknown>;
  if (
    typeof changeSetRecord.projectId !== 'string'
    || typeof changeSetRecord.baseRevision !== 'string'
    || typeof changeSetRecord.summary !== 'string'
    || !Array.isArray(changeSetRecord.operations)
  ) {
    throw new CanvasChangeSetError('INVALID_PROPOSAL', 'The canvas change set is incomplete.');
  }
  const operations = changeSetRecord.operations.map(parseOperation);
  return {
    proposalId: record.proposalId,
    createdAt: record.createdAt,
    changeSet: {
      projectId: changeSetRecord.projectId,
      baseRevision: changeSetRecord.baseRevision,
      summary: changeSetRecord.summary,
      operations,
    },
  };
}

function parseOperation(value: unknown): CanvasChangeOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanvasChangeSetError('INVALID_OPERATION', 'A canvas operation is invalid.');
  }
  const operation = value as Record<string, unknown>;
  if (operation.type === 'create_node') {
    if (
      typeof operation.clientId !== 'string'
      || typeof operation.nodeType !== 'string'
      || !isCanvasNodeType(operation.nodeType)
    ) {
      throw new CanvasChangeSetError('INVALID_OPERATION', 'A create-node operation is invalid.');
    }
    return {
      type: 'create_node',
      clientId: operation.clientId,
      nodeType: operation.nodeType,
      ...(operation.position === undefined ? {} : { position: parsePosition(operation.position) }),
      ...(isRecord(operation.data) ? { data: operation.data } : {}),
    };
  }
  if (operation.type === 'update_node') {
    if (typeof operation.nodeId !== 'string' || !isRecord(operation.data)) {
      throw new CanvasChangeSetError('INVALID_OPERATION', 'An update-node operation is invalid.');
    }
    return { type: 'update_node', nodeId: operation.nodeId, data: operation.data };
  }
  if (operation.type === 'move_node') {
    if (typeof operation.nodeId !== 'string') {
      throw new CanvasChangeSetError('INVALID_OPERATION', 'A move-node operation is invalid.');
    }
    return {
      type: 'move_node',
      nodeId: operation.nodeId,
      position: parsePosition(operation.position),
    };
  }
  if (operation.type === 'connect_nodes') {
    if (typeof operation.sourceNodeId !== 'string' || typeof operation.targetNodeId !== 'string') {
      throw new CanvasChangeSetError('INVALID_OPERATION', 'A connect-nodes operation is invalid.');
    }
    return {
      type: 'connect_nodes',
      sourceNodeId: operation.sourceNodeId,
      targetNodeId: operation.targetNodeId,
      ...(typeof operation.sourceHandle === 'string'
        ? { sourceHandle: operation.sourceHandle }
        : {}),
      ...(typeof operation.targetHandle === 'string'
        ? { targetHandle: operation.targetHandle }
        : {}),
    };
  }
  throw new CanvasChangeSetError('UNKNOWN_OPERATION', 'The canvas operation type is not allowed.');
}

function validateNodeDataPatch(
  nodeType: CanvasNodeType,
  data: Record<string, unknown>
): Record<string, unknown> {
  if (!isRecord(data)) {
    throw new CanvasChangeSetError('INVALID_NODE_DATA', 'Node data must be an object.');
  }
  const access = getNodeAgentAccess(nodeType);
  const writableFields = new Set(access.writableFields);
  const normalizedData: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(data)) {
    if (!writableFields.has(field)) {
      throw new CanvasChangeSetError(
        'FIELD_NOT_WRITABLE',
        `Field ${field} is not writable on ${nodeType}.`
      );
    }
    normalizedData[field] = field === 'frames'
      ? parseStoryboardFrames(value)
      : validateFieldValue(field, value);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(normalizedData);
  } catch {
    throw new CanvasChangeSetError('INVALID_NODE_DATA', 'Node data must be JSON serializable.');
  }
  if (serialized.length > MAX_DATA_JSON_LENGTH) {
    throw new CanvasChangeSetError('NODE_DATA_TOO_LARGE', 'Node data is too large.');
  }
  return normalizedData;
}

function validateFieldValue(field: string, value: unknown): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new CanvasChangeSetError('INVALID_FIELD_VALUE', `Field ${field} has an invalid value.`);
  }
  if (['displayName', 'model', 'textApiId', 'textModelId'].includes(field)) {
    validateString(field, value, field === 'displayName' ? MAX_AGENT_DISPLAY_NAME_LENGTH : 500);
    return value;
  }
  if (['content', 'inputText', 'prompt', 'globalPrompt'].includes(field)) {
    validateString(field, value, 20_000);
    return value;
  }
  if (field === 'size' && !IMAGE_SIZES.includes(value as never)) {
    throw new CanvasChangeSetError('INVALID_FIELD_VALUE', `Field ${field} has an unsupported value.`);
  }
  if (field === 'outputCount' && !IMAGE_OUTPUT_COUNTS.includes(value as never)) {
    throw new CanvasChangeSetError('INVALID_FIELD_VALUE', `Field ${field} has an unsupported value.`);
  }
  if (field === 'resolution' && !['480p', '720p', '1080p'].includes(String(value))) {
    throw new CanvasChangeSetError('INVALID_FIELD_VALUE', `Field ${field} has an unsupported value.`);
  }
  if (field === 'ratioControlMode' && value !== 'overall' && value !== 'cell') {
    throw new CanvasChangeSetError('INVALID_FIELD_VALUE', `Field ${field} has an unsupported value.`);
  }
  if (field === 'generationMode' && !['multimodal', 'edit', 'extend'].includes(String(value))) {
    throw new CanvasChangeSetError('INVALID_FIELD_VALUE', `Field ${field} has an unsupported value.`);
  }
  if (field === 'textReasoningEffort' && !TEXT_REASONING_EFFORTS.includes(value as never)) {
    throw new CanvasChangeSetError('INVALID_FIELD_VALUE', `Field ${field} has an unsupported value.`);
  }
  if (['gridRows', 'gridCols'].includes(field)) {
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 9) {
      throw new CanvasChangeSetError('INVALID_FIELD_VALUE', `Field ${field} must be an integer from 1 to 9.`);
    }
    return value;
  }
  if (field === 'duration') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 60) {
      throw new CanvasChangeSetError('INVALID_FIELD_VALUE', 'Duration must be between 1 and 60.');
    }
    return value;
  }
  if (field === 'seed') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new CanvasChangeSetError('INVALID_FIELD_VALUE', 'Seed must be an integer.');
    }
    return value;
  }
  if (['hasAudio', 'returnLastFrame', 'camerafixed', 'watermark'].includes(field)) {
    if (typeof value !== 'boolean') {
      throw new CanvasChangeSetError('INVALID_FIELD_VALUE', `Field ${field} must be boolean.`);
    }
    return value;
  }
  if (field === 'aspectRatio' || field === 'requestAspectRatio') {
    const match = typeof value === 'string'
      ? value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/)
      : null;
    if (value !== 'auto' && (
      !match
      || Number(match[1]) <= 0
      || Number(match[2]) <= 0
    )) {
      throw new CanvasChangeSetError('INVALID_FIELD_VALUE', `Field ${field} is not a valid ratio.`);
    }
    return value;
  }
  validateJsonValue(value, 0);
  return value;
}

function applyDefaultDisplayName(
  nodeType: CanvasNodeType,
  data: Record<string, unknown>,
  existingNodes: readonly CanvasNode[]
): Record<string, unknown> {
  if (nodeType !== CANVAS_NODE_TYPES.imageEdit || readNonEmptyString(data.displayName)) {
    return data;
  }
  const nextIndex = existingNodes.filter((node) => node.type === CANVAS_NODE_TYPES.imageEdit).length + 1;
  return { ...data, displayName: `AI生图 ${nextIndex}` };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseStoryboardFrames(value: unknown): StoryboardGenFrameItem[] {
  if (!Array.isArray(value) || value.length > 81) {
    throw new CanvasChangeSetError('INVALID_FIELD_VALUE', 'Storyboard frames must be an array of at most 81 items.');
  }
  const frameIds = new Set<string>();
  return value.map((frame) => {
    if (!isRecord(frame)) {
      throw new CanvasChangeSetError('INVALID_FIELD_VALUE', 'A storyboard frame is invalid.');
    }
    const unknownFields = Object.keys(frame).filter((field) => (
      field !== 'id' && field !== 'description' && field !== 'referenceIndex'
    ));
    if (unknownFields.length > 0) {
      throw new CanvasChangeSetError(
        'INVALID_FIELD_VALUE',
        `Storyboard frames contain unsupported fields: ${unknownFields.join(', ')}.`
      );
    }
    validateString('frames.id', frame.id, 160);
    validateString('frames.description', frame.description, 4_000);
    if (
      frame.referenceIndex !== null
      && (!Number.isInteger(frame.referenceIndex) || Number(frame.referenceIndex) < 0)
    ) {
      throw new CanvasChangeSetError('INVALID_FIELD_VALUE', 'A storyboard reference index is invalid.');
    }
    if (frameIds.has(frame.id as string)) {
      throw new CanvasChangeSetError('INVALID_FIELD_VALUE', 'Storyboard frame IDs must be unique.');
    }
    frameIds.add(frame.id as string);
    return {
      id: frame.id as string,
      description: frame.description as string,
      referenceIndex: frame.referenceIndex as number | null,
    };
  });
}

function validateJsonValue(value: unknown, depth: number): void {
  if (depth > 5) {
    throw new CanvasChangeSetError('INVALID_FIELD_VALUE', 'Nested node data is too deep.');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanvasChangeSetError('INVALID_FIELD_VALUE', 'Node data contains a non-finite number.');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => validateJsonValue(item, depth + 1));
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((item) => validateJsonValue(item, depth + 1));
    return;
  }
  throw new CanvasChangeSetError('INVALID_FIELD_VALUE', 'Node data contains a non-JSON value.');
}

function validateString(field: string, value: unknown, maxLength: number): void {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new CanvasChangeSetError(
      'INVALID_FIELD_VALUE',
      `Field ${field} must be a string no longer than ${maxLength} characters.`
    );
  }
}

function validatePosition(position: { x: number; y: number }): { x: number; y: number } {
  if (
    !position
    || !Number.isFinite(position.x)
    || !Number.isFinite(position.y)
    || Math.abs(position.x) > MAX_POSITION
    || Math.abs(position.y) > MAX_POSITION
  ) {
    throw new CanvasChangeSetError('INVALID_POSITION', 'The node position is outside the supported canvas range.');
  }
  return { x: position.x, y: position.y };
}

function parsePosition(value: unknown): { x: number; y: number } {
  if (!isRecord(value) || typeof value.x !== 'number' || typeof value.y !== 'number') {
    throw new CanvasChangeSetError('INVALID_POSITION', 'A canvas position is invalid.');
  }
  return validatePosition({ x: value.x, y: value.y });
}

function resolveNodeId(nodeId: string, nodeIdMap: Map<string, string>): string {
  return nodeIdMap.get(nodeId) ?? nodeId;
}

function validateConnectionHandle(
  nodeType: CanvasNodeType,
  direction: 'source' | 'target',
  handleId: string
): void {
  const connectivity = getNodeDefinition(nodeType).connectivity;
  const enabled = direction === 'source'
    ? connectivity.sourceHandle
    : connectivity.targetHandle;
  const allowedHandleIds = direction === 'source'
    ? connectivity.sourceHandleIds ?? ['source']
    : connectivity.targetHandleIds ?? ['target'];
  if (!enabled || !allowedHandleIds.includes(handleId)) {
    throw new CanvasChangeSetError(
      'INVALID_CONNECTION_HANDLE',
      `Handle ${handleId} is not a valid ${direction} handle on ${nodeType}.`
    );
  }
}

function normalizeStoryboardFrames(
  nodes: CanvasNode[],
  affectedNodeIds: Set<string>
): CanvasNode[] {
  if (affectedNodeIds.size === 0) {
    return nodes;
  }
  return nodes.map((node) => {
    if (!affectedNodeIds.has(node.id) || node.type !== CANVAS_NODE_TYPES.storyboardGen) {
      return node;
    }
    const data = node.data as StoryboardGenNodeData;
    const frameCount = data.gridRows * data.gridCols;
    if (data.frames.length === frameCount) {
      return node;
    }
    const frames = data.frames.slice(0, frameCount);
    while (frames.length < frameCount) {
      frames.push({
        id: `frame-${uuidv4()}`,
        description: '',
        referenceIndex: null,
      });
    }
    return {
      ...node,
      data: {
        ...data,
        frames,
      },
    } as CanvasNode;
  });
}

function resolveDefaultTargetHandle(
  targetType: CanvasNodeType,
  valueType: ReturnType<typeof inferCanvasConnectionValueType>
): string {
  if (targetType === CANVAS_NODE_TYPES.videoFrame) {
    throw new CanvasChangeSetError(
      'TARGET_HANDLE_REQUIRED',
      'Frame video nodes require target-first or target-last.'
    );
  }
  if (targetType === CANVAS_NODE_TYPES.sd2VideoGen) {
    return valueType === 'audio'
      ? 'target-audios'
      : valueType === 'video'
        ? 'target-videos'
        : 'target-images';
  }
  return 'target';
}

function isCanvasNodeType(value: string): value is CanvasNodeType {
  return NODE_TYPES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
