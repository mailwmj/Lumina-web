import { describe, expect, it } from 'vitest';

import {
  resolveGenerationPollDelay,
  resolveImageGenerationRecoveryState,
} from './generationJobRecovery';

describe('image generation job recovery', () => {
  it('keeps a retryable network poll failure in the automatic recovery state', () => {
    const recovery = {
      retry_count: 1,
      next_retry_at: 4_500,
      requires_manual_requery: false,
      last_error: 'Network error: error sending request',
    };

    expect(resolveImageGenerationRecoveryState(recovery)).toBe('retrying');
    expect(resolveGenerationPollDelay(recovery, 1_000, 1_400)).toBe(3_500);
  });

  it('requires an explicit re-query after the automatic retry budget is exhausted', () => {
    const recovery = {
      retry_count: 5,
      next_retry_at: null,
      requires_manual_requery: true,
      last_error: 'Network error: timed out',
    };

    expect(resolveImageGenerationRecoveryState(recovery)).toBe('attention_required');
    expect(resolveGenerationPollDelay(recovery, 1_000, 1_400)).toBe(1_400);
  });
});
