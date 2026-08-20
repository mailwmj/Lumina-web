import {
  isExportImageNode,
  isUploadNode,
  type CanvasWorkflowNode,
} from '@/features/canvas/domain/canvasNodes';
import { saveImageSourceToDirectory } from '@/commands/image';
import { resolveImageFileName, resolveImageFileStem } from './imageMetadata';

export interface DownloadableCanvasImage {
  nodeId: string;
  source: string;
  suggestedFileName: string;
}

export interface ImageBatchDownloadResult {
  savedPaths: string[];
  failedNodeIds: string[];
}

type SaveImageToDirectory = (
  source: string,
  targetDir: string,
  suggestedFileName?: string
) => Promise<string>;

/**
 * Mirrors the image types supported by the single-node download action. An
 * image-generation node is deliberately excluded: it is a configuration
 * node, while uploads and completed export nodes are concrete image assets.
 */
export function resolveDownloadableCanvasImages(
  nodes: readonly CanvasWorkflowNode[]
): DownloadableCanvasImage[] {
  return nodes.flatMap((node) => {
    if (!isUploadNode(node) && !isExportImageNode(node)) {
      return [];
    }
    if (isExportImageNode(node) && node.data.isGenerating) {
      return [];
    }

    const source = node.data.imageUrl || node.data.previewImageUrl || null;
    if (!source) {
      return [];
    }

    return [{
      nodeId: node.id,
      source,
      suggestedFileName: resolveImageFileStem(
        resolveImageFileName(source, `node-${node.id}`)
      ),
    }];
  });
}

export async function saveCanvasImagesToDirectory(
  images: readonly DownloadableCanvasImage[],
  targetDir: string,
  saveImageToDirectory: SaveImageToDirectory = saveImageSourceToDirectory
): Promise<ImageBatchDownloadResult> {
  const savedPaths: string[] = [];
  const failedNodeIds: string[] = [];

  // Save in selection order. This avoids racing duplicate-source downloads;
  // the backend also guarantees a unique path for each file.
  for (const image of images) {
    try {
      savedPaths.push(await saveImageToDirectory(
        image.source,
        targetDir,
        image.suggestedFileName
      ));
    } catch {
      failedNodeIds.push(image.nodeId);
    }
  }

  return { savedPaths, failedNodeIds };
}
