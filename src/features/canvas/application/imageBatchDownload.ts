import {
  isExportImageNode,
  isUploadNode,
  type CanvasWorkflowNode,
} from '@/features/canvas/domain/canvasNodes';
import { saveImageSourceToDirectory } from '@/commands/image';
import { resolveImageFileName, resolveImageFileStem } from './imageMetadata';
import type { MediaDisplayResolver } from '@/features/assets/application/mediaDisplayResolver';
import { runtimeMediaDisplayResolver } from '@/runtime/mediaRuntime';

export interface DownloadableCanvasImage {
  nodeId: string;
  assetId?: string;
  source?: string;
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

    const assetId = node.data.assetId?.trim() || null;
    const source = node.data.imageUrl || node.data.previewImageUrl || null;
    if (!assetId && !source) {
      return [];
    }

    return [{
      nodeId: node.id,
      ...(assetId ? { assetId } : {}),
      ...(source ? { source } : {}),
      suggestedFileName: resolveImageFileStem(
        resolveImageFileName(source, `node-${node.id}`)
      ),
    }];
  });
}

export async function saveCanvasImagesToDirectory(
  images: readonly DownloadableCanvasImage[],
  targetDir: string,
  saveImageToDirectory: SaveImageToDirectory = saveImageSourceToDirectory,
  resolver: MediaDisplayResolver = runtimeMediaDisplayResolver,
): Promise<ImageBatchDownloadResult> {
  const savedPaths: string[] = [];
  const failedNodeIds: string[] = [];

  // Save in selection order. This avoids racing duplicate-source downloads;
  // the backend also guarantees a unique path for each file.
  for (const image of images) {
    let release: () => void = () => undefined;
    try {
      const resolved = await resolver.resolve({
        kind: 'image',
        assetId: image.assetId,
        legacyUrl: image.source,
      });
      if (!resolved) {
        throw new Error('Image source is unavailable');
      }
      release = resolved.release;
      savedPaths.push(await saveImageToDirectory(
        resolved.url,
        targetDir,
        image.suggestedFileName
      ));
    } catch {
      failedNodeIds.push(image.nodeId);
    } finally {
      release();
    }
  }

  return { savedPaths, failedNodeIds };
}
