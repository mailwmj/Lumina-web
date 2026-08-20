import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import type {
  FixedCanvasStretchOperation,
  FixedCanvasTransform,
  NormalizedCropRect,
} from '../domain';

export interface PreparedBatchCropImage {
  sourcePath: string;
  fileName: string;
  fileSize: number;
  previewPath: string;
  thumbnailPath: string;
  width: number;
  height: number;
  suggestion?: BatchCropSuggestion;
}

export interface ExportBatchCropImagePayload {
  sourcePath: string;
  fileName: string;
  outputDirectory: string;
  targetWidth: number;
  targetHeight: number;
  rotationDegrees: number;
  crop: NormalizedCropRect;
}

export interface ExportedBatchCropImage {
  outputPath: string;
}

export interface FixedCanvasCompositionPayload {
  sourcePath: string;
  fileName: string;
  targetWidth: number;
  targetHeight: number;
  rotationDegrees: number;
  transform: FixedCanvasTransform;
  stretches: FixedCanvasStretchOperation[];
  resultSourcePath?: string;
}

export interface RenderedBatchFixedCanvas {
  renderedPath: string;
  blankMaskPath: string;
}

export interface BatchCropSuggestion {
  crop: NormalizedCropRect;
  requiresReview: boolean;
}

export function resolveBatchCropDisplayUrl(path: string): string {
  return isTauri() ? convertFileSrc(path) : path;
}

export async function prepareBatchCropImage(
  batchId: string,
  sourcePath: string,
  rotationDegrees: number,
  target?: { width: number; height: number }
): Promise<PreparedBatchCropImage> {
  return await invoke<PreparedBatchCropImage>('prepare_batch_crop_image', {
    batchId,
    sourcePath,
    rotationDegrees,
    targetWidth: target?.width,
    targetHeight: target?.height,
  });
}

export async function exportBatchCropImage(
  payload: ExportBatchCropImagePayload
): Promise<ExportedBatchCropImage> {
  return await invoke<ExportedBatchCropImage>('export_batch_crop_image', { payload });
}

export async function renderBatchFixedCanvas(
  batchId: string,
  payload: FixedCanvasCompositionPayload
): Promise<RenderedBatchFixedCanvas> {
  return await invoke<RenderedBatchFixedCanvas>('render_batch_fixed_canvas', { batchId, payload });
}

export async function exportBatchFixedCanvas(
  outputDirectory: string,
  payload: FixedCanvasCompositionPayload
): Promise<ExportedBatchCropImage> {
  return await invoke<ExportedBatchCropImage>('export_batch_fixed_canvas', {
    outputDirectory,
    payload,
  });
}

export async function suggestBatchCrop(
  previewPath: string,
  targetWidth: number,
  targetHeight: number
): Promise<BatchCropSuggestion> {
  return await invoke<BatchCropSuggestion>('suggest_batch_crop', {
    previewPath,
    targetWidth,
    targetHeight,
  });
}

export async function cleanupBatchCropCache(batchId: string): Promise<void> {
  if (!isTauri()) {
    return;
  }
  await invoke('cleanup_batch_crop_cache', { batchId });
}
