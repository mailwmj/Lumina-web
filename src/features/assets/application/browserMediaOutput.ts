import type { AssetId, AssetRepository } from '@/features/assets/domain/assetRepository';
import { getRuntimeAssetRepository } from '@/runtime/mediaRuntime';
import {
  outputBrowserFiles,
  resolveBrowserOutputFileName,
  type BrowserFileOutputEnvironment,
  type BrowserFileOutputFailure,
  type BrowserFileOutputResult,
  type BrowserFileSystemDirectoryHandle,
  type BrowserOutputFileInput,
} from './browserFileOutput';

export interface BrowserAssetOutputFileInput {
  id: string;
  assetId: AssetId;
  fileName: string;
}

export interface BrowserAssetFileOutputInput {
  intent: 'download' | 'directory';
  files: readonly BrowserAssetOutputFileInput[];
  archiveFileName: string;
  forceArchive?: boolean;
  directory?: BrowserFileSystemDirectoryHandle;
  repository: Pick<AssetRepository, 'read'>;
}

export interface BrowserUrlOutputFileInput {
  id: string;
  fileName: string;
  url: string;
}

export interface BrowserUrlFileResponse {
  ok: boolean;
  blob(): Promise<Blob>;
}

export interface BrowserUrlFileOutputInput {
  intent: 'download' | 'directory';
  files: readonly BrowserUrlOutputFileInput[];
  archiveFileName: string;
  forceArchive?: boolean;
  directory?: BrowserFileSystemDirectoryHandle;
  fetchFile?: (url: string) => Promise<BrowserUrlFileResponse>;
}

export interface BrowserMediaOutputFileInput {
  id: string;
  fileName: string;
  assetId?: AssetId;
  source?: string;
}

export interface BrowserMediaFileOutputInput {
  intent: 'download' | 'directory';
  files: readonly BrowserMediaOutputFileInput[];
  archiveFileName: string;
  forceArchive?: boolean;
  directory?: BrowserFileSystemDirectoryHandle;
}

export interface BrowserMediaOutputDependencies {
  repository?: Pick<AssetRepository, 'read'> | null;
  fetchFile?: (url: string) => Promise<BrowserUrlFileResponse>;
  environment?: BrowserFileOutputEnvironment;
}

function isFailure(
  result: BrowserOutputFileInput | BrowserFileOutputFailure,
): result is BrowserFileOutputFailure {
  return 'reason' in result;
}

function outputUnavailable(
  failures: BrowserFileOutputFailure[],
): BrowserFileOutputResult {
  return {
    disposition: 'unavailable',
    permission: 'not-requested',
    files: [],
    failures,
  };
}

async function readAssetFile(
  source: BrowserAssetOutputFileInput,
  repository: Pick<AssetRepository, 'read'> | null,
): Promise<BrowserOutputFileInput | BrowserFileOutputFailure> {
  if (!repository) {
    return { id: source.id, fileName: source.fileName, reason: 'asset_unavailable' };
  }
  try {
    const blob = await repository.read(source.assetId);
    if (!blob) {
      return { id: source.id, fileName: source.fileName, reason: 'asset_unavailable' };
    }
    return {
      id: source.id,
      fileName: resolveBrowserOutputFileName(source.fileName, blob.type),
      blob,
    };
  } catch {
    return { id: source.id, fileName: source.fileName, reason: 'asset_read_failed' };
  }
}

async function defaultFetchFile(url: string): Promise<BrowserUrlFileResponse> {
  if (typeof fetch === 'undefined') {
    throw new Error('Browser output requires fetch support.');
  }
  return await fetch(url);
}

async function readUrlFile(
  source: BrowserUrlOutputFileInput,
  fetchFile: (url: string) => Promise<BrowserUrlFileResponse>,
): Promise<BrowserOutputFileInput | BrowserFileOutputFailure> {
  try {
    const response = await fetchFile(source.url);
    if (!response.ok) {
      throw new Error('Output source could not be read.');
    }
    const blob = await response.blob();
    return {
      id: source.id,
      fileName: resolveBrowserOutputFileName(source.fileName, blob.type),
      blob,
    };
  } catch {
    return { id: source.id, fileName: source.fileName, reason: 'source_read_failed' };
  }
}

async function prepareBrowserMediaFiles(
  sources: readonly BrowserMediaOutputFileInput[],
  repository: Pick<AssetRepository, 'read'> | null,
  fetchFile: (url: string) => Promise<BrowserUrlFileResponse>,
): Promise<{ files: BrowserOutputFileInput[]; failures: BrowserFileOutputFailure[] }> {
  const files: BrowserOutputFileInput[] = [];
  const failures: BrowserFileOutputFailure[] = [];

  // Sequential reads preserve selection order across asset and source-backed media.
  for (const source of sources) {
    const assetId = source.assetId?.trim();
    if (assetId) {
      const asset = await readAssetFile({ ...source, assetId }, repository);
      if (!isFailure(asset)) {
        files.push(asset);
        continue;
      }
      const url = source.source?.trim();
      if (!url) {
        failures.push(asset);
        continue;
      }
      const fallback = await readUrlFile({ ...source, url }, fetchFile);
      if (!isFailure(fallback)) {
        files.push(fallback);
      } else {
        failures.push(fallback);
      }
      continue;
    }

    const url = source.source?.trim();
    if (!url) {
      failures.push({ id: source.id, fileName: source.fileName, reason: 'source_read_failed' });
      continue;
    }
    const file = await readUrlFile({ ...source, url }, fetchFile);
    if (isFailure(file)) {
      failures.push(file);
    } else {
      files.push(file);
    }
  }

  return { files, failures };
}

export async function outputBrowserMediaFiles(
  input: BrowserMediaFileOutputInput,
  dependencies: BrowserMediaOutputDependencies = {},
): Promise<BrowserFileOutputResult> {
  const repository = dependencies.repository === undefined
    ? getRuntimeAssetRepository()
    : dependencies.repository;
  const { files, failures } = await prepareBrowserMediaFiles(
    input.files,
    repository,
    dependencies.fetchFile ?? defaultFetchFile,
  );
  if (files.length === 0) {
    return outputUnavailable(failures);
  }

  const result = await outputBrowserFiles({
    intent: input.intent,
    archiveFileName: input.archiveFileName,
    forceArchive: input.forceArchive,
    directory: input.directory,
    files,
  }, dependencies.environment);
  return { ...result, failures: [...failures, ...result.failures] };
}

export async function outputBrowserAssetFiles(
  input: BrowserAssetFileOutputInput,
  environment: BrowserFileOutputEnvironment = {},
): Promise<BrowserFileOutputResult> {
  return await outputBrowserMediaFiles({
    intent: input.intent,
    archiveFileName: input.archiveFileName,
    forceArchive: input.forceArchive,
    directory: input.directory,
    files: input.files,
  }, { repository: input.repository, environment });
}

export async function outputBrowserUrlFiles(
  input: BrowserUrlFileOutputInput,
  environment: BrowserFileOutputEnvironment = {},
): Promise<BrowserFileOutputResult> {
  return await outputBrowserMediaFiles({
    intent: input.intent,
    archiveFileName: input.archiveFileName,
    forceArchive: input.forceArchive,
    directory: input.directory,
    files: input.files.map(({ url, ...file }) => ({ ...file, source: url })),
  }, { repository: null, fetchFile: input.fetchFile, environment });
}
