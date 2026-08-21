import { describe, expect, it } from 'vitest';

import {
  resolveGenerationPollDelay,
  resolveImageGenerationRecoveryState,
  resolvePersistedImageGenerationRecovery,
  scheduleTransientImageGenerationPollRetry,
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

  it('backs off transient image polls before requiring a manual re-query', () => {
    const first = scheduleTransientImageGenerationPollRetry({
      taskId: 'provider-task-1',
      previousRetryCount: 0,
      nowMs: 1_000,
      error: 'Network timed out',
    });
    const final = scheduleTransientImageGenerationPollRetry({
      taskId: 'provider-task-1',
      previousRetryCount: 4,
      nowMs: 1_000,
      error: 'Network timed out',
    });

    expect(first).toMatchObject({
      retry_count: 1,
      requires_manual_requery: false,
      last_error: 'Network timed out',
    });
    expect(first.next_retry_at).toBeGreaterThan(1_000);
    expect(final).toEqual({
      retry_count: 5,
      requires_manual_requery: true,
      last_error: 'Network timed out',
    });
  });

  it('marks a refreshed browser-direct run without a stable handle as interrupted', () => {
    expect(resolvePersistedImageGenerationRecovery({
      jobId: 'web-image-local-task',
      taskHandle: null,
      isCurrentRuntimeSession: false,
    })).toBe('interrupted');
    expect(resolvePersistedImageGenerationRecovery({
      jobId: 'web-video-local-task',
      taskHandle: null,
      isCurrentRuntimeSession: false,
    })).toBe('interrupted');
    expect(resolvePersistedImageGenerationRecovery({
      jobId: 'web-image-local-task',
      taskHandle: null,
      isCurrentRuntimeSession: true,
    })).toBe('current_session_only');
    expect(resolvePersistedImageGenerationRecovery({
      jobId: 'web-image-local-task',
      taskHandle: {
        version: 1,
        kind: 'browser-direct',
        externalTaskId: 'provider-task-1',
        protocol: 'fal',
        baseUrl: 'https://queue.example.test/v1',
        model: 'fal/nano-banana-2',
      },
      isCurrentRuntimeSession: false,
    })).toBe('recoverable');
    expect(resolvePersistedImageGenerationRecovery({
      jobId: 'web-video-local-task',
      taskHandle: {
        version: 1,
        kind: 'browser-direct',
        externalTaskId: 'provider-video-task-1',
        protocol: 'volcengine-seedance',
        baseUrl: 'https://ark.example.test/api/v3',
        model: 'volcvideo/doubao-seedance-2-0-260128',
      },
      isCurrentRuntimeSession: false,
    })).toBe('recoverable');
  });
});
