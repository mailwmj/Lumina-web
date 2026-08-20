export interface GenerationJobRecoverySnapshot {
  retry_count: number;
  next_retry_at?: number | null;
  requires_manual_requery: boolean;
  last_error?: string | null;
}

export type ImageGenerationRecoveryState = 'retrying' | 'attention_required';

const MINIMUM_RECOVERY_POLL_DELAY_MS = 250;
const MAXIMUM_RECOVERY_POLL_DELAY_MS = 30_000;

export function resolveImageGenerationRecoveryState(
  recovery?: GenerationJobRecoverySnapshot | null
): ImageGenerationRecoveryState | null {
  if (!recovery) {
    return null;
  }

  return recovery.requires_manual_requery ? 'attention_required' : 'retrying';
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
