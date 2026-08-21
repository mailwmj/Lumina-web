import { describe, expect, it } from 'vitest';

import {
  canRecoverImageGenerationJob,
  createBrowserGenerationJobHandle,
} from './generationJobHandle';

describe('persisted image generation task handles', () => {
  it('persists a stable browser-direct task handle without credentials', () => {
    const handle = createBrowserGenerationJobHandle({
      externalTaskId: 'provider-task-42',
      protocol: 'fal',
      baseUrl: 'https://queue.example.test/v1',
      model: 'fal/nano-banana-2',
      statusUrl: 'https://queue.example.test/tasks/provider-task-42',
      resultUrl: 'https://queue.example.test/tasks/provider-task-42/result',
    });

    expect(handle).toEqual({
      version: 1,
      kind: 'browser-direct',
      externalTaskId: 'provider-task-42',
      protocol: 'fal',
      baseUrl: 'https://queue.example.test/v1',
      model: 'fal/nano-banana-2',
      statusUrl: 'https://queue.example.test/tasks/provider-task-42',
      resultUrl: 'https://queue.example.test/tasks/provider-task-42/result',
    });
    expect(JSON.stringify(handle)).not.toMatch(/api[_-]?key|token|secret|bearer/i);
  });

  it('does not persist an unsafe callback URL and refuses refresh recovery without a stable handle', () => {
    const handle = createBrowserGenerationJobHandle({
      externalTaskId: 'provider-task-42',
      protocol: 'fal',
      baseUrl: 'https://queue.example.test/v1',
      model: 'fal/nano-banana-2',
      statusUrl: 'https://queue.example.test/tasks/provider-task-42?access_token=secret',
    });

    expect(handle?.statusUrl).toBeUndefined();
    expect(canRecoverImageGenerationJob({
      jobId: 'web-image-local-task',
      taskHandle: null,
      isDesktop: false,
    })).toBe(false);
    expect(canRecoverImageGenerationJob({
      jobId: 'web-image-local-task',
      taskHandle: handle,
      isDesktop: false,
    })).toBe(true);
    expect(canRecoverImageGenerationJob({
      jobId: 'web-video-local-task',
      taskHandle: null,
      isDesktop: false,
    })).toBe(false);
  });

  it.each([
    'https://queue.example.test/tasks/42?access_token=provider-secret',
    'task_id=provider-secret',
    'Bearer provider-secret',
  ])('rejects a credential-like upstream task ID before persistence: %s', (externalTaskId) => {
    const handle = createBrowserGenerationJobHandle({
      externalTaskId,
      protocol: 'fal',
      baseUrl: 'https://queue.example.test/v1',
      model: 'fal/nano-banana-2',
    });

    expect(handle).toBeNull();
    expect(JSON.stringify(handle)).not.toContain('provider-secret');
  });
});
