import type { TFunction } from 'i18next';

import { LuminaProjectExportError, type LuminaProjectExportErrorCode } from '../application/luminaProjectExport';

const ERROR_KEYS: Record<LuminaProjectExportErrorCode, string> = {
  archive_limit: 'common.exportErrorTooLarge',
  archive_file_limit: 'common.exportErrorTooLarge',
  archive_file_name_limit: 'common.exportErrorInvalidData',
  invalid_project_data: 'common.exportErrorInvalidData',
  hash_unavailable: 'common.exportErrorUnsupported',
  no_projects: 'common.exportErrorNoProject',
  project_unavailable: 'common.exportErrorMissingData',
  asset_unavailable: 'common.exportErrorMissingData',
  asset_changed: 'common.exportErrorChangedData',
};

export function resolveLuminaProjectExportError(error: unknown, t: TFunction): string {
  if (error instanceof LuminaProjectExportError) {
    return t(ERROR_KEYS[error.code]);
  }
  return t('common.exportErrorUnknown');
}
