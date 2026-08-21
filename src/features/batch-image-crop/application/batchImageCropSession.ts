import { persistImageSource } from '@/commands/image';
import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import { getRuntimeAssetRepository } from '@/runtime/mediaRuntime';
import { runtime } from '@/runtime/runtime';
import {
  cleanupBrowserBatchCropResults,
  downloadBrowserBatchCropResult,
  writeBrowserBatchCropResult,
} from '../infrastructure/browserBatchImageCropAssets';
import {
  browserBatchImageCropGateway,
  type BrowserBatchImageCropGateway,
} from '../infrastructure/browserBatchImageCropGateway';
import {
  cleanupBatchCropCache,
  exportBatchCropImage,
  exportBatchFixedCanvas,
  prepareBatchCropImage,
  renderBatchFixedCanvas,
  suggestBatchCrop,
  type BatchCropSuggestion,
  type RenderedBatchFixedCanvas,
} from '../infrastructure/tauriBatchImageCropGateway';
import {
  createCenteredCrop,
  type BatchCropImageItem,
  type BatchCropTarget,
  type FixedCanvasDraft,
  type PreparedBatchCropImageData,
} from '../domain';

export type BatchCropInput = string | File;

export interface BatchCropExportResult {
  outputPath?: string;
  outputAssetId?: string;
}

export interface BatchAiFillResult {
  resultPath: string;
  resultAssetId?: string;
}

export interface BatchImageCropSession {
  readonly isBrowser: boolean;
  prepare(
    batchId: string,
    itemId: string,
    input: BatchCropInput,
    rotationDegrees: number,
    target: BatchCropTarget,
  ): Promise<PreparedBatchCropImageData>;
  suggest(item: BatchCropImageItem, target: BatchCropTarget): Promise<BatchCropSuggestion>;
  exportItem(
    batchId: string,
    item: BatchCropImageItem,
    target: BatchCropTarget,
    outputDirectory: string | null,
  ): Promise<BatchCropExportResult>;
  renderAiReferences(
    batchId: string,
    item: BatchCropImageItem,
    draft: FixedCanvasDraft,
    target: BatchCropTarget,
  ): Promise<RenderedBatchFixedCanvas>;
  completeAiFill(
    batchId: string,
    item: BatchCropImageItem,
    draft: FixedCanvasDraft,
    target: BatchCropTarget,
    generatedSource: string,
  ): Promise<BatchAiFillResult>;
  supportsLocalAiReferences(providerConfig: Record<string, string>): boolean;
  removeItem(itemId: string): void;
  releaseTransientResources(batchId: string): Promise<void>;
  cleanup(batchId: string): Promise<void>;
}

export interface BatchImageCropSessionDependencies {
  isDesktop?: () => boolean;
  browserGateway?: BrowserBatchImageCropGateway;
  getAssetRepository?: () => AssetRepository | null;
  prepareDesktop?: typeof prepareBatchCropImage;
  suggestDesktop?: typeof suggestBatchCrop;
  exportCropDesktop?: typeof exportBatchCropImage;
  exportFixedDesktop?: typeof exportBatchFixedCanvas;
  renderFixedDesktop?: typeof renderBatchFixedCanvas;
  persistDesktopSource?: typeof persistImageSource;
  cleanupDesktop?: typeof cleanupBatchCropCache;
  writeBrowserResult?: typeof writeBrowserBatchCropResult;
  downloadBrowserResult?: typeof downloadBrowserBatchCropResult;
  cleanupBrowserResults?: typeof cleanupBrowserBatchCropResults;
}

function fixedCanvasPayload(
  item: BatchCropImageItem,
  draft: FixedCanvasDraft,
  target: BatchCropTarget,
  resultSourcePath?: string,
) {
  return {
    sourcePath: item.sourcePath,
    fileName: item.fileName,
    targetWidth: target.width,
    targetHeight: target.height,
    rotationDegrees: item.rotationDegrees,
    transform: draft.transform,
    stretches: draft.stretches,
    ...(resultSourcePath ? { resultSourcePath } : {}),
  };
}

function acceptedResultSource(item: BatchCropImageItem): string | undefined {
  return item.fixedCanvas.ai.status === 'accepted'
    ? item.fixedCanvas.ai.resultPath
    : undefined;
}

function browserRepository(repository: AssetRepository | null): AssetRepository {
  if (!repository) throw new Error('BATCH_CROP_ASSET_STORAGE_UNAVAILABLE');
  return repository;
}

