import {
  isExportImageNode,
  isExportVideoNode,
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

export interface DownloadableCanvasMedia {
  nodeId: string;
  kind: 'image' | 'video';
  assetId?: string;
  source?: string;
  suggestedFileName: string;
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
  return resolveDownloadableCanvasMedia(nodes)
    .filter((media) => media.kind === 'image')
    .map((media) => ({
      nodeId: media.nodeId,
      ...(media.assetId ? { assetId: media.assetId } : {}),
      ...(media.source ? { source: media.source } : {}),
      suggestedFileName: resolveImageFileStem(
        resolveImageFileName(media.source, `node-${media.nodeId}`)
      ),
    }));
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
