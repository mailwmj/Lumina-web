import type { TFunction } from 'i18next';

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isKnownBatchCropError(code: string): boolean {
  return code.includes('FILE_TOO_LARGE')
    || code.includes('IMAGE_DIMENSIONS_TOO_LARGE')
    || code.includes('UNSUPPORTED_FORMAT')
    || code.includes('SOURCE_NOT_FOUND')
    || code.includes('OUTPUT_DIRECTORY')
    || code.includes('OUTPUT_WRITE_FAILED')
    || code.includes('BATCH_CROP_');
}

export function batchCropErrorMessageKey(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('FILE_TOO_LARGE')) return 'batchCrop.error.fileTooLarge';
  if (code.includes('IMAGE_DIMENSIONS_TOO_LARGE')) return 'batchCrop.error.dimensionsTooLarge';
  if (code.includes('UNSUPPORTED_FORMAT')) return 'batchCrop.error.unsupportedFormat';
  if (code.includes('SOURCE_NOT_FOUND')) return 'batchCrop.error.sourceMissing';
  if (code.includes('OUTPUT_DIRECTORY')) return 'batchCrop.error.outputDirectory';
  if (code.includes('OUTPUT_WRITE_FAILED') || code.includes('BATCH_CROP_')) return 'batchCrop.error.writeFailed';
  return 'batchCrop.error.invalidImage';
}

export function resolveBatchCropErrorMessage(t: TFunction, error: unknown): string {
  const code = errorCode(error);
  return isKnownBatchCropError(code) ? t(batchCropErrorMessageKey(error)) : code;
}
