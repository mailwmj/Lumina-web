/* global Buffer, process */

import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createTaskStateStore } from './task-state.mjs';

describe('gateway task state', () => {
  it('persists only safe task mapping fields', () => {
    const file = join(tmpdir(), `lumina-gateway-state-${process.pid}-${Date.now()}.json`);
    const store = createTaskStateStore({ file });
    store.tasks.set('job-safe', {
      id: 'job-safe',
      provider: 'ai-media',
      status: 'running',
      upstreamTaskId: 'provider-0123456789abcdef',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: 100,
      updatedAt: 200,
      errorCode: 'provider_rejected',
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
        sourceId: 'a'.repeat(64),
        sessionBinding: 'b'.repeat(64),
        createdAt: 100,
        updatedAt: 200,
        errorCode: 'provider_rejected',
      }]);
      expect(persisted).not.toContain('prompt-secret');
      expect(persisted).not.toContain('api-secret');
      expect(persisted).not.toContain('provider-response-secret');
      expect(persisted).not.toContain('media-secret');
    } finally {
      try { unlinkSync(file); } catch { /* test cleanup is best effort */ }
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
});
