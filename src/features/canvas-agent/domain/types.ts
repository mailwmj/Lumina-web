import type { Viewport } from '@xyflow/react';

import type {
  CanvasDataType,
  CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';

export const CANVAS_AGENT_PROTOCOL_VERSION = 2;

export interface CanvasAgentNodeCapability {
  nodeType: CanvasNodeType;
  labelKey: string;
  creatable: boolean;
  readableFields: readonly string[];
  writableFields: readonly string[];
  sourceHandle: boolean;
  targetHandle: boolean;
  sourceHandleIds: readonly string[];
  targetHandleIds: readonly string[];
  sourceDataTypes: CanvasDataType[];
  targetDataTypes: CanvasDataType[];
}

export interface CanvasAgentCapabilities {
  nodeTypes: CanvasAgentNodeCapability[];
  operations: readonly ['create_node', 'update_node', 'move_node', 'connect_nodes'];
  actions: readonly ['import_images', 'run_nodes', 'get_node_images'];
  restrictions: readonly [
    'active_project_only',
    'direct_apply',
    'no_delete',
    'no_arbitrary_result_node_creation',
    'explicit_image_reads'
  ];
}

export interface CanvasAgentNodeSnapshot {
  id: string;
  type: CanvasNodeType;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  parentId?: string;
  selected: boolean;
  data: Record<string, unknown>;
}

export interface CanvasAgentEdgeSnapshot {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  valueType?: CanvasDataType;
  inputOrder?: number;
}

export interface CanvasAgentImagePreview {
  nodeId: string;
  mimeType: string;
  dataUrl: string;
}

export interface CanvasAgentSnapshot {
  protocolVersion: typeof CANVAS_AGENT_PROTOCOL_VERSION;
  projectId: string;
  projectName: string;
  revision: string;
  nodes: CanvasAgentNodeSnapshot[];
  edges: CanvasAgentEdgeSnapshot[];
  selectedNodeIds: string[];
  viewport: Viewport;
  selectedImagePreviews: CanvasAgentImagePreview[];
  capabilities: CanvasAgentCapabilities;
}

export type CanvasChangeOperation =
  | {
    type: 'create_node';
    clientId: string;
    nodeType: CanvasNodeType;
    position?: { x: number; y: number };
    data?: Record<string, unknown>;
  }
  | {
    type: 'update_node';
    nodeId: string;
    data: Record<string, unknown>;
  }
  | {
    type: 'move_node';
    nodeId: string;
    position: { x: number; y: number };
  }
  | {
    type: 'connect_nodes';
    sourceNodeId: string;
    targetNodeId: string;
    sourceHandle?: string;
    targetHandle?: string;
  };

export interface CanvasChangeSet {
  projectId: string;
  baseRevision: string;
  summary: string;
  operations: CanvasChangeOperation[];
}

export interface PendingCanvasChangeProposal {
  proposalId: string;
  changeSet: CanvasChangeSet;
  createdAt: number;
}

export interface CanvasAgentImportImageInput {
  clientId: string;
  source: string;
  fileName?: string;
  displayName?: string;
}

export type CanvasAgentActionRequest =
  | {
    type: 'import_images';
    projectId: string;
    baseRevision: string;
    images: CanvasAgentImportImageInput[];
    position?: { x: number; y: number };
  }
  | {
    type: 'run_nodes';
    projectId: string;
    baseRevision: string;
    nodeIds: string[];
  }
  | {
    type: 'get_node_images';
    projectId: string;
    nodeIds: string[];
    maxDimension: number;
  };

export interface PendingCanvasAgentAction {
  actionId: string;
  request: CanvasAgentActionRequest;
  createdAt: number;
}

export interface CanvasChangeApplyResult {
  createdNodeIds: string[];
  updatedNodeIds: string[];
  movedNodeIds: string[];
  connectedEdgeIds: string[];
  nodeIdMap: Record<string, string>;
}

export type CanvasAgentConnectionStatus =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'disconnected';
