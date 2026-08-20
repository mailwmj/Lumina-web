import {
  NODE_TOOL_TYPES,
  type NodeToolType,
} from '@/features/canvas/domain/canvasNodes';
import type { ToolProcessor } from '@/features/canvas/application/ports';
import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import {
  readStoryboardAssetMetadata,
  writeBrowserDerivedImageAsset,
} from '@/features/assets/application/browserDerivedImage';
import {
  annotateBrowserImage,
  cropBrowserImage,
  splitBrowserImage,
} from './browserCanvasImage';

export interface BrowserImageToolProcessorDependencies {
  getAssetRepository(): AssetRepository | null;
  createFrameId(): string;
}

export function createBrowserImageToolProcessor(
  dependencies: BrowserImageToolProcessorDependencies,
): ToolProcessor {
  return {
    async process(toolType: NodeToolType, sourceImageUrl, options) {
      const projectId = typeof options.projectId === 'string' ? options.projectId.trim() : '';
      if (!projectId) {
        throw new Error('An active project is required before processing an image.');
      }
      const repository = dependencies.getAssetRepository();
      if (!repository) {
        throw new Error('Browser asset storage is unavailable.');
      }

      if (toolType === NODE_TOOL_TYPES.crop) {
        const rendered = await cropBrowserImage(sourceImageUrl, options);
        const written = await writeBrowserDerivedImageAsset({
          projectId,
          ...rendered,
        }, repository);
        return {
          outputAssetId: written.assetId,
          outputAspectRatio: written.aspectRatio,
        };
      }

      if (toolType === NODE_TOOL_TYPES.annotate) {
        const rendered = await annotateBrowserImage(sourceImageUrl, options);
        const written = await writeBrowserDerivedImageAsset({
          projectId,
          ...rendered,
        }, repository);
        return {
          outputAssetId: written.assetId,
          outputAspectRatio: written.aspectRatio,
        };
      }

      if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
        const sourceAssetId = typeof options.sourceAssetId === 'string' ? options.sourceAssetId : null;
        const metadata = sourceAssetId
          ? await readStoryboardAssetMetadata(sourceAssetId, repository)
          : null;
        const rows = Math.max(1, Math.floor(Number(options.rows ?? metadata?.gridRows ?? 3)));
        const cols = Math.max(1, Math.floor(Number(options.cols ?? metadata?.gridCols ?? 3)));
        const frames = await splitBrowserImage(
          sourceImageUrl,
          rows,
          cols,
          options.lineThicknessPercent,
          options.lineThickness,
        );
        const writtenFrames = await Promise.all(frames.map(async (frame, index) => {
          const written = await writeBrowserDerivedImageAsset({ projectId, ...frame }, repository);
          return {
            id: dependencies.createFrameId(),
            assetId: written.assetId,
            previewAssetId: null,
            imageUrl: null,
            previewImageUrl: null,
            aspectRatio: written.aspectRatio,
            note: metadata?.frameNotes[index]?.trim() ?? '',
            order: index,
          };
        }));
        return {
          storyboardFrames: writtenFrames,
          rows,
          cols,
          frameAspectRatio: writtenFrames[0]?.aspectRatio ?? '1:1',
          ...(metadata?.exportOptions ? { storyboardExportOptions: metadata.exportOptions } : {}),
        };
      }

      throw new Error(`Unsupported image tool: ${toolType}`);
    },
  };
}
