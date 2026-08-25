export class CanvasGenerationAuthorityUnavailableError extends Error {
  constructor() {
    super('canvas_generation_authority_unavailable');
    this.name = 'CanvasGenerationAuthorityUnavailableError';
  }
}

interface CanvasGenerationMutationAuthority {
  sessionId: string;
  run<T>(operation: () => T | Promise<T>): Promise<T>;
}

type CanvasGenerationAuthorityRecord =
  | { status: 'active'; authority: CanvasGenerationMutationAuthority }
  | { status: 'invalid' };

const authoritiesByNodeId = new Map<string, CanvasGenerationAuthorityRecord>();

export function registerCanvasGenerationMutationAuthority(options: {
  sessionId: string;
  nodeIds: readonly string[];
  run<T>(operation: () => T | Promise<T>): Promise<T>;
}): void {
  const authority: CanvasGenerationMutationAuthority = {
    sessionId: options.sessionId,
    run: options.run,
  };
  for (const nodeId of options.nodeIds) {
    authoritiesByNodeId.set(nodeId, { status: 'active', authority });
  }
}

export function invalidateCanvasGenerationMutationAuthorities(sessionId: string): void {
  for (const [nodeId, record] of authoritiesByNodeId) {
    if (record.status === 'active' && record.authority.sessionId === sessionId) {
      authoritiesByNodeId.set(nodeId, { status: 'invalid' });
    }
  }
}

export function releaseCanvasGenerationMutationAuthority(nodeId: string): void {
  authoritiesByNodeId.delete(nodeId);
}

export async function runCanvasGenerationMutation<T>(
  nodeId: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const record = authoritiesByNodeId.get(nodeId);
  if (!record) {
    return await operation();
  }
  if (record.status === 'invalid') {
    throw new CanvasGenerationAuthorityUnavailableError();
  }
  return await record.authority.run(operation);
}

export function clearCanvasGenerationMutationAuthoritiesForTests(): void {
  authoritiesByNodeId.clear();
}
