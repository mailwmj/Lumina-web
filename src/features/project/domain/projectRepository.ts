export interface ProjectSummaryRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface ProjectRecord extends ProjectSummaryRecord {
  schemaVersion?: number;
  nodesJson: string;
  edgesJson: string;
  viewportJson: string;
  historyJson: string;
}

export interface ProjectRepository {
  /** Lists lightweight records without loading canvas payloads. */
  listSummaries(): Promise<ProjectSummaryRecord[]>;

  /** Loads one complete durable project snapshot. */
  get(projectId: string): Promise<ProjectRecord | null>;

  /** Atomically replaces the complete durable project snapshot. */
  saveSnapshot(record: ProjectRecord): Promise<void>;

  /** Updates only the independently batched viewport payload. */
  updateViewport(projectId: string, viewportJson: string): Promise<void>;

  /** Renames one project without loading its canvas payload. */
  rename(projectId: string, name: string, updatedAt: number): Promise<void>;

  /** Deletes one project and its Runtime-owned assets. */
  delete(projectId: string): Promise<void>;
}
