import type { CanvasEdge } from '../domain/canvasNodes';

/** Keeps each target/type input list in its user-defined order while duplicating a subgraph. */
export function sortCanvasEdgesForDuplication(edges: CanvasEdge[]): CanvasEdge[] {
  return edges
    .map((edge, index) => ({ edge, index }))
    .sort((left, right) => {
      const leftGroup = `${left.edge.target}\u0000${left.edge.data?.valueType ?? ''}`;
      const rightGroup = `${right.edge.target}\u0000${right.edge.data?.valueType ?? ''}`;
      const groupOrder = leftGroup.localeCompare(rightGroup);
      if (groupOrder !== 0) {
        return groupOrder;
      }
      const inputOrder = Number(left.edge.data?.inputOrder ?? 0)
        - Number(right.edge.data?.inputOrder ?? 0);
      return inputOrder || left.index - right.index;
    })
    .map(({ edge }) => edge);
}
