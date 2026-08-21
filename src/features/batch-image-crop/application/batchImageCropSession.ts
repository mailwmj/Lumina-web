import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import { getRuntimeAssetRepository } from '@/runtime/mediaRuntime';

import {
  browserBatchImageCropGateway,
  type BrowserBatchImageCropGateway,
} from '../infrastructure/browserBatchImageCropGateway';
import {
  writeBrowserBatchCropResult,
  type BrowserBatchCropResult,
} from '../infrastructure/browserBatchImageCropAssets';
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
  outputFileName?: string;
}

export interface BatchAiFillResult {
  resultPath: string;
  resultAssetId?: string;
}

export interface BatchImageCropSession {
  readonly isBrowser: true;
  prepare(
    batchId: string,
    itemId: string,
    input: BatchCropInput,
    rotationDegrees: number,
    target: BatchCropTarget,
  ): Promise<PreparedBatchCropImageData>;
  suggest(item: BatchCropImageItem, target: BatchCropTarget): Promise<{
    crop: NonNullable<BatchCropImageItem['crop']>;
    requiresReview: boolean;
  }>;
  exportItem(
    item: BatchCropImageItem,
    target: BatchCropTarget,
    outputDirectory: string | null,
  ): Promise<BatchCropExportResult>;
  renderAiReferences(
    batchId: string,
    item: BatchCropImageItem,
    draft: FixedCanvasDraft,
    target: BatchCropTarget,
  ): Promise<{ renderedPath: string; blankMaskPath: string }>;
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
  projectId?: string;
  browserGateway?: BrowserBatchImageCropGateway;
  getAssetRepository?: () => AssetRepository | null;
  writeBrowserResult?: typeof writeBrowserBatchCropResult;
  recordBrowserResult?: (result: BrowserBatchCropResult & { target: BatchCropTarget }) => Promise<void>;
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
  const browserGateway = dependencies.browserGateway ?? browserBatchImageCropGateway;
  const getAssetRepository = dependencies.getAssetRepository ?? getRuntimeAssetRepository;
  const writeBrowserResult = dependencies.writeBrowserResult ?? writeBrowserBatchCropResult;
  const browserFiles = new Map<string, File>();

  return {
    isBrowser: true,
    async prepare(batchId, itemId, input, rotationDegrees, target) {
      const file = input instanceof File ? input : browserFiles.get(itemId);
      if (!file) throw new Error('SOURCE_NOT_FOUND');
      browserFiles.set(itemId, file);
      return await browserGateway.prepare(batchId, file, rotationDegrees, target);
    },
    async suggest(item, target) {
      const crop = createCenteredCrop(item.width, item.height, target.width, target.height);
      return { crop, requiresReview: crop.width * crop.height < 0.8 };
    },
    async exportItem(item, target, outputDirectory) {
      void outputDirectory;
      if (!dependencies.projectId || !dependencies.recordBrowserResult) {
        throw new Error('BATCH_CROP_PROJECT_UNAVAILABLE');
      }
      const repository = browserRepository(getAssetRepository());
      const blob = item.compositionMode === 'fixed'
        ? await browserGateway.renderFixedCanvasBlob(
          fixedCanvasPayload(item, item.fixedCanvas, target, acceptedResultSource(item)),
        )
        : await browserGateway.renderCrop({
          sourcePath: item.sourcePath,
          rotationDegrees: item.rotationDegrees,
          crop: item.crop!,
          target,
        });
      const result = await writeBrowserResult({
        projectId: dependencies.projectId,
        sourceFileName: item.fileName,
        target,
        blob,
      }, repository);
      try {
        await dependencies.recordBrowserResult({ ...result, target });
      } catch (error) {
        await repository.delete(result.assetId).catch(() => undefined);
        throw error;
      }
      return { outputAssetId: result.assetId, outputFileName: result.fileName };
    },
    async renderAiReferences(batchId, item, draft, target) {
      return await browserGateway.renderFixedCanvas(
        batchId,
        fixedCanvasPayload(item, draft, target),
      );
    },
    async completeAiFill(batchId, item, draft, target, generatedSource) {
      const rendered = await browserGateway.renderFixedCanvas(
        batchId,
        fixedCanvasPayload(item, draft, target, generatedSource),
      );
      return { resultPath: rendered.renderedPath };
    },
    supportsLocalAiReferences(providerConfig) {
      return providerConfig.protocol !== 'fal';
    },
    removeItem(itemId) {
      browserFiles.delete(itemId);
    },
    async releaseTransientResources(batchId) {
      browserGateway.cleanup(batchId);
      browserFiles.clear();
    },
    async cleanup(batchId) {
      browserGateway.cleanup(batchId);
      browserFiles.clear();
    },
  };
}
