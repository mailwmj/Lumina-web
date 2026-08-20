export interface ProjectSummaryRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface ProjectRecord extends ProjectSummaryRecord {
  nodesJson: string;
  edgesJson: string;
  viewportJson: string;
  historyJson: string;
}

export interface ProjectRepository {
  listSummaries(): Promise<ProjectSummaryRecord[]>;
  get(projectId: string): Promise<ProjectRecord | null>;
  /** Atomically replaces the complete serialized project snapshot. */
  saveSnapshot(record: ProjectRecord): Promise<void>;
  updateViewport(projectId: string, viewportJson: string): Promise<void>;
  rename(projectId: string, name: string, updatedAt: number): Promise<void>;
  delete(projectId: string): Promise<void>;
  createProjectDirs(projectId: string, projectName: string): Promise<void>;
}
