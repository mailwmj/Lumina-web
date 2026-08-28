/* global Buffer, Response */

import { describe, expect, it, vi } from 'vitest';

import {
  __test,
  createTosPresignedGetUrl,
  createTosTemporaryMediaStore,
} from './tos-temporary-media.mjs';

const environment = {
  NODE_ENV: 'test',
  LUMINA_TOS_BUCKET: 'lumina-test',
  LUMINA_TOS_REGION: 'cn-beijing',
  LUMINA_TOS_ENDPOINT: 'http://127.0.0.1:9000',
  LUMINA_TOS_ACCESS_KEY: 'test-access-key',
  LUMINA_TOS_SECRET_KEY: 'test-secret-key',
  LUMINA_TOS_SECURITY_TOKEN: 'test-session-token',
  LUMINA_TOS_URL_TTL_SECONDS: '3600',
  LUMINA_TOS_FORCE_PATH_STYLE: '1',
};

describe('TOS temporary media delivery', () => {
  it('creates a deterministic short-lived signed GET URL without exposing the secret key', () => {
    const config = __test.configFromEnvironment(environment);
    const url = createTosPresignedGetUrl(
      config,
      'lumina/project/staging/id/input.png',
      new Date('2026-08-28T01:02:03.000Z'),
    );

    expect(url).toContain('/lumina-test/lumina/project/staging/id/input.png?');
    expect(url).toContain('X-Tos-Algorithm=TOS4-HMAC-SHA256');
    expect(url).toContain('X-Tos-Date=20260828T010203Z');
    expect(url).toContain('X-Tos-Expires=3600');
    expect(url).toContain('X-Tos-Security-Token=test-session-token');
    expect(url).toMatch(/X-Tos-Signature=[a-f0-9]{64}/);
    expect(url).not.toContain('test-secret-key');
  });

  it('uses RFC 3986 encoding for object paths and signed query values', () => {
    const config = __test.configFromEnvironment({
      ...environment,
      LUMINA_TOS_SECURITY_TOKEN: "session!'()*",
    });
    const url = createTosPresignedGetUrl(
      config,
      "lumina/project!'()*/staging/input image.png",
      new Date('2026-08-28T01:02:03.000Z'),
    );

    expect(url).toContain('/project%21%27%28%29%2A/staging/input%20image.png?');
    expect(url).toContain('X-Tos-Security-Token=session%21%27%28%29%2A');
    expect(__test.encodeRfc3986("!'()*")).toBe('%21%27%28%29%2A');
  });

  it.each([
    { value: '', expected: 3600 },
    { value: 'not-a-number', expected: 3600 },
    { value: '1', expected: 60 },
    { value: '90000', expected: 86400 },
  ])('normalizes URL TTL $value to $expected seconds', ({ value, expected }) => {
    const config = __test.configFromEnvironment({
      ...environment,
      LUMINA_TOS_URL_TTL_SECONDS: value,
    });

    expect(config.urlTtlSeconds).toBe(expected);
  });

  it('uploads private bytes, returns a presigned URL, and deletes by opaque server-side object key', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    });
    const store = createTosTemporaryMediaStore({
      environment,
      fetchImpl,
      now: () => new Date('2026-08-28T01:02:03.000Z'),
      createId: () => 'upload-id',
    });

    const inputBytes = Buffer.from('image-bytes');
    const uploaded = await store.upload({
      bytes: inputBytes,
      contentType: 'image/png',
      projectId: 'project/one',
    });
    expect(uploaded.objectKey).toBe('lumina/project_one/staging/upload-id/input.png');
    expect(uploaded.expiresAt).toBe(Date.parse('2026-08-28T02:02:03.000Z'));
    expect(calls[0].url).toContain('/lumina-test/lumina/project_one/staging/upload-id/input.png');
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.headers.authorization).toMatch(/^TOS4-HMAC-SHA256 /);
    expect(calls[0].init.headers['cache-control']).toBe('private, max-age=0, no-cache');
    expect(calls[0].init.body).toBe(inputBytes);

    await store.release(uploaded.objectKey);
    expect(calls[1].init.method).toBe('DELETE');
  });

  it('treats a missing TOS object as an idempotent release success', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const store = createTosTemporaryMediaStore({ environment, fetchImpl });

    await expect(store.release('lumina/project/staging/missing/input.png')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1].method).toBe('DELETE');
  });

  it('redacts transport exception details from TOS errors', async () => {
    const leakedValues = [
      'https://storage.internal.example.test/private-object',
      environment.LUMINA_TOS_ACCESS_KEY,
      environment.LUMINA_TOS_SECRET_KEY,
      environment.LUMINA_TOS_SECURITY_TOKEN,
    ];
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`transport failed ${leakedValues.join(' ')}`));
    const store = createTosTemporaryMediaStore({ environment, fetchImpl });

    const error = await store.upload({
      bytes: Buffer.from('image-bytes'),
      contentType: 'image/png',
      projectId: 'project-one',
    }).catch((caught) => caught);

    expect(error).toEqual(new Error('TOS temporary media request failed.'));
    for (const value of leakedValues) {
      expect(error.message).not.toContain(value);
    }
  });

  it('times out a stalled upload and starts best-effort cleanup for its object key', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (_input, init) => {
      calls.push(init.method);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return await new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const store = createTosTemporaryMediaStore({
      environment,
      fetchImpl,
      requestTimeoutMs: 20,
      createId: () => 'stalled-upload',
    });

    await expect(store.upload({
      bytes: Buffer.from('image-bytes'),
      contentType: 'image/png',
      projectId: 'project-one',
    })).rejects.toThrow('TOS temporary media request failed.');
    await vi.waitFor(() => expect(calls).toEqual(['PUT', 'DELETE']));
  });

  it('fails closed when public media delivery is missing or partially configured', async () => {
    const missing = createTosTemporaryMediaStore({ environment: { NODE_ENV: 'test' } });
    expect(missing.available).toBe(false);
    await expect(missing.upload({ bytes: Buffer.from('x'), contentType: 'image/png' }))
      .rejects.toThrow('not configured');
    expect(() => createTosTemporaryMediaStore({
      environment: { NODE_ENV: 'test', LUMINA_TOS_BUCKET: 'bucket-only' },
    })).toThrow('incomplete');
  });
});
