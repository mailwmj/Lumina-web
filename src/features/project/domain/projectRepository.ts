import type { ProjectSnapshotWriteOptions } from './projectRevision';

export interface ProjectSummaryRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface ProjectRecord extends ProjectSummaryRecord {
  /** Monotonic project revision used for optimistic concurrency. */
  revision?: string;
  /** Versioned public Web project document schema. */
  schemaVersion?: number;
  /** Read-time recovery state for a project whose schema cannot be migrated. */
  recovery?: ProjectRecovery;
  nodesJson: string;
  edgesJson: string;
  viewportJson: string;
  historyJson: string;
}

export interface ProjectRecovery {
  reason: 'unsupported_schema' | 'migration_failed';
}

export interface ProjectWriteAccess {
  role: 'writer' | 'readonly' | 'released';
  ownerId: string;
  epoch: number;
}

export interface ProjectRepository {
  listSummaries(): Promise<ProjectSummaryRecord[]>;
  get(projectId: string): Promise<ProjectRecord | null>;
  /** Atomically replaces the complete serialized project snapshot. */
  saveSnapshot(record: ProjectRecord, options?: ProjectSnapshotWriteOptions): Promise<void>;
  updateViewport(projectId: string, viewportJson: string): Promise<void>;
  rename(projectId: string, name: string, updatedAt: number): Promise<void>;
  delete(projectId: string): Promise<void>;
  createProjectDirs(projectId: string, projectName: string): Promise<void>;
  /** Web-only multi-tab ownership extension. Absent adapters are always writable. */
  getWriteAccess?(projectId: string): Promise<ProjectWriteAccess>;
  takeOverWriteAccess?(projectId: string): Promise<ProjectWriteAccess>;
  watchWriteAccess?(
    projectId: string,
    listener: (access: ProjectWriteAccess) => void,
  ): () => void;
}
