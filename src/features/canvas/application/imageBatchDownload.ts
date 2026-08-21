import {
  isExportImageNode,
  isExportVideoNode,
  isUploadNode,
  type CanvasWorkflowNode,
} from '@/features/canvas/domain/canvasNodes';
import { resolveImageFileName } from './imageMetadata';

export interface DownloadableCanvasMedia {
  nodeId: string;
  kind: 'image' | 'video';
  assetId?: string;
  source?: string;
  suggestedFileName: string;
}

export function resolveDownloadableCanvasMedia(
  nodes: readonly CanvasWorkflowNode[],
): DownloadableCanvasMedia[] {
  return nodes.flatMap<DownloadableCanvasMedia>((node) => {
    if (isUploadNode(node) || isExportImageNode(node)) {
      if (isExportImageNode(node) && node.data.isGenerating) {
        return [];
      }
      const assetId = node.data.assetId?.trim() || null;
      const source = node.data.imageUrl || node.data.previewImageUrl || null;
      if (!assetId && !source) {
        return [];
      }
      const uploadFileName = isUploadNode(node) ? node.data.sourceFileName?.trim() : '';
      return [{
        nodeId: node.id,
        kind: 'image' as const,
        ...(assetId ? { assetId } : {}),
        ...(source ? { source } : {}),
        suggestedFileName: uploadFileName || resolveImageFileName(source, `node-${node.id}`),
      }];
    }

    if (!isExportVideoNode(node) || node.data.isGenerating) {
      return [];
    }
    const assetId = node.data.assetId?.trim() || null;
    const source = node.data.videoUrl?.trim() || null;
    if (!assetId && !source) {
      return [];
    }
    return [{
      nodeId: node.id,
      kind: 'video' as const,
      ...(assetId ? { assetId } : {}),
      ...(source ? { source } : {}),
      suggestedFileName: resolveImageFileName(source, `node-${node.id}.mp4`),
    }];
  });
}
