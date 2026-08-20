import {
  isExportImageNode,
  type CanvasWorkflowNode,
} from '@/features/canvas/domain/canvasNodes';
import { getNodeDefinition } from '@/features/canvas/domain/nodeRegistry';

export function canShowNodeActionToolbar(node: CanvasWorkflowNode): boolean {
  if (!getNodeDefinition(node.type).capabilities.toolbar) {
    return false;
  }

  return !(isExportImageNode(node) && node.data.isGenerating === true);
}
