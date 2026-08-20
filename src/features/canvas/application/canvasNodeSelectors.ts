import type {
  CanvasNode,
  CanvasWorkflowNode,
} from '../domain/canvasNodes';

interface CanvasNodesState {
  nodes: CanvasNode[];
}

function hasSameWorkflowNodes(
  current: readonly CanvasWorkflowNode[],
  next: readonly CanvasNode[]
): boolean {
  return current.length === next.length && current.every((node, index) => {
    const nextNode = next[index];
    return node.id === nextNode.id
      && node.type === nextNode.type
      && node.data === nextNode.data;
  });
}

export function createWorkflowNodesSelector() {
  let sourceNodes: readonly CanvasNode[] | null = null;
  let workflowNodes: readonly CanvasWorkflowNode[] = [];

  return ({ nodes }: CanvasNodesState): readonly CanvasWorkflowNode[] => {
    if (nodes === sourceNodes) {
      return workflowNodes;
    }
    sourceNodes = nodes;

    if (hasSameWorkflowNodes(workflowNodes, nodes)) {
      return workflowNodes;
    }

    workflowNodes = nodes.map((node) => ({
      id: node.id,
      type: node.type,
      data: node.data,
    }));
    return workflowNodes;
  };
}

export function createSelectedNodeIdsSelector() {
  let sourceNodes: readonly CanvasNode[] | null = null;
  let selectedNodeIds: string[] = [];

  return ({ nodes }: CanvasNodesState): string[] => {
    if (nodes === sourceNodes) {
      return selectedNodeIds;
    }
    sourceNodes = nodes;

    const nextSelectedNodeIds = nodes.flatMap((node) => node.selected ? [node.id] : []);
    const hasSameSelection = selectedNodeIds.length === nextSelectedNodeIds.length
      && selectedNodeIds.every((nodeId, index) => nodeId === nextSelectedNodeIds[index]);
    if (hasSameSelection) {
      return selectedNodeIds;
    }

    selectedNodeIds = nextSelectedNodeIds;
    return selectedNodeIds;
  };
}

export const selectWorkflowNodes = createWorkflowNodesSelector();
export const selectSelectedNodeIds = createSelectedNodeIdsSelector();
