import { importRuntimeBrowserImageAsset } from '@/features/assets/application/browserImageImport';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type CanvasNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import type { AssetId } from '@/features/assets/domain/assetRepository';
import type { MediaProcessor } from '@/features/media/domain/mediaProcessor';

const MEDIA_NODE_WIDTH = 200;
const CANVAS_MEDIA_IMPORT_GAP = 40;

export interface BrowserCanvasMediaImportOptions {
  files: readonly File[];
  projectId: string;
  origin: { x: number; y: number };
  useUploadFilenameAsNodeTitle: boolean;
  addNode: (
    type: CanvasNodeType,
    position: { x: number; y: number },
    data: Partial<CanvasNodeData>,
  ) => string;
  removeNode: (nodeId: string) => void;
  persistProject: () => Promise<void>;
  deleteAsset: (assetId: AssetId) => Promise<void>;
  mediaProcessor: Pick<MediaProcessor, 'importAudio' | 'importVideo'>;
}

export interface BrowserCanvasMediaImportFailure {
  fileName: string;
  error: unknown;
}

function optionalDisplayName(fileName: string, useUploadFilenameAsNodeTitle: boolean) {
  return useUploadFilenameAsNodeTitle ? { displayName: fileName } : {};
}

export async function importBrowserCanvasMediaFiles({
  files,
  projectId,
  origin,
  useUploadFilenameAsNodeTitle,
  addNode,
  removeNode,
  persistProject,
  deleteAsset,
  mediaProcessor,
}: BrowserCanvasMediaImportOptions): Promise<BrowserCanvasMediaImportFailure[]> {
  const failures: BrowserCanvasMediaImportFailure[] = [];
  let x = origin.x;

  for (const file of files) {
    let addedNodeId: string | null = null;
    let importedAssetId: AssetId | null = null;
    try {
      if (file.type.startsWith('image/')) {
        const imported = await importRuntimeBrowserImageAsset(file, projectId);
        importedAssetId = imported.assetId;
        addedNodeId = addNode(CANVAS_NODE_TYPES.upload, { x, y: origin.y }, {
          assetId: imported.assetId,
          previewAssetId: imported.previewAssetId,
          imageUrl: imported.imageUrl,
          previewImageUrl: imported.previewImageUrl,
          aspectRatio: imported.aspectRatio,
          sourceFileName: imported.sourceFileName,
          ...optionalDisplayName(imported.sourceFileName, useUploadFilenameAsNodeTitle),
        });
        await persistProject();
        x += DEFAULT_NODE_WIDTH + CANVAS_MEDIA_IMPORT_GAP;
        continue;
      }

      const isVideo = file.type.startsWith('video/');
      const imported = await (isVideo
        ? mediaProcessor.importVideo(file, projectId)
        : mediaProcessor.importAudio(file, projectId));
      importedAssetId = imported.assetId;
      const type = isVideo ? CANVAS_NODE_TYPES.videoUpload : CANVAS_NODE_TYPES.audioUpload;
      addedNodeId = addNode(type, { x, y: origin.y }, {
        assetId: imported.assetId,
        ...(isVideo ? { videoUrl: imported.mediaUrl } : { audioUrl: imported.mediaUrl }),
        sourceFileName: imported.sourceFileName,
        sourceMimeType: imported.sourceMimeType,
        mimeType: imported.mimeType,
        durationMs: imported.durationMs,
        mediaWidth: imported.width,
        mediaHeight: imported.height,
        ...optionalDisplayName(imported.sourceFileName, useUploadFilenameAsNodeTitle),
      });
      await persistProject();
      x += MEDIA_NODE_WIDTH + CANVAS_MEDIA_IMPORT_GAP;
    } catch (error) {
      if (addedNodeId) {
        removeNode(addedNodeId);
      }
      if (importedAssetId) {
        await deleteAsset(importedAssetId).catch(() => undefined);
      }
      failures.push({ fileName: file.name, error });
    }
  }

  return failures;
}
