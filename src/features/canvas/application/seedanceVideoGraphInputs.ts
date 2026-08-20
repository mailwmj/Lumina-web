import type { CanvasEdge, CanvasWorkflowNode } from '../domain/canvasNodes';
import { resolveEdgeValueType } from './textGenerationInputs';
import type { SeedanceConnectedMedia, SeedanceMediaType } from './seedanceVideoRequestPlan';

function sortInputEdges(edges: readonly CanvasEdge[]): CanvasEdge[] {
  return edges
    .map((edge, index) => ({ edge, index }))
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.edge.data?.inputOrder)
        ? Number(left.edge.data?.inputOrder)
        : left.index;
      const rightOrder = Number.isFinite(right.edge.data?.inputOrder)
        ? Number(right.edge.data?.inputOrder)
        : right.index;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ edge }) => edge);
}

function resolveMediaUrl(node: CanvasWorkflowNode, type: SeedanceMediaType): string | null {
  const data = node.data as Record<string, unknown>;
  const key = type === 'image'
    ? 'imageUrl'
    : type === 'video'
      ? 'videoUrl'
      : 'audioUrl';
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function resolveSeedanceVideoGraphInputs(
  nodeId: string,
  nodes: readonly CanvasWorkflowNode[],
  edges: readonly CanvasEdge[]
): SeedanceConnectedMedia[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  return sortInputEdges(edges.filter((edge) => edge.target === nodeId)).flatMap((edge) => {
    const sourceNode = nodesById.get(edge.source);
    if (!sourceNode) {
      return [];
    }
    const valueType = resolveEdgeValueType(edge, sourceNode);
    if (valueType !== 'image' && valueType !== 'video' && valueType !== 'audio') {
      return [];
    }
    return [{
      sourceNodeId: sourceNode.id,
      sourceNodeType: sourceNode.type,
      targetHandle: edge.targetHandle,
      type: valueType,
      url: resolveMediaUrl(sourceNode, valueType),
    }];
  });
}
