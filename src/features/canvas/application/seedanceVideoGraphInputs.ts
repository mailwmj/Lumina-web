import type { CanvasEdge, CanvasWorkflowNode } from '../domain/canvasNodes';
import { resolveEdgeValueType } from './textGenerationInputs';
import {
  type SeedanceConnectedInput,
  type SeedanceConnectedMedia,
  type SeedanceConnectedText,
  type SeedanceMediaType,
} from './seedanceVideoRequestPlan';

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

function resolveConnectedText(
  node: CanvasWorkflowNode,
  nodesById: Map<string, CanvasWorkflowNode>,
  edges: readonly CanvasEdge[],
  visiting: Set<string>,
): string {
  if (node.type !== 'textGenerationNode') {
    return '';
  }
  const data = node.data as Record<string, unknown>;
  const generatedText = typeof data.generatedText === 'string' && data.generatedText.trim()
    ? data.generatedText
    : null;
  if (generatedText) {
    return generatedText;
  }
  if (visiting.has(node.id)) {
    return '';
  }
  visiting.add(node.id);
  const upstream = sortInputEdges(edges.filter((edge) => edge.target === node.id))
    .flatMap((edge) => {
      const source = nodesById.get(edge.source);
      return source && resolveEdgeValueType(edge, source) === 'text'
        ? [resolveConnectedText(source, nodesById, edges, visiting)]
        : [];
    })
    .filter((value) => value.trim());
  visiting.delete(node.id);
  const localText = typeof data.inputText === 'string' && data.inputText.trim()
    ? data.inputText
    : '';
  return [...upstream, ...(localText ? [localText] : [])].join('\n\n');
}

function resolveConnectedInput(
  edge: CanvasEdge,
  sourceNode: CanvasWorkflowNode,
  nodesById: Map<string, CanvasWorkflowNode>,
  edges: readonly CanvasEdge[],
): SeedanceConnectedInput | null {
  const valueType = resolveEdgeValueType(edge, sourceNode);
  if (valueType === 'text') {
    const text = resolveConnectedText(sourceNode, nodesById, edges, new Set());
    return {
      sourceNodeId: sourceNode.id,
      sourceNodeType: sourceNode.type,
      targetHandle: edge.targetHandle,
      type: 'text',
      text,
    } satisfies SeedanceConnectedText;
  }
  if (valueType !== 'image' && valueType !== 'video' && valueType !== 'audio') {
    return null;
  }
  return {
    sourceNodeId: sourceNode.id,
    sourceNodeType: sourceNode.type,
    targetHandle: edge.targetHandle,
    type: valueType,
    ...resolveMediaReference(sourceNode, valueType),
  } satisfies SeedanceConnectedMedia;
}

/** Resolves the complete ordered typed snapshot, including connected text sources. */
export function resolveSeedanceVideoGraphInputsWithText(
  nodeId: string,
  nodes: readonly CanvasWorkflowNode[],
  edges: readonly CanvasEdge[],
): SeedanceConnectedInput[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return sortInputEdges(edges.filter((edge) => edge.target === nodeId)).flatMap((edge) => {
    const sourceNode = nodesById.get(edge.source);
    if (!sourceNode) return [];
    const input = resolveConnectedInput(edge, sourceNode, nodesById, edges);
    return input ? [input] : [];
  });
}

export function resolveSeedanceVideoGraphInputs(
  nodeId: string,
  nodes: readonly CanvasWorkflowNode[],
  edges: readonly CanvasEdge[]
): SeedanceConnectedMedia[] {
  return resolveSeedanceVideoGraphInputsWithText(nodeId, nodes, edges)
    .filter((input): input is SeedanceConnectedMedia => input.type !== 'text');
}
