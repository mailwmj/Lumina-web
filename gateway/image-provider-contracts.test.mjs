import { describe, expect, it } from 'vitest';

import {
  isSafeImageProviderTaskId,
  parseImageProviderSubmitReceipt,
} from './image-provider-contracts.mjs';

describe('image provider submit receipt contracts', () => {
  it('accepts AI Media documented top-level receipts with URL-safe opaque task IDs', () => {
    const taskId = 'imgtask_9e05a521-3ccf-4a38-b66b-06dd25c8bfb7';
    const receipt = parseImageProviderSubmitReceipt('ai-media', {
      id: taskId,
      task_id: taskId,
      object: 'image.task',
      status: 'queued',
      poll_url: `/v1/images/tasks/${taskId}`,
      status_url: `/v1/images/tasks/${taskId}?view=summary`,
      result_url: `/v1/images/tasks/${taskId}`,
      assets: [],
    }, 'https://api.ai-media.vip/v1');

    expect(receipt).toMatchObject({
      taskId,
      pollPath: `/images/tasks/${taskId}?view=summary`,
      diagnostic: {
        provider: 'ai-media',
        topLevelFields: [
          'assets', 'id', 'object', 'poll_url', 'result_url', 'status', 'status_url', 'task_id',
        ],
        nestedFields: [],
        candidateField: 'task_id',
        candidateIdLength: taskId.length,
        candidateIdPrefix: 'imgtask',
        candidateIdCharacters: 'opaque-safe',
      },
    });
    expect(isSafeImageProviderTaskId('ai-media', taskId)).toBe(true);
  });

  it('keeps Chaomo task parsing on its documented top-level opaque-ID contract', () => {
    const taskId = 'chaomo-task-kM7pQ2vX9nR4tL8cW5yH3sD6';
    const receipt = parseImageProviderSubmitReceipt('chaomo', {
      task_id: taskId,
      data: { id: 'nested-task-must-not-win' },
      status_url: '/v1/images/tasks/not-the-chaomo-contract',
    }, 'https://www.chaomoapi.com/v1');

    expect(receipt.taskId).toBe(taskId);
    expect(receipt.pollPath).toBeNull();
    expect(receipt.diagnostic.candidateField).toBe('task_id');
    expect(receipt.diagnostic.nestedFields).toEqual(['data.id']);
    expect(isSafeImageProviderTaskId('chaomo', taskId)).toBe(true);
  });

  it('does not accept undocumented AI Media nesting or credential-shaped identifiers', () => {
    expect(parseImageProviderSubmitReceipt('ai-media', {
      data: { task_id: 'imgtask_9e05a521-3ccf-4a38-b66b-06dd25c8bfb7' },
    }, 'https://api.ai-media.vip/v1').taskId).toBeNull();
    expect(isSafeImageProviderTaskId(
      'ai-media',
      'imgtask_token.secret-value-0123456789',
    )).toBe(false);
    expect(isSafeImageProviderTaskId(
      'chaomo',
      'task-sk-proj-AbCdEfGhIjKlMnOp',
    )).toBe(false);
  });

  it('describes receipt structure without retaining values or sensitive field names', () => {
    const taskId = 'imgtask_9e05a521-3ccf-4a38-b66b-06dd25c8bfb7';
    const secretPrompt = 'SECRET_PROMPT_VALUE';
    const secretKey = 'sk-secret-value';
    const secretUrl = 'https://provider.example/task?api_key=secret';
    const receipt = parseImageProviderSubmitReceipt('ai-media', {
      task_id: taskId,
      prompt: secretPrompt,
      api_key: secretKey,
      status_url: secretUrl,
      data: { status: 'queued', authorization: secretKey },
    }, 'https://api.ai-media.vip/v1');
    const serialized = JSON.stringify(receipt.diagnostic);

    expect(serialized).not.toContain(taskId);
    expect(serialized).not.toContain(secretPrompt);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain(secretUrl);
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('authorization');
  });
});
