/* global Buffer, fetch, process, setTimeout */

import { once } from 'node:events';
/* global URL */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake upstream did not expose a port.');
  return address.port;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function readFileEventually(file, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = readFileSync(file, 'utf8');
      if (contents.trim()) return contents;
    } catch {
      // The child may not have created the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readFileSync(file, 'utf8');
}

async function waitForReady(child) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Gateway did not start.')), 5000));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('GenerationGateway listening')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Gateway exited before start: ${code}`)));
  });
  await Promise.race([ready, timeout]);
}

const UNSAFE_UPSTREAM_TASK_IDS = {
  'credential-shaped-id': 'sk-proj-provider-secret',
  'prefixed-credential-shaped-id': 'task-sk-proj-AbCdEfGhIjKlMnOp',
  'prompt-shaped-id': 'prompt-secret',
  'task-prompt-shaped-id': 'task-prompt-secret-1',
  'base64-shaped-id': 'bWVkaWEtc2VjcmV0',
  'prefixed-base64-shaped-id': 'task-bWVkaWEtc2VjcmV0-1',
  'jwt-shaped-id': 'task-header.payload.signature',
};

describe('gateway/server.mjs process contract', () => {
  it('submits, polls, and materializes a result through a controlled fake upstream', async () => {
    let forwardedBody;
    let forwardedAuthorization;
    let resultFetches = 0;
    const upstream = createServer(async (request, response) => {
      if (request.url === '/v1/images/generations' && request.method === 'POST') {
        forwardedAuthorization = request.headers.authorization;
        forwardedBody = JSON.parse(await readRequestBody(request));
        response.writeHead(200, { 'content-type': 'application/json' });
        const unsafeTaskId = UNSAFE_UPSTREAM_TASK_IDS[forwardedBody.prompt];
        if (unsafeTaskId) {
          response.end(JSON.stringify({ id: unsafeTaskId }));
          return;
        }
        const resultUrl = forwardedBody.prompt === 'blocked'
          ? 'http://127.0.0.1:9/private.png'
          : `http://127.0.0.1:${upstream.address().port}/results/image.png`;
        response.end(JSON.stringify({ data: [{ url: resultUrl }] }));
        return;
      }
      if (request.url === '/results/image.png' && request.method === 'GET') {
        resultFetches += 1;
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('fake-image');
        return;
      }
      response.writeHead(404);
      response.end('not found');
    });

    const upstreamPort = await listen(upstream);
    const gatewayPort = await (async () => {
      const probe = createServer();
      const port = await listen(probe);
      await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
      return port;
    })();
    const stateFile = join(tmpdir(), `lumina-gateway-test-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const headers = {
        authorization: 'Bearer ephemeral-test-key',
        origin: 'http://127.0.0.1:4173',
        'content-type': 'application/json',
      };
      const submit = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operation: 'submit',
          provider: 'ai-media',
          projectId: 'project-1',
          projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'a kite', size: '1K' },
        }),
      });
      expect(submit.status).toBe(202);
      const submitted = await submit.json();
      expect(submitted.status).toBe('succeeded');
      expect(forwardedAuthorization).toBe('Bearer ephemeral-test-key');
      expect(forwardedBody).toEqual({ model: 'ai-media/gpt-image-2', prompt: 'a kite', size: '1K' });
      const persistedState = readFileSync(stateFile, 'utf8');
      expect(persistedState).not.toContain('ephemeral-test-key');
      expect(persistedState).not.toContain('a kite');
      const sessionCookie = submit.headers.get('set-cookie')?.split(';', 1)[0];
      expect(sessionCookie).toMatch(/^lumina_session=/);
      const sessionHeaders = { ...headers, cookie: sessionCookie };

      const poll = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs/${submitted.job_id}`, {
        method: 'POST', headers: sessionHeaders, body: JSON.stringify({ operation: 'poll' }),
      });
      const polled = await poll.json();
      expect(polled.status).toBe('succeeded');
      const unboundResult = await fetch(`http://127.0.0.1:${gatewayPort}${polled.result}`, { headers });
      expect(unboundResult.status).toBe(404);
      const result = await fetch(`http://127.0.0.1:${gatewayPort}${polled.result}`, { headers: sessionHeaders });
      expect(result.status).toBe(200);
      expect(result.headers.get('content-type')).toContain('image/png');
      expect(await result.text()).toBe('fake-image');

      const blocked = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit', provider: 'ai-media', projectId: 'project-1', projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'blocked', size: '1K' },
        }),
      });
      expect((await blocked.json()).status).toBe('failed');
      expect(resultFetches).toBe(1);

      for (const [prompt, unsafeTaskId] of Object.entries(UNSAFE_UPSTREAM_TASK_IDS)) {
        const rejected = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
          method: 'POST', headers: sessionHeaders,
          body: JSON.stringify({
            operation: 'submit', provider: 'ai-media', projectId: 'project-1', projectRevision: 'revision-1',
            request: { model: 'ai-media/gpt-image-2', prompt, size: '1K' },
          }),
        });
        expect((await rejected.json()).status).toBe('failed');
        expect(readFileSync(stateFile, 'utf8')).not.toContain(unsafeTaskId);
      }
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('does not connect to a private configured Provider origin without an explicit development trust', async () => {
    let upstreamCalls = 0;
    const upstream = createServer((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: 'ZmFrZQ==' }] }));
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const stateFile = join(tmpdir(), `lumina-gateway-private-origin-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ephemeral-test-key',
          origin: 'http://127.0.0.1:4173',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'submit',
          provider: 'ai-media',
          projectId: 'project-1',
          projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'private origin', size: '1K' },
        }),
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ status: 'failed' });
      expect(upstreamCalls).toBe(0);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('binds a same-origin session to its source IP when a trusted proxy supplies it', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: 'ZmFrZQ==' }] }));
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const stateFile = join(tmpdir(), `lumina-gateway-session-source-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_TRUST_PROXY: '1',
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const headers = {
        authorization: 'Bearer ephemeral-test-key',
        origin: 'http://127.0.0.1:4173',
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.10',
      };
      const submit = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operation: 'submit',
          provider: 'ai-media',
          projectId: 'project-1',
          projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'source bound', size: '1K' },
        }),
      });
      const submitted = await submit.json();
      const sessionCookie = submit.headers.get('set-cookie')?.split(';', 1)[0];

      const poll = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs/${submitted.job_id}`, {
        method: 'POST',
        headers: {
          ...headers,
          cookie: sessionCookie,
          'x-forwarded-for': '198.51.100.11',
        },
        body: JSON.stringify({ operation: 'poll' }),
      });

      expect(poll.status).toBe(403);
      expect(await poll.json()).toMatchObject({ error: 'session_source_mismatch' });
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('keeps prompt, media, credentials, URLs, fragments, and upstream responses out of state and logs', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          message: 'provider-response-secret https://provider.test/result?token=url-secret#fragment-secret',
          api_key: 'provider-api-secret',
        },
      }));
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const stateFile = join(tmpdir(), `lumina-gateway-secret-state-${process.pid}-${Date.now()}.json`);
    const logFile = join(tmpdir(), `lumina-gateway-secret-log-${process.pid}-${Date.now()}.jsonl`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
        LUMINA_GATEWAY_LOG_FILE: logFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer api-key-secret',
          origin: 'http://127.0.0.1:4173',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'submit',
          provider: 'ai-media',
          projectId: 'project-1',
          projectRevision: 'revision-1',
          request: {
            model: 'ai-media/gpt-image-2',
            prompt: 'prompt-secret',
            size: '1K',
            referenceImages: ['data:image/png;base64,bWVkaWEtc2VjcmV0'],
          },
        }),
      });
      expect((await response.json()).status).toBe('failed');

      const persisted = readFileSync(stateFile, 'utf8');
      const log = await readFileEventually(logFile);
      for (const secret of [
        'prompt-secret',
        'media-secret',
        'api-key-secret',
        'provider-api-secret',
        'provider-response-secret',
        'url-secret',
        'fragment-secret',
      ]) {
        expect(persisted).not.toContain(secret);
        expect(log).not.toContain(secret);
      }
      const record = JSON.parse(log.trim());
      expect(Object.keys(record).sort()).toEqual([
        'bytes', 'duration_ms', 'operation', 'provider', 'request_id', 'status', 'timestamp',
      ]);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      try { unlinkSync(logFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('returns the shared quota error contract when the Provider active-task budget is exhausted', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `upstream-${randomUUID()}` }));
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const stateFile = join(tmpdir(), `lumina-gateway-provider-quota-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_MAX_CONCURRENT_TASKS_PER_SOURCE: '10',
        LUMINA_GATEWAY_MAX_ACTIVE_TASKS_PER_PROVIDER: '1',
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const headers = {
      authorization: 'Bearer ephemeral-test-key',
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
    };
    const submit = (prompt) => fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operation: 'submit',
        provider: 'ai-media',
        projectId: 'project-1',
        projectRevision: 'revision-1',
        request: { model: 'ai-media/gpt-image-2', prompt, size: '1K' },
      }),
    });

    try {
      await waitForReady(gateway);
      expect((await submit('first')).status).toBe(202);
      const rejected = await submit('second');
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get('retry-after')).toBe('60');
      expect(await rejected.json()).toMatchObject({
        error: 'provider_quota_exceeded',
        request_id: expect.any(String),
      });
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('rejects a non-image reference payload before it creates an upstream task', async () => {
    let upstreamCalls = 0;
    const upstream = createServer((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: 'ZmFrZQ==' }] }));
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const stateFile = join(tmpdir(), `lumina-gateway-reference-type-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ephemeral-test-key',
          origin: 'http://127.0.0.1:4173',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'submit',
          provider: 'ai-media',
          projectId: 'project-1',
          projectRevision: 'revision-1',
          request: {
            model: 'ai-media/gpt-image-2',
            prompt: 'reference validation',
            size: '1K',
            referenceImages: ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_generation_request' });
      expect(upstreamCalls).toBe(0);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('rejects a non-JSON job body before it reaches the Provider', async () => {
    let upstreamCalls = 0;
    const upstream = createServer((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: 'ZmFrZQ==' }] }));
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const stateFile = join(tmpdir(), `lumina-gateway-body-type-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ephemeral-test-key',
          origin: 'http://127.0.0.1:4173',
          'content-type': 'text/plain',
        },
        body: JSON.stringify({
          operation: 'submit',
          provider: 'ai-media',
          projectId: 'project-1',
          projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'wrong body type', size: '1K' },
        }),
      });

      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ error: 'request_content_type_not_allowed' });
      expect(upstreamCalls).toBe(0);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('requires the canonical Origin for task-changing requests', async () => {
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const stateFile = join(tmpdir(), `lumina-gateway-origin-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ephemeral-test-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operation: 'submit' }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'origin_required' });
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
    }
  }, 10000);

  it('transcodes controlled media and serves opaque provider-scoped grants only until reclaim or expiry', async () => {
    const transcoderCalls = [];
    const upstream = createServer(async (request, response) => {
      if (request.url !== '/transcode' || request.method !== 'POST') {
        response.writeHead(404);
        response.end('not found');
        return;
      }
      transcoderCalls.push({
        type: request.headers['content-type'],
        kind: request.headers['x-lumina-media-kind'],
        body: await readRequestBody(request),
      });
      response.writeHead(200, { 'content-type': 'video/mp4' });
      response.end('converted');
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-media-gateway-test-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
        LUMINA_GATEWAY_MEDIA_TRANSCODER_URL: `http://127.0.0.1:${upstreamPort}/transcode`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_MEDIA_PROVIDER_IDS: 'volcengine-seedance',
        LUMINA_GATEWAY_MEDIA_TTL_MS: '500',
        LUMINA_GATEWAY_MAX_MEDIA_BYTES: '16',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const mediaUrl = `http://127.0.0.1:${gatewayPort}/api/generation/media`;
    const headers = {
      origin: canonicalOrigin,
      'content-type': 'video/quicktime',
      'x-lumina-media-kind': 'video',
      'x-lumina-media-file-name': 'clip.mov',
    };

    try {
      await waitForReady(gateway);
      const transcoded = await fetch(mediaUrl, {
        method: 'POST',
        headers: { ...headers, 'x-lumina-media-operation': 'transcode' },
        body: 'quick',
      });
      expect(transcoded.status).toBe(200);
      expect(transcoded.headers.get('content-type')).toContain('video/mp4');
      expect(await transcoded.text()).toBe('converted');
      expect(transcoderCalls).toEqual([{
        type: 'video/quicktime',
        kind: 'video',
        body: 'quick',
      }]);

      const published = await fetch(mediaUrl, {
        method: 'POST',
        headers: {
          ...headers,
          host: 'attacker.example',
          'x-forwarded-proto': 'https',
          'content-type': 'video/mp4',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-provider': 'volcengine-seedance',
        },
        body: 'published-media',
      });
      expect(published.status).toBe(201);
      const grant = await published.json();
      expect(grant).toMatchObject({
        key: expect.stringMatching(/^media-[0-9a-f-]{36}$/),
        contentType: 'video/mp4',
        sizeBytes: 'published-media'.length,
      });
      expect(grant.url).toMatch(new RegExp(`^${canonicalOrigin.replace('.', '\\.')}/api/generation/media/`));
      expect(grant.url).toMatch(/grant=[0-9a-f-]{36}&provider=volcengine-seedance$/);
      expect(readFileSync(stateFile, 'utf8')).not.toContain(grant.url);
      const sessionCookie = published.headers.get('set-cookie')?.split(';', 1)[0];
      expect(sessionCookie).toMatch(/^lumina_session=/);

      const scopedUrl = new URL(grant.url);
      scopedUrl.searchParams.set('provider', 'other-provider');
      expect((await fetch(scopedUrl)).status).toBe(404);
      const publicMedia = await fetch(grant.url);
      expect(publicMedia.status).toBe(200);
      expect(await publicMedia.text()).toBe('published-media');

      const reclaimed = await fetch(`${mediaUrl}/${grant.key}`, {
        method: 'DELETE',
        headers: { origin: canonicalOrigin, cookie: sessionCookie },
      });
      expect(reclaimed.status).toBe(204);
      expect((await fetch(grant.url)).status).toBe(404);

      const expiring = await fetch(mediaUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'video/mp4',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-provider': 'volcengine-seedance',
        },
        body: 'expires',
      });
      const expiringGrant = await expiring.json();
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect((await fetch(expiringGrant.url)).status).toBe(404);

      expect((await fetch(mediaUrl, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain', 'x-lumina-media-operation': 'publish' },
        body: 'wrong-type',
      })).status).toBe(415);
      expect((await fetch(mediaUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'video/mp4',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-provider': 'volcengine-seedance',
        },
        body: 'larger-than-limit',
      })).status).toBe(413);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);
});
