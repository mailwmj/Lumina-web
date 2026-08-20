import type { AssetMetadata } from '@/features/assets/domain/assetRepository';
import type { ProjectRecord } from '@/features/project/domain/projectRepository';

export interface StoredAssetRecord extends AssetMetadata {
  blob: Blob;
  stagingId?: string;
  stagingSourceId?: string;
}

export interface StoredHistoryRecord {
  projectId: string;
  historyJson: string;
}

export type StoredProjectRecord = Omit<ProjectRecord, 'historyJson' | 'recovery'>;

export function toStoredProjectRecord(record: ProjectRecord): StoredProjectRecord {
  const { historyJson: _historyJson, recovery: _recovery, ...project } = record;
  return { ...project, schemaVersion: record.schemaVersion ?? 1 };
}
