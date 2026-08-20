import {
  DEFAULT_NODE_WIDTH,
  type UploadImageNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { importRuntimeBrowserImageAsset } from '@/features/assets/application/browserImageImport';

export interface BrowserCanvasImageImportOptions {
  files: readonly File[];
  projectId: string;
  origin: { x: number; y: number };
  useUploadFilenameAsNodeTitle: boolean;
  addUploadNode: (
    position: { x: number; y: number },
    data: Partial<UploadImageNodeData>,
  ) => void;
}

export interface BrowserCanvasImageImportFailure {
  fileName: string;
  error: unknown;
}

export async function importBrowserCanvasImageFiles({
  files,
  projectId,
  origin,
  useUploadFilenameAsNodeTitle,
  addUploadNode,
}: BrowserCanvasImageImportOptions): Promise<BrowserCanvasImageImportFailure[]> {
  const failures: BrowserCanvasImageImportFailure[] = [];
  let x = origin.x;

  for (const file of files) {
    try {
      const imported = await importRuntimeBrowserImageAsset(file, projectId);
      addUploadNode({ x, y: origin.y }, {
        assetId: imported.assetId,
        previewAssetId: imported.previewAssetId,
        imageUrl: imported.imageUrl,
        previewImageUrl: imported.previewImageUrl,
        aspectRatio: imported.aspectRatio,
        sourceFileName: imported.sourceFileName,
        ...(useUploadFilenameAsNodeTitle ? { displayName: imported.sourceFileName } : {}),
      });
      x += DEFAULT_NODE_WIDTH + 40;
    } catch (error) {
      failures.push({ fileName: file.name, error });
    }
  }

  return failures;
}
