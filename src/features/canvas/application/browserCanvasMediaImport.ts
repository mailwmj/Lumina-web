import { importRuntimeBrowserImageAsset } from '@/features/assets/application/browserImageImport';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type CanvasNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
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
  ) => void;
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
  mediaProcessor,
}: BrowserCanvasMediaImportOptions): Promise<BrowserCanvasMediaImportFailure[]> {
  const failures: BrowserCanvasMediaImportFailure[] = [];
  let x = origin.x;

  for (const file of files) {
    try {
      if (file.type.startsWith('image/')) {
        const imported = await importRuntimeBrowserImageAsset(file, projectId);
        addNode(CANVAS_NODE_TYPES.upload, { x, y: origin.y }, {
          assetId: imported.assetId,
          previewAssetId: imported.previewAssetId,
          imageUrl: imported.imageUrl,
          previewImageUrl: imported.previewImageUrl,
          aspectRatio: imported.aspectRatio,
          sourceFileName: imported.sourceFileName,
          ...optionalDisplayName(imported.sourceFileName, useUploadFilenameAsNodeTitle),
        });
        x += DEFAULT_NODE_WIDTH + CANVAS_MEDIA_IMPORT_GAP;
        continue;
      }

      const isVideo = file.type.startsWith('video/');
      const imported = await (isVideo
        ? mediaProcessor.importVideo(file, projectId)
        : mediaProcessor.importAudio(file, projectId));
      const type = isVideo ? CANVAS_NODE_TYPES.videoUpload : CANVAS_NODE_TYPES.audioUpload;
      addNode(type, { x, y: origin.y }, {
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
      x += MEDIA_NODE_WIDTH + CANVAS_MEDIA_IMPORT_GAP;
    } catch (error) {
      failures.push({ fileName: file.name, error });
    }
  }

  return failures;
}
