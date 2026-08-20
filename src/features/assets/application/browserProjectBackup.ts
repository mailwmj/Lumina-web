import type { AssetRepository } from '@/features/assets/domain/assetRepository';
import type { Project } from '@/stores/projectStore';

interface BrowserProjectBackupAsset {
  assetId: string;
  mimeType: string;
  sourceMetadata: Record<string, string | number | boolean | null>;
  dataUrl: string;
}

interface BrowserProjectBackupPayload {
  format: 'lumina-browser-project-backup';
  version: 1;
  exportedAt: number;
  project: Project;
  assets: BrowserProjectBackupAsset[];
}

interface BackupDocument {
  createElement(tagName: string): HTMLAnchorElement;
  body: { appendChild(element: HTMLAnchorElement): void };
}

interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface BrowserProjectBackupService {
  download(project: Project): Promise<void>;
}

function collectAssetIds(value: unknown, assetIds: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectAssetIds(item, assetIds));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if ((key === 'assetId' || key === 'previewAssetId') && typeof item === 'string' && item) {
      assetIds.add(item);
    }
    collectAssetIds(item, assetIds);
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

export async function createBrowserProjectBackup(
  project: Project,
  assetRepository: Pick<AssetRepository, 'read' | 'getMetadata'>,
  exportedAt = Date.now(),
): Promise<Blob> {
  const assetIds = new Set<string>();
  collectAssetIds(project, assetIds);
  const assets: BrowserProjectBackupAsset[] = [];

  for (const assetId of assetIds) {
    const [metadata, blob] = await Promise.all([
      assetRepository.getMetadata(assetId),
      assetRepository.read(assetId),
    ]);
    if (!metadata || metadata.projectId !== project.id || !blob) {
      continue;
    }
    assets.push({
      assetId: metadata.assetId,
      mimeType: metadata.mimeType,
      sourceMetadata: { ...metadata.sourceMetadata },
      dataUrl: await blobToDataUrl(blob),
    });
  }

  const payload: BrowserProjectBackupPayload = {
    format: 'lumina-browser-project-backup',
    version: 1,
    exportedAt,
    project,
    assets,
  };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export async function downloadBrowserProjectBackup(
  project: Project,
  assetRepository: Pick<AssetRepository, 'read' | 'getMetadata'>,
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
  const backup = await createBrowserProjectBackup(project, assetRepository, now());
  const objectUrl = objectUrlApi.createObjectURL(backup);
  const anchor = documentRef.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `${project.name || project.id}.lumina-backup.json`;
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
): BrowserProjectBackupService | null {
  if (!assetRepository) {
    return null;
  }
  return {
    download: (project) => downloadBrowserProjectBackup(project, assetRepository),
  };
}
