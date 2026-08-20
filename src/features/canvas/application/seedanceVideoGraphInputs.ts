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

function resolveMediaReference(
  node: CanvasWorkflowNode,
  type: SeedanceMediaType,
): Pick<SeedanceConnectedMedia, 'assetId' | 'url'> {
  const data = node.data as Record<string, unknown>;
  const key = type === 'image'
    ? 'imageUrl'
    : type === 'video'
      ? 'videoUrl'
      : 'audioUrl';
  const value = data[key];
  const assetId = typeof data.assetId === 'string' && data.assetId.trim()
    ? data.assetId
    : null;
  return {
    ...(assetId ? { assetId } : {}),
    url: typeof value === 'string' && value.trim() ? value : null,
  };
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
      ...resolveMediaReference(sourceNode, valueType),
    }];
  });
}