export function createBatchImageCropSession(
  dependencies: BatchImageCropSessionDependencies = {},
): BatchImageCropSession {
  const isDesktop = dependencies.isDesktop ?? runtime.isDesktop;
  const browserGateway = dependencies.browserGateway ?? browserBatchImageCropGateway;
  const getAssetRepository = dependencies.getAssetRepository ?? getRuntimeAssetRepository;
  const prepareDesktop = dependencies.prepareDesktop ?? prepareBatchCropImage;
  const suggestDesktop = dependencies.suggestDesktop ?? suggestBatchCrop;
  const exportCropDesktop = dependencies.exportCropDesktop ?? exportBatchCropImage;
  const exportFixedDesktop = dependencies.exportFixedDesktop ?? exportBatchFixedCanvas;
  const renderFixedDesktop = dependencies.renderFixedDesktop ?? renderBatchFixedCanvas;
  const persistDesktopSource = dependencies.persistDesktopSource ?? persistImageSource;
  const cleanupDesktop = dependencies.cleanupDesktop ?? cleanupBatchCropCache;
  const writeBrowserResult = dependencies.writeBrowserResult ?? writeBrowserBatchCropResult;
  const downloadBrowserResult = dependencies.downloadBrowserResult ?? downloadBrowserBatchCropResult;
  const cleanupBrowserResults = dependencies.cleanupBrowserResults ?? cleanupBrowserBatchCropResults;
  const browserFiles = new Map<string, File>();
  const releaseTransientResources = async (batchId: string): Promise<void> => {
    if (isDesktop()) {
      await cleanupDesktop(batchId);
      return;
    }
    browserGateway.cleanup(batchId);
    browserFiles.clear();
  };

  return {
    isBrowser: !isDesktop(),
    async prepare(batchId, itemId, input, rotationDegrees, target) {
      if (isDesktop()) {
        if (typeof input !== 'string') throw new Error('SOURCE_NOT_FOUND');
        return await prepareDesktop(batchId, input, rotationDegrees, target);
      }
      const file = input instanceof File ? input : browserFiles.get(itemId);
      if (!file) throw new Error('SOURCE_NOT_FOUND');
      browserFiles.set(itemId, file);
      return await browserGateway.prepare(batchId, file, rotationDegrees, target);
    },
    async suggest(item, target) {
      if (isDesktop()) {
        return await suggestDesktop(item.previewPath, target.width, target.height);
      }
      const crop = createCenteredCrop(item.width, item.height, target.width, target.height);
      return { crop, requiresReview: crop.width * crop.height < 0.8 };
    },
    async exportItem(batchId, item, target, outputDirectory) {
      if (isDesktop()) {
        if (!outputDirectory) throw new Error('OUTPUT_DIRECTORY');
        const result = item.compositionMode === 'fixed'
          ? await exportFixedDesktop(outputDirectory, fixedCanvasPayload(item, item.fixedCanvas, target, acceptedResultSource(item)))
          : await exportCropDesktop({
            sourcePath: item.sourcePath,
            fileName: item.fileName,
            outputDirectory,
            targetWidth: target.width,
            targetHeight: target.height,
            rotationDegrees: item.rotationDegrees,
            crop: item.crop!,
          });
        return { outputPath: result.outputPath };
      }

      const repository = browserRepository(getAssetRepository());
      const blob = item.compositionMode === 'fixed'
        ? await browserGateway.renderFixedCanvasBlob(fixedCanvasPayload(item, item.fixedCanvas, target, acceptedResultSource(item)))
        : await browserGateway.renderCrop({
          sourcePath: item.sourcePath,
          rotationDegrees: item.rotationDegrees,
          crop: item.crop!,
          target,
        });
      const result = await writeBrowserResult({
        batchId,
        sourceFileName: item.fileName,
        target,
        blob,
      }, repository);
      await downloadBrowserResult(result.assetId, result.fileName, repository);
      return { outputAssetId: result.assetId };
    },
    async renderAiReferences(batchId, item, draft, target) {
      const payload = fixedCanvasPayload(item, draft, target);
      return isDesktop()
        ? await renderFixedDesktop(batchId, payload)
        : await browserGateway.renderFixedCanvas(batchId, payload);
    },
    async completeAiFill(batchId, item, draft, target, generatedSource) {
      if (isDesktop()) {
        const result = await renderFixedDesktop(
          batchId,
          fixedCanvasPayload(item, draft, target, await persistDesktopSource(generatedSource)),
        );
        return { resultPath: result.renderedPath };
      }

      const repository = browserRepository(getAssetRepository());
      const rendered = await browserGateway.renderFixedCanvas(
        batchId,
        fixedCanvasPayload(item, draft, target, generatedSource),
      );
      const response = await fetch(rendered.renderedPath);
      if (!response.ok) throw new Error('BATCH_CROP_AI_RESULT_READ_FAILED');
      const result = await writeBrowserResult({
        batchId,
        sourceFileName: item.fileName,
        target,
        blob: await response.blob(),
      }, repository);
      const resultPath = await repository.hydrateObjectUrl(result.assetId);
      if (!resultPath) throw new Error('BATCH_CROP_AI_RESULT_DISPLAY_UNAVAILABLE');
      return { resultPath, resultAssetId: result.assetId };
    },
    supportsLocalAiReferences(providerConfig) {
      return isDesktop() || providerConfig.protocol !== 'fal';
    },
    removeItem(itemId) {
      browserFiles.delete(itemId);
    },
    releaseTransientResources,
    async cleanup(batchId) {
      await releaseTransientResources(batchId);
      if (isDesktop()) return;
      const repository = getAssetRepository();
      if (repository) await cleanupBrowserResults(batchId, repository);
    },
  };
}
