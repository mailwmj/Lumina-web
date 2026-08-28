import type { Viewport } from '@xyflow/react';

import type {
  CanvasEdge,
  CanvasNode,
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
import { selectReadableCanvasData } from './selectReadableCanvasData';

const AGENT_OPERATIONS = [
  'create_node',
  'update_node',
  'move_node',
  'connect_nodes',
] as const;

const AGENT_ACTIONS = [
  'list_projects',
  'create_project',
  'open_project',
  'import_images',
  'run_nodes',
  'run_video_nodes',
  'get_node_images',
  'get_video_results',
] as const;

const AGENT_RESTRICTIONS = [
  'active_project_only',
  'direct_apply',
  'no_delete',
  'no_arbitrary_result_node_creation',
  'explicit_image_reads',
] as const;

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
  writeAccess?: boolean;
}

export function buildCanvasAgentSnapshot({
  projectId,
  projectName,
  nodes,
  edges,
  selectedNodeIds,
  viewport,
  selectedImagePreviews = [],
  writeAccess = false,
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
      data: selectReadableCanvasData(node.data as Record<string, unknown>, access.readableFields),
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
  return {
    protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION,
    projectId,
    projectName,
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
    writeAccess,
  };
}
