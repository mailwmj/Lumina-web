/* global AbortController, Buffer, process */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createTaskStateStore } from './task-state.mjs';

function cleanupState(file) {
  try { unlinkSync(file); } catch { /* test cleanup is best effort */ }
  try { rmSync(`${file}.${process.pid}.tmp`, { recursive: true, force: true }); } catch { /* test cleanup is best effort */ }
  try { rmSync(`${file}.results`, { recursive: true, force: true }); } catch { /* test cleanup is best effort */ }
}

describe('gateway task state', () => {
  it('persists only safe task mapping fields', () => {
    const file = join(tmpdir(), `lumina-gateway-state-${process.pid}-${Date.now()}.json`);
    const store = createTaskStateStore({ file });
    store.tasks.set('job-safe', {
      id: 'job-safe',
      provider: 'ai-media',
      status: 'running',
      upstreamTaskId: 'provider-0123456789abcdef',
      upstreamPollPath: '/v1/images/tasks/provider-0123456789abcdef?view=summary',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 200,
      errorCode: 'provider_rejected',
      providerHttpStatus: 429,
      recovery: {
        retry_count: 2,
        next_retry_at: 1_234,
        requires_manual_requery: false,
        last_error: 'The image provider is temporarily unavailable.',
      },
      prompt: 'prompt-secret',
      authorization: 'Bearer api-secret',
      response: 'provider-response-secret',
      bytes: Buffer.from('media-secret'),
    });

    try {
      store.save();
      const persisted = readFileSync(file, 'utf8');
      expect(JSON.parse(persisted)).toEqual([{
        id: 'job-safe',
        provider: 'ai-media',
        status: 'running',
        upstreamTaskId: 'provider-0123456789abcdef',
        upstreamPollPath: '/v1/images/tasks/provider-0123456789abcdef?view=summary',
        sourceId: 'a'.repeat(64),
        sessionBinding: 'b'.repeat(64),
        createdAt: 100,
        updatedAt: 200,
        errorCode: 'provider_rejected',
        providerHttpStatus: 429,
        recovery: {
          retry_count: 2,
          next_retry_at: 1_234,
          requires_manual_requery: false,
          last_error: 'The image provider is temporarily unavailable.',
        },
      }]);
      expect(persisted).not.toContain('prompt-secret');
      expect(persisted).not.toContain('api-secret');
      expect(persisted).not.toContain('provider-response-secret');
      expect(persisted).not.toContain('media-secret');
    } finally {
      try { unlinkSync(file); } catch { /* test cleanup is best effort */ }
    }
  });

  it('persists documented AI Media async task IDs without accepting malformed variants', () => {
    const file = join(tmpdir(), `lumina-gateway-ai-media-id-${process.pid}-${Date.now()}.json`);
    const store = createTaskStateStore({ file });
    const task = (id, upstreamTaskId) => ({
      id,
      provider: 'ai-media',
      status: 'running',
      upstreamTaskId,
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 200,
    });
    store.tasks.set('job-documented-ai-media-id', task(
      'job-documented-ai-media-id',
      'imgtask_9e05a521-3ccf-4a38-b66b-06dd25c8bfb7',
    ));
    store.tasks.set('job-short-ai-media-id', task('job-short-ai-media-id', 'imgtask_short'));
    store.tasks.set('job-path-ai-media-id', task(
      'job-path-ai-media-id',
      'imgtask_0123456789abcde/',
    ));

    try {
      store.save();
      const restored = createTaskStateStore({ file });
      expect(restored.tasks.get('job-documented-ai-media-id')?.upstreamTaskId)
        .toBe('imgtask_9e05a521-3ccf-4a38-b66b-06dd25c8bfb7');
      expect(restored.tasks.get('job-short-ai-media-id')?.upstreamTaskId).toBeUndefined();
      expect(restored.tasks.get('job-path-ai-media-id')?.upstreamTaskId).toBeUndefined();
    } finally {
      cleanupState(file);
    }
  });

  it('does not persist credential-shaped upstream task IDs', () => {
    const file = join(tmpdir(), `lumina-gateway-credential-id-${process.pid}-${Date.now()}.json`);
    const store = createTaskStateStore({ file });
    const unsafeTaskIds = ['sk-proj-provider-secret', 'task-sk-proj-AbCdEfGhIjKlMnOp'];
    for (const [index, upstreamTaskId] of unsafeTaskIds.entries()) {
      store.tasks.set(`job-credential-shaped-id-${index}`, {
        id: `job-credential-shaped-id-${index}`,
        provider: 'ai-media',
        status: 'running',
        upstreamTaskId,
        sourceId: 'a'.repeat(64),
        sessionBinding: 'b'.repeat(64),
        createdAt: 100,
        updatedAt: 200,
      });
    }

    try {
      store.save();
      const persisted = readFileSync(file, 'utf8');
      expect(JSON.parse(persisted)).toEqual(unsafeTaskIds.map((_upstreamTaskId, index) => ({
        id: `job-credential-shaped-id-${index}`,
        provider: 'ai-media',
        status: 'running',
        sourceId: 'a'.repeat(64),
        sessionBinding: 'b'.repeat(64),
        createdAt: 100,
        updatedAt: 200,
      })));
      for (const upstreamTaskId of unsafeTaskIds) {
        expect(persisted).not.toContain(upstreamTaskId);
      }
      const reloaded = createTaskStateStore({ file });
      for (const task of reloaded.tasks.values()) {
        expect(task.upstreamTaskId).toBeUndefined();
      }
    } finally {
      try { unlinkSync(file); } catch { /* test cleanup is best effort */ }
    }
  });

  it('persists only credential-free provider poll paths and restores them after reopen', () => {
    const file = join(tmpdir(), `lumina-gateway-poll-path-${process.pid}-${Date.now()}.json`);
    const store = createTaskStateStore({ file });
    const task = (id, upstreamPollPath) => ({
      id,
      provider: 'ai-media',
      status: 'running',
      upstreamTaskId: `task-${id.slice(-16).padStart(16, '0')}`,
      upstreamPollPath,
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 200,
    });
    store.tasks.set('job-0000000000000001', task(
      'job-0000000000000001',
      '/v1/tasks/task-0000000000000001?view=summary',
    ));
    store.tasks.set('job-0000000000000002', task(
      'job-0000000000000002',
      '/v1/tasks/task-0000000000000002?access_token=poll-secret',
    ));
    store.tasks.set('job-0000000000000003', task(
      'job-0000000000000003',
      'https://provider.example/v1/tasks/task-0000000000000003',
    ));

    try {
      store.save();
      const persisted = readFileSync(file, 'utf8');
      expect(persisted).not.toContain('poll-secret');
      const reloaded = createTaskStateStore({ file });
      expect(reloaded.tasks.get('job-0000000000000001')?.upstreamPollPath)
        .toBe('/v1/tasks/task-0000000000000001?view=summary');
      expect(reloaded.tasks.get('job-0000000000000002')?.upstreamPollPath).toBeUndefined();
      expect(reloaded.tasks.get('job-0000000000000003')?.upstreamPollPath).toBeUndefined();
    } finally {
      cleanupState(file);
    }
  });

  it('restores a safe Chaomo task mapping without persisting credentials', () => {
    const file = join(tmpdir(), `lumina-gateway-chaomo-state-${process.pid}-${Date.now()}.json`);
    const store = createTaskStateStore({ file });
    store.tasks.set('job-chaomo', {
      id: 'job-chaomo',
      provider: 'chaomo',
      status: 'running',
      upstreamTaskId: 'task-0123456789abcdef',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 200,
      authorization: 'Bearer chaomo-secret',
    });

    try {
      store.save();
      const persisted = readFileSync(file, 'utf8');
      expect(persisted).not.toContain('chaomo-secret');
      expect([...createTaskStateStore({ file }).tasks.values()]).toEqual([
        expect.objectContaining({
          id: 'job-chaomo',
          provider: 'chaomo',
          upstreamTaskId: 'task-0123456789abcdef',
        }),
      ]);
    } finally {
      cleanupState(file);
    }
  });

  it('restores a custom OpenAI provider task without persisting its endpoint or key', () => {
    const file = join(tmpdir(), `lumina-gateway-custom-state-${process.pid}-${Date.now()}.json`);
    const store = createTaskStateStore({ file });
    store.tasks.set('job-custom', {
      id: 'job-custom',
      provider: 'custom-openai:tenant-a',
      status: 'running',
      upstreamTaskId: 'provider-0123456789abcdef',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 200,
      baseUrl: 'https://custom.example/v1',
      authorization: 'Bearer custom-secret',
    });

    try {
      store.save();
      const persisted = readFileSync(file, 'utf8');
      expect(persisted).not.toContain('custom.example');
      expect(persisted).not.toContain('custom-secret');
      expect([...createTaskStateStore({ file }).tasks.values()]).toEqual([
        expect.objectContaining({
          id: 'job-custom',
          provider: 'custom-openai:tenant-a',
          upstreamTaskId: 'provider-0123456789abcdef',
        }),
      ]);
    } finally {
      try { unlinkSync(file); } catch { /* test cleanup is best effort */ }
    }
  });

  it('clears confirmed results after one hour and unconfirmed results after 24 hours', () => {
    const file = join(tmpdir(), `lumina-gateway-result-ttl-${process.pid}-${Date.now()}.json`);
    let now = 10_000;
    const store = createTaskStateStore({ file, now: () => now });
    const baseTask = (id) => ({
      id,
      provider: 'ai-media',
      status: 'succeeded',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 10_000,
      updatedAt: 10_000,
      terminalAt: 10_000,
      resultAvailableAt: 10_000,
      contentType: 'image/png',
      bytes: Buffer.from('result'),
    });
    const confirmed = baseTask('job-confirmed');
    confirmed.resultConfirmedAt = now;
    const unconfirmed = baseTask('job-unconfirmed');
    store.tasks.set(confirmed.id, confirmed);
    store.tasks.set(unconfirmed.id, unconfirmed);

    try {
      now += 60 * 60 * 1000 + 1;
      expect(store.prune()).toBe(true);
      expect(store.tasks.get(confirmed.id)?.bytes).toBeUndefined();
      expect(store.tasks.get(unconfirmed.id)?.bytes).toEqual(Buffer.from('result'));

      now = 10_000 + 24 * 60 * 60 * 1000 + 1;
      expect(store.prune()).toBe(true);
      expect(store.tasks.has(unconfirmed.id)).toBe(false);
    } finally {
      try { unlinkSync(file); } catch { /* test cleanup is best effort */ }
    }
  });

  it('enforces the seven-day active and 24-hour terminal mapping caps', () => {
    const file = join(tmpdir(), `lumina-gateway-mapping-ttl-${process.pid}-${Date.now()}.json`);
    let now = 20_000;
    const store = createTaskStateStore({ file, now: () => now });
    const task = (id, status) => ({
      id,
      provider: 'ai-media',
      status,
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 20_000,
      updatedAt: 20_000,
      terminalAt: 20_000,
    });
    store.tasks.set('job-active', task('job-active', 'running'));
    store.tasks.set('job-terminal', task('job-terminal', 'failed'));

    try {
      now += 24 * 60 * 60 * 1000 + 1;
      expect(store.prune()).toBe(true);
      expect(store.tasks.has('job-terminal')).toBe(false);
      expect(store.tasks.has('job-active')).toBe(true);

      now = 20_000 + 7 * 24 * 60 * 60 * 1000 + 1;
      expect(store.prune()).toBe(true);
      expect(store.tasks.has('job-active')).toBe(false);
    } finally {
      try { unlinkSync(file); } catch { /* test cleanup is best effort */ }
    }
  });

  it('restores a successful result from the bounded spool without putting bytes in JSON', async () => {
    const file = join(tmpdir(), `lumina-gateway-result-spool-${process.pid}-${Date.now()}.json`);
    const store = createTaskStateStore({ file });
    store.tasks.set('job-spooled-result', {
      id: 'job-spooled-result',
      provider: 'ai-media',
      status: 'succeeded',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 200,
      terminalAt: 200,
      resultAvailableAt: 200,
      contentType: 'image/png',
      bytes: Buffer.from('spooled-image'),
    });

    try {
      store.save();
      expect(store.tasks.get('job-spooled-result')).not.toHaveProperty('bytes');
      const persisted = readFileSync(file, 'utf8');
      expect(persisted).not.toContain('spooled-image');
      const resultFile = `${file}.results/job-spooled-result.result`;
      const oldTime = new Date('2000-01-01T00:00:00.000Z');
      utimesSync(resultFile, oldTime, oldTime);
      store.save();
      expect(statSync(resultFile).mtimeMs).toBe(oldTime.getTime());
      const restored = createTaskStateStore({ file });
      expect(restored.tasks.get('job-spooled-result')).toMatchObject({
        status: 'succeeded',
        contentType: 'image/png',
      });
      expect(restored.tasks.get('job-spooled-result')).not.toHaveProperty('bytes');
      expect(restored.readResult('job-spooled-result')).toEqual(Buffer.from('spooled-image'));
      const opened = restored.openResult('job-spooled-result');
      const chunks = [];
      for await (const chunk of opened.stream) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from('spooled-image'));
    } finally {
      cleanupState(file);
    }
  });

  it('keeps the in-memory result retryable when the recovery spool commit fails', () => {
    const file = join(tmpdir(), `lumina-gateway-result-recovery-failure-${process.pid}-${Date.now()}.json`);
    const taskId = 'job-recovery-commit-failure';
    const bytes = Buffer.from('recovery-commit-result');
    const store = createTaskStateStore({ file });
    store.tasks.set(taskId, {
      id: taskId,
      provider: 'ai-media',
      status: 'succeeded',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 200,
      terminalAt: 200,
      resultAvailableAt: 200,
      contentType: 'image/png',
      bytes,
    });
    const recoveryBlocker = `${file}.results/${taskId}.result.recovery.${process.pid}.tmp`;

    try {
      mkdirSync(`${file}.results`, { recursive: true });
      mkdirSync(recoveryBlocker);
      store.save();

      expect(store.tasks.get(taskId)?.bytes).toBe(bytes);
      expect(existsSync(`${file}.results/${taskId}.result`)).toBe(false);
      expect(existsSync(`${file}.results/${taskId}.result.recovery`)).toBe(false);

      rmSync(recoveryBlocker, { recursive: true, force: true });
      store.save();
      expect(store.tasks.get(taskId)).not.toHaveProperty('bytes');
      expect(store.readResult(taskId)).toEqual(bytes);
    } finally {
      cleanupState(file);
    }
  });

  it('recovers from the self-describing spool when the raw result commit fails', () => {
    const file = join(tmpdir(), `lumina-gateway-result-raw-failure-${process.pid}-${Date.now()}.json`);
    const taskId = 'job-raw-commit-failure';
    const queuedTask = {
      id: taskId,
      provider: 'ai-media',
      status: 'queued',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 100,
    };
    writeFileSync(file, JSON.stringify([queuedTask]), 'utf8');
    const store = createTaskStateStore({ file });
    const bytes = Buffer.from('raw-commit-result');
    Object.assign(store.tasks.get(taskId), {
      status: 'succeeded',
      updatedAt: 200,
      terminalAt: 200,
      resultAvailableAt: 200,
      contentType: 'image/webp',
      bytes,
    });
    const rawBlocker = `${file}.results/${taskId}.result.${process.pid}.tmp`;

    try {
      mkdirSync(`${file}.results`, { recursive: true });
      mkdirSync(rawBlocker);
      store.save();

      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([queuedTask]);
      expect(existsSync(`${file}.results/${taskId}.result`)).toBe(false);
      expect(existsSync(`${file}.results/${taskId}.result.recovery`)).toBe(true);

      const reopened = createTaskStateStore({ file });
      expect(reopened.tasks.get(taskId)).toMatchObject({
        status: 'succeeded',
        contentType: 'image/webp',
      });
      expect(reopened.readResult(taskId)).toEqual(bytes);

      rmSync(rawBlocker, { recursive: true, force: true });
      reopened.save();
      expect(existsSync(`${file}.results/${taskId}.result`)).toBe(true);
      expect(existsSync(`${file}.results/${taskId}.result.recovery`)).toBe(false);
      expect(createTaskStateStore({ file }).readResult(taskId)).toEqual(bytes);
    } finally {
      cleanupState(file);
    }
  });

  it('recovers a synchronous result when the task JSON commit fails after the result commit', () => {
    const file = join(tmpdir(), `lumina-gateway-result-two-phase-${process.pid}-${Date.now()}.json`);
    const taskId = 'job-two-phase-recovery';
    const queuedTask = {
      id: taskId,
      provider: 'ai-media',
      status: 'queued',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 100,
    };
    writeFileSync(file, JSON.stringify([queuedTask]), 'utf8');
    const store = createTaskStateStore({ file });
    Object.assign(store.tasks.get(taskId), {
      status: 'succeeded',
      updatedAt: 200,
      terminalAt: 200,
      resultAvailableAt: 200,
      contentType: 'image/png',
      bytes: Buffer.from('two-phase-result'),
    });

    try {
      mkdirSync(`${file}.${process.pid}.tmp`);
      store.save();

      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([queuedTask]);
      expect(existsSync(`${file}.results/${taskId}.result`)).toBe(true);
      expect(existsSync(`${file}.results/${taskId}.result.recovery`)).toBe(true);

      const reopened = createTaskStateStore({ file });
      expect(reopened.tasks.get(taskId)).toMatchObject({
        status: 'succeeded',
        contentType: 'image/png',
      });
      expect(reopened.readResult(taskId)).toEqual(Buffer.from('two-phase-result'));

      const confirmedTask = { ...reopened.tasks.get(taskId), resultConfirmedAt: 300 };
      writeFileSync(file, JSON.stringify([confirmedTask]), 'utf8');
      expect(createTaskStateStore({ file }).tasks.get(taskId)?.resultConfirmedAt).toBe(300);
    } finally {
      cleanupState(file);
    }
  });

  it('keeps a successful result readable from memory when the spool write fails', async () => {
    const file = join(tmpdir(), `lumina-gateway-result-spool-failure-${process.pid}-${Date.now()}.json`);
    const store = createTaskStateStore({ file });
    const bytes = Buffer.from('memory-fallback-image');
    store.tasks.set('job-memory-fallback', {
      id: 'job-memory-fallback',
      provider: 'ai-media',
      status: 'succeeded',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 200,
      terminalAt: 200,
      resultAvailableAt: 200,
      contentType: 'image/webp',
      bytes,
    });

    try {
      writeFileSync(`${file}.results`, 'blocks result directory creation');
      store.save();
      store.save();
      expect(store.tasks.get('job-memory-fallback')?.bytes).toBe(bytes);
      expect(store.hasResult('job-memory-fallback')).toBe(true);
      expect(store.readResult('job-memory-fallback')).toBe(bytes);
      const opened = store.openResult('job-memory-fallback');
      const chunks = [];
      for await (const chunk of opened.stream) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(bytes);
    } finally {
      cleanupState(file);
    }
  });

  it('closes an opened result stream when the caller aborts', async () => {
    const file = join(tmpdir(), `lumina-gateway-result-abort-${process.pid}-${Date.now()}.json`);
    const resultFile = `${file}.results/job-aborted-stream.result`;
    const store = createTaskStateStore({ file });
    store.tasks.set('job-aborted-stream', {
      id: 'job-aborted-stream',
      provider: 'ai-media',
      status: 'succeeded',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 200,
      terminalAt: 200,
      resultAvailableAt: 200,
      contentType: 'image/png',
      bytes: Buffer.alloc(1024 * 1024, 1),
    });

    try {
      store.save();
      const controller = new AbortController();
      const opened = store.openResult('job-aborted-stream', controller.signal);
      const stream = opened.stream;
      await new Promise((resolve, reject) => {
        stream.once('open', resolve);
        stream.once('error', reject);
      });
      const streamError = new Promise((resolve) => stream.once('error', resolve));
      const streamClosed = new Promise((resolve) => stream.once('close', resolve));

      controller.abort();

      await expect(streamError).resolves.toMatchObject({ name: 'AbortError' });
      await streamClosed;
      expect(stream.destroyed).toBe(true);
      expect(stream.closed).toBe(true);
      expect(() => unlinkSync(resultFile)).not.toThrow();
    } finally {
      cleanupState(file);
    }
  });

  it('removes result spools when tasks are deleted or their mappings and results expire', () => {
    const file = join(tmpdir(), `lumina-gateway-result-cleanup-${process.pid}-${Date.now()}.json`);
    let now = 10_000;
    const store = createTaskStateStore({
      file,
      now: () => now,
      terminalRetentionMs: 1_000,
      resultRetentionMs: 100,
    });
    const resultTask = (id) => ({
      id,
      provider: 'ai-media',
      status: 'succeeded',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: now,
      updatedAt: now,
      terminalAt: now,
      resultAvailableAt: now,
      contentType: 'image/png',
      bytes: Buffer.from(id),
    });
    const deletedTaskId = 'job-deleted-result';
    const expiredResultTaskId = 'job-expired-result';
    const expiredMappingTaskId = 'job-expired-mapping';
    for (const taskId of [deletedTaskId, expiredResultTaskId, expiredMappingTaskId]) {
      store.tasks.set(taskId, resultTask(taskId));
    }

    try {
      store.save();
      const resultFile = (taskId) => `${file}.results/${taskId}.result`;
      for (const taskId of [deletedTaskId, expiredResultTaskId, expiredMappingTaskId]) {
        expect(existsSync(resultFile(taskId))).toBe(true);
      }

      store.tasks.delete(deletedTaskId);
      now += 101;
      expect(store.prune()).toBe(true);
      expect(store.tasks.has(expiredResultTaskId)).toBe(true);
      expect(store.hasResult(expiredResultTaskId)).toBe(false);
      store.save();
      expect(existsSync(resultFile(deletedTaskId))).toBe(false);
      expect(existsSync(resultFile(expiredResultTaskId))).toBe(false);
      expect(existsSync(resultFile(expiredMappingTaskId))).toBe(false);

      store.tasks.get(expiredMappingTaskId).bytes = Buffer.from(expiredMappingTaskId);
      store.save();
      expect(existsSync(resultFile(expiredMappingTaskId))).toBe(true);
      now = 11_001;
      expect(store.prune()).toBe(true);
      expect(store.tasks.has(expiredMappingTaskId)).toBe(false);
      store.save();
      expect(existsSync(resultFile(expiredMappingTaskId))).toBe(false);
    } finally {
      cleanupState(file);
    }
  });
});
