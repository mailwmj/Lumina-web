export const INITIAL_PROJECT_REVISION = 'r0';

export interface ProjectOwnershipToken {
  ownerId: string;
  epoch: number;
}

export interface ProjectSnapshotWriteOptions {
  /** The revision read before constructing the snapshot. */
  expectedRevision?: string;
  /** Optional single-writer lease that must still be current at commit time. */
  ownership?: ProjectOwnershipToken;
}

export class StaleProjectRevisionError extends Error {
  readonly code = 'stale_revision' as const;

  constructor(
    readonly projectId: string,
    readonly expectedRevision: string,
    readonly actualRevision: string | null,
  ) {
    super(
      `Project ${projectId} changed from revision ${expectedRevision} `
      + `to ${actualRevision ?? 'missing'}.`,
    );
    this.name = 'StaleProjectRevisionError';
  }
}

export class StaleProjectOwnershipError extends Error {
  readonly code = 'stale_ownership' as const;

  constructor(readonly projectId: string) {
    super(`Project ${projectId} is owned by another tab.`);
    this.name = 'StaleProjectOwnershipError';
  }
}

export class ProjectReadOnlyError extends Error {
  readonly code = 'read_only' as const;

  constructor(readonly projectId: string) {
    super(`Project ${projectId} is read-only in this tab.`);
    this.name = 'ProjectReadOnlyError';
  }
}

export function nextProjectRevision(currentRevision?: string): string {
  if (!currentRevision) {
    return 'r1';
  }
  const numeric = /^r(\d+)$/.exec(currentRevision)?.[1];
  if (numeric) {
    return `r${Number(numeric) + 1}`;
  }
  return `r${hashRevision(currentRevision)}`;
}

function hashRevision(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
