import {
  canRecoverImageGenerationJob,
  type PersistedGenerationJobHandle,
} from '../domain/generationJobHandle';

export interface GenerationJobRecoverySnapshot {
  retry_count: number;
  next_retry_at?: number | null;
  requires_manual_requery: boolean;
  last_error?: string | null;
}

export type ImageGenerationRecoveryState = 'retrying' | 'attention_required';
export type PersistedImageGenerationRecovery =
  | 'recoverable'
  | 'current_session_only'
  | 'interrupted';

const MINIMUM_RECOVERY_POLL_DELAY_MS = 250;
const MAXIMUM_RECOVERY_POLL_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES = 5;
const RECOVERY_RETRY_BASE_DELAY_MS = 1_000;

export function resolveImageGenerationRecoveryState(
  recovery?: GenerationJobRecoverySnapshot | null
): ImageGenerationRecoveryState | null {
  if (!recovery) {
    return null;
  }

  return recovery.requires_manual_requery ? 'attention_required' : 'retrying';
}

export function resolvePersistedImageGenerationRecovery({
  jobId,
  taskHandle,
  isDesktop,
  isCurrentRuntimeSession,
}: {
  jobId?: string | null;
  taskHandle?: PersistedGenerationJobHandle | null;
  isDesktop: boolean;
  isCurrentRuntimeSession: boolean;
}): PersistedImageGenerationRecovery {
  if (canRecoverImageGenerationJob({ jobId, taskHandle, isDesktop })) {
    return 'recoverable';
  }
  return isCurrentRuntimeSession ? 'current_session_only' : 'interrupted';
}

export function resolveGenerationPollDelay(
  recovery: GenerationJobRecoverySnapshot | null | undefined,
  nowMs: number,
  fallbackDelayMs: number
): number {
  const nextRetryAt = recovery?.next_retry_at;
  if (typeof nextRetryAt !== 'number' || !Number.isFinite(nextRetryAt)) {
    return fallbackDelayMs;
  }

  return Math.min(
    MAXIMUM_RECOVERY_POLL_DELAY_MS,
    Math.max(MINIMUM_RECOVERY_POLL_DELAY_MS, nextRetryAt - nowMs)
  );
}

function stableRetryJitter(taskId: string, retryCount: number): number {
  let hash = 0x811c9dc5;
  for (const value of `${taskId}:${retryCount}`) {
    hash ^= value.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function scheduleTransientImageGenerationPollRetry({
  taskId,
  previousRetryCount,
  nowMs,
  error,
}: {
  taskId: string;
  previousRetryCount: number;
  nowMs: number;
  error: string;
}): GenerationJobRecoverySnapshot {
  const retryCount = Math.max(0, Math.floor(previousRetryCount)) + 1;
  const requiresManualRequery = retryCount >= MAX_CONSECUTIVE_TRANSIENT_POLL_FAILURES;
  if (requiresManualRequery) {
    return {
      retry_count: retryCount,
      requires_manual_requery: true,
      last_error: error,
    };
  }

  const exponentialDelay = Math.min(
    MAXIMUM_RECOVERY_POLL_DELAY_MS,
    RECOVERY_RETRY_BASE_DELAY_MS * 2 ** Math.min(retryCount - 1, 5),
  );
  const jitter = stableRetryJitter(taskId, retryCount) % Math.max(1, Math.floor(exponentialDelay / 2));
  return {
    retry_count: retryCount,
    next_retry_at: nowMs + exponentialDelay + jitter,
    requires_manual_requery: false,
    last_error: error,
  };
}
