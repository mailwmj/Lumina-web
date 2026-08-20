import type { Viewport } from '@xyflow/react';

import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { getNodeAgentAccess } from '@/features/canvas/domain/nodeRegistry';

export const READONLY_CANVAS_PROTOCOL = {
  major: 1,
  minor: 0,
  build: 'lumina-canvas-readonly-v1',
} as const;

export const READONLY_CANVAS_CAPABILITIES = [
  'canvas.read.state',
  'canvas.read.selection',
  'canvas.read.capabilities',
] as const;

export interface ReadonlyCanvasSnapshot {
  protocol: typeof READONLY_CANVAS_PROTOCOL;
  capabilities: readonly string[];
  state: {
    project: { id: string; name: string; revision: string };
    nodes: Array<{
      id: string;
      type: string;
      position: { x: number; y: number };
      width?: number;
      height?: number;
      parentId?: string;
      data: Record<string, unknown>;
    }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      sourceHandle?: string;
      targetHandle?: string;
      valueType?: string;
      inputOrder?: number;
    }>;
    viewport: Viewport;
  };
  selection: { nodeIds: string[] };
}

interface BuildReadonlyCanvasSnapshotInput {
  projectId: string;
  projectName: string;
  projectRevision: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeIds: string[];
  viewport: Viewport;
}

export function buildReadonlyCanvasSnapshot({
  projectId,
  projectName,
  projectRevision,
  nodes,
  edges,
  selectedNodeIds,
  viewport,
}: BuildReadonlyCanvasSnapshotInput): ReadonlyCanvasSnapshot {
  return {
    protocol: READONLY_CANVAS_PROTOCOL,
    capabilities: READONLY_CANVAS_CAPABILITIES,
    state: {
      project: { id: projectId, name: projectName, revision: projectRevision },
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: { x: node.position.x, y: node.position.y },
        ...(typeof node.width === 'number' ? { width: node.width } : {}),
        ...(typeof node.height === 'number' ? { height: node.height } : {}),
        ...(node.parentId ? { parentId: node.parentId } : {}),
        data: selectReadableData(node.data as Record<string, unknown>, getNodeAgentAccess(node.type).readableFields),
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
        ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
        ...(edge.data?.valueType ? { valueType: edge.data.valueType } : {}),
        ...(typeof edge.data?.inputOrder === 'number' ? { inputOrder: edge.data.inputOrder } : {}),
      })),
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
    },
    selection: { nodeIds: [...selectedNodeIds] },
  };
}

function selectReadableData(
  data: Record<string, unknown>,
  readableFields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(readableFields.flatMap((field) => (
    Object.prototype.hasOwnProperty.call(data, field) ? [[field, data[field]]] : []
  )));
}
