import type { CanvasSnapshot } from './protocol.js';

type CanvasNodeProgressStatus =
  | 'ready'
  | 'generating'
  | 'failed'
  | 'attention_required'
  | 'empty'
  | 'missing';

export interface CanvasNodeProgressResult {
  projectId: string;
  revision: string;
  changed: boolean;
  timedOut: boolean;
  summary: {
    total: number;
    ready: number;
    generating: number;
    failed: number;
    attentionRequired: number;
    empty: number;
    missing: number;
    terminal: number;
    allTerminal: boolean;
  };
  nodes: Array<{
    nodeId: string;
    nodeType: string | null;
    status: CanvasNodeProgressStatus;
    generationError: string | null;
    generationRecoveryState: string | null;
  }>;
}

export function buildNodeProgress(
  snapshot: CanvasSnapshot,
  nodeIds: string[],
  changed: boolean,
  timedOut: boolean
): CanvasNodeProgressResult {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const nodes = nodeIds.map((nodeId) => {
    const node = nodeById.get(nodeId);
    if (!node) {
      return {
        nodeId,
        nodeType: null,
        status: 'missing' as const,
        generationError: null,
        generationRecoveryState: null,
      };
    }
    const data = readRecord(node.data);
    const generationError = readNonEmptyString(data.generationError);
    const generationRecoveryState = readNonEmptyString(data.generationRecoveryState);
    return {
      nodeId,
      nodeType: typeof node.type === 'string' ? node.type : null,
      status: resolveNodeProgressStatus(data, generationError, generationRecoveryState),
      generationError,
      generationRecoveryState,
    };
  });
  const count = (status: CanvasNodeProgressStatus) => (
    nodes.filter((node) => node.status === status).length
  );
  const ready = count('ready');
  const failed = count('failed');
  const attentionRequired = count('attention_required');
  const terminal = ready + failed + attentionRequired;

  return {
    projectId: snapshot.projectId,
    revision: snapshot.revision,
    changed,
    timedOut,
    summary: {
      total: nodes.length,
      ready,
      generating: count('generating'),
      failed,
      attentionRequired,
      empty: count('empty'),
      missing: count('missing'),
      terminal,
      allTerminal: terminal === nodes.length,
    },
    nodes,
  };
}

export function fingerprintNodeProgress(result: CanvasNodeProgressResult): string {
  return JSON.stringify(result.nodes);
}

function resolveNodeProgressStatus(
  data: Record<string, unknown>,
  generationError: string | null,
  generationRecoveryState: string | null
): CanvasNodeProgressStatus {
  if (data.isGenerating === true) {
    return generationRecoveryState === 'attention_required'
      ? 'attention_required'
      : 'generating';
  }
  if (generationError) {
    return 'failed';
  }
  if (generationRecoveryState === 'attention_required') {
    return 'attention_required';
  }
  if (readNonEmptyString(data.generationBatchId)) {
    return 'ready';
  }
  return 'empty';
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
