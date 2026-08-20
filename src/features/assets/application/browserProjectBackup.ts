import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import type { ProjectRecord, ProjectRepository } from '@/features/project/domain/projectRepository';
import {
  createLuminaProjectExport,
  type LuminaProjectExportOptions,
  type LuminaProjectExportProgress,
} from './luminaProjectExport';

interface BackupDocument {
  createElement(tagName: string): HTMLAnchorElement;
  body: { appendChild(element: HTMLAnchorElement): void };
}

interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface BrowserProjectBackupService {
  download(
    projectIds: readonly string[],
    options?: {
      onProgress?: (progress: LuminaProjectExportProgress) => void;
      projectRecords?: readonly ProjectRecord[];
    },
  ): Promise<void>;
}

export async function downloadLuminaProjectExport(
  options: LuminaProjectExportOptions,
  {
    documentRef = document,
    objectUrlApi = URL,
    now = Date.now,
  }: {
    documentRef?: BackupDocument;
    objectUrlApi?: ObjectUrlApi;
    now?: () => number;
  } = {},
): Promise<void> {
  const exportedAt = options.exportedAt ?? now();
  const archive = await createLuminaProjectExport({ ...options, exportedAt });
  const objectUrl = objectUrlApi.createObjectURL(archive);
  const anchor = documentRef.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `lumina-export-${exportedAt}.lumina`;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  documentRef.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    objectUrlApi.revokeObjectURL(objectUrl);
  }
}

export function createBrowserProjectBackupService(
  assetRepository: Pick<AssetRepository, 'read' | 'getMetadata'> | null,
  projectRepository: Pick<ProjectRepository, 'get'> | null,
): BrowserProjectBackupService | null {
  if (!assetRepository || !projectRepository) {
    return null;
  }
  return {
    download: (projectIds, options) => downloadLuminaProjectExport({
      projectIds,
      projectRepository,
      assetRepository,
      onProgress: options?.onProgress,
      projectRecords: options?.projectRecords,
    }),
  };
}
