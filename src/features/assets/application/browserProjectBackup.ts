import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import type { ProjectRecord, ProjectRepository } from '@/features/project/domain/projectRepository';
import {
  createLuminaProjectExport,
  type LuminaProjectExportOptions,
  type LuminaProjectExportProgress,
} from './luminaProjectExport';
import {
  outputBrowserFiles,
  type BrowserFileOutputEnvironment,
  type BrowserFileOutputResult,
  type BrowserFileSystemDirectoryHandle,
} from './browserFileOutput';

interface BrowserProjectOutputEnvironment extends BrowserFileOutputEnvironment {
  now?: () => number;
  intent?: 'download' | 'directory';
  directory?: BrowserFileSystemDirectoryHandle;
}

export interface BrowserProjectBackupService {
  download(
    projectIds: readonly string[],
    options?: {
      onProgress?: (progress: LuminaProjectExportProgress) => void;
      projectRecords?: readonly ProjectRecord[];
    },
  ): Promise<BrowserFileOutputResult>;
  saveToDirectory(
    projectIds: readonly string[],
    options?: {
      onProgress?: (progress: LuminaProjectExportProgress) => void;
      projectRecords?: readonly ProjectRecord[];
    },
  ): Promise<BrowserFileOutputResult>;
}

export async function outputLuminaProjectExport(
  options: LuminaProjectExportOptions,
  environment: BrowserProjectOutputEnvironment = {},
): Promise<BrowserFileOutputResult> {
  const {
    now = Date.now,
    intent = 'download',
    directory,
    ...fileOutputEnvironment
  } = environment;
  const exportedAt = options.exportedAt ?? now();
  const archive = await createLuminaProjectExport({ ...options, exportedAt });
  return await outputBrowserFiles({
    intent,
    directory,
    archiveFileName: `lumina-export-${exportedAt}.lumina`,
    files: [{
      id: 'lumina-project-export',
      fileName: `lumina-export-${exportedAt}.lumina`,
      blob: archive,
    }],
  }, fileOutputEnvironment);
}

export function createBrowserProjectBackupService(
  assetRepository: Pick<AssetRepository, 'read' | 'getMetadata'> | null,
  projectRepository: Pick<ProjectRepository, 'get'> | null,
): BrowserProjectBackupService | null {
  if (!assetRepository || !projectRepository) {
    return null;
  }
  return {
    download: (projectIds, options) => outputLuminaProjectExport({
      projectIds,
      projectRepository,
      assetRepository,
      onProgress: options?.onProgress,
      projectRecords: options?.projectRecords,
    }),
    saveToDirectory: (projectIds, options) => outputLuminaProjectExport({
      projectIds,
      projectRepository,
      assetRepository,
      onProgress: options?.onProgress,
      projectRecords: options?.projectRecords,
    }, { intent: 'directory' }),
  };
}
