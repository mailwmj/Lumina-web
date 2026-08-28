/* global AbortController, Blob, Buffer, FormData, URL, fetch, process, setTimeout */

import { once } from 'node:events';

import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

async function inspectMultipartRequest(request) {
  const marker = 'filename="reference-';
  let pending = '';
  let byteCount = 0;
  let fileCount = 0;
  for await (const chunk of request) {
    byteCount += chunk.length;
    let text = pending + Buffer.from(chunk).toString('latin1');
    let index = text.indexOf(marker);
    while (index >= 0) {
      fileCount += 1;
      text = text.slice(index + marker.length);
      index = text.indexOf(marker);
    }
    pending = text.slice(-(marker.length - 1));
  }
  return { byteCount, fileCount };
}

async function readFileEventually(file, timeoutMs = 1000, isReady = (contents) => contents.trim()) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = readFileSync(file, 'utf8');
      if (isReady(contents)) return contents;
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
    let forwardedEditBody;
    let forwardedEditContentType;
    const forwardedIdempotencyKeys = [];
    let resultFetches = 0;
    let transientPolls = 0;
    let persistentTransientPolls = 0;
    const upstream = createServer(async (request, response) => {
      if ((request.url === '/v1/images/generations' || request.url === '/v1/images/edits') && request.method === 'POST') {
        forwardedIdempotencyKeys.push(request.headers['idempotency-key']);
        if (String(request.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
          forwardedEditContentType = String(request.headers['content-type']);
          forwardedEditBody = await readRequestBody(request);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: [{ image: { b64_json: 'ZmFrZS1yZWZlcmVuY2UtaW1hZ2U=' } }] }));
          return;
        }
        forwardedAuthorization = request.headers.authorization;
        forwardedBody = JSON.parse(await readRequestBody(request));
        if (forwardedBody.prompt === 'nested async task') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: { id: 'provider-0123456789abcdef' } }));
          return;
        }
        if (forwardedBody.prompt === 'terminal task without image') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: { id: 'provider-fedcba9876543210' } }));
          return;
        }
        if (forwardedBody.prompt === 'transient poll') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: { id: 'provider-aabbccddeeff0011' } }));
          return;
        }
        if (forwardedBody.prompt === 'persistent transient poll') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: { id: 'provider-0011223344556677' } }));
          return;
        }
        if (forwardedBody.prompt === 'mixed task identifiers') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            data: {
              task_id: 'task-1111111111111111',
              id: 'task-2222222222222222',
              request_id: 'task-3333333333333333',
            },
          }));
          return;
        }
        if (forwardedBody.prompt === 'output mime') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            output: { b64_json: 'd2VicC1pbWFnZQ==', media_type: 'image/webp' },
          }));
          return;
        }
        if (forwardedBody.prompt === 'relative download') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ assets: [{ download_url: '/v1/assets/result.jpg' }] }));
          return;
        }
        if (forwardedBody.prompt === 'provider rejected') {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'provider-response-secret' } }));
          return;
        }
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
      if (request.url === '/v1/images/tasks/provider-0123456789abcdef?view=summary' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { b64_json: 'ZmFrZS1hc3luYy1pbWFnZQ==' } }));
        return;
      }
      if (request.url === '/v1/images/tasks/provider-fedcba9876543210?view=summary' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { status: 'completed' } }));
        return;
      }
      if (request.url === '/v1/images/tasks/provider-aabbccddeeff0011?view=summary' && request.method === 'GET') {
        transientPolls += 1;
        if (transientPolls === 1) {
          response.writeHead(429, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'retry later' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { b64_json: 'cmVjb3ZlcmVk' } }));
        return;
      }
      if (request.url === '/v1/images/tasks/provider-0011223344556677?view=summary' && request.method === 'GET') {
        persistentTransientPolls += 1;
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'still unavailable' } }));
        return;
      }
      if (request.url === '/v1/images/tasks/task-1111111111111111?view=summary' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { image: { b64_json: 'dGFzay1pZC1yZXN1bHQ=' } } }));
        return;
      }
      if (request.url === '/v1/assets/result.jpg' && request.method === 'GET') {
        expect(request.headers.authorization).toBe('Bearer ephemeral-test-key');
        response.writeHead(200, { 'content-type': 'image/jpeg' });
        response.end('jpeg-image');
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
        LUMINA_GATEWAY_POLL_RETRY_BASE_DELAY_MS: '50',
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
          request: {
            model: 'ai-media/gpt-image-2',
            prompt: 'a kite',
            size: '2K',
            aspectRatio: '1:1',
          },
        }),
      });
      expect(submit.status).toBe(202);
      const submitted = await submit.json();
      expect(submitted.status).toBe('succeeded');
      expect(forwardedAuthorization).toBe('Bearer ephemeral-test-key');
      expect(forwardedBody).toEqual({
        model: 'gpt-image-2',
        prompt: 'a kite',
        n: 1,
        size: '2048x2048',
        quality: 'medium',
        async: true,
        response_format: 'b64_json',
      });
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

      const asyncSubmit = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit', provider: 'ai-media', projectId: 'project-1', projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'nested async task', size: '1K' },
        }),
      });
      const asyncSubmitted = await asyncSubmit.json();
      expect(asyncSubmitted.status).toBe('running');
      const asyncPoll = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${asyncSubmitted.job_id}`,
        { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ operation: 'poll' }) },
      );
      const asyncPolled = await asyncPoll.json();
      expect(asyncPolled.status).toBe('succeeded');
      const asyncResult = await fetch(
        `http://127.0.0.1:${gatewayPort}${asyncPolled.result}`,
        { headers: sessionHeaders },
      );
      expect(await asyncResult.text()).toBe('fake-async-image');

      const terminalSubmit = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit', provider: 'ai-media', projectId: 'project-1', projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'terminal task without image', size: '1K' },
        }),
      });
      const terminalSubmitted = await terminalSubmit.json();
      expect(terminalSubmitted.status).toBe('running');
      const terminalPoll = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${terminalSubmitted.job_id}`,
        { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ operation: 'poll' }) },
      );
      expect(await terminalPoll.json()).toMatchObject({
        status: 'failed',
        error: 'The image provider returned no usable result.',
      });

      const reference = Buffer.alloc(8 * 1024 * 1024 + 1, 7).toString('base64');
      const referenceUpload = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/media`, {
        method: 'POST',
        headers: {
          origin: 'http://127.0.0.1:4173',
          cookie: sessionCookie,
          'content-type': 'image/png',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-kind': 'image',
          'x-lumina-media-provider': 'ai-media',
        },
        body: Buffer.from(reference, 'base64'),
      });
      expect(referenceUpload.status).toBe(201);
      const referenceGrant = await referenceUpload.json();
      const referenceSubmit = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit', provider: 'ai-media', projectId: 'project-1', projectRevision: 'revision-1',
          request: {
            model: 'ai-media/gpt-image-2', prompt: 'reference larger than eight mebibytes',
            size: '4K', aspectRatio: '3:4',
            referenceMediaKeys: [referenceGrant.key],
          },
        }),
      });
      expect(await referenceSubmit.json()).toMatchObject({ status: 'succeeded' });
      expect(forwardedEditContentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(forwardedEditBody).toContain('name="model"\r\n\r\ngpt-image-2\r\n');
      expect(forwardedEditBody).toContain('name="size"\r\n\r\n3072x4096\r\n');
      expect(forwardedEditBody).toContain('name="quality"\r\n\r\nhigh\r\n');
      expect(forwardedEditBody).toContain('name="async"\r\n\r\ntrue\r\n');
      expect(forwardedEditBody).toContain('name="response_format"\r\n\r\nb64_json\r\n');
      expect(forwardedEditBody).toContain('name="image"; filename="reference-1.png"\r\nContent-Type: image/png');
      expect(forwardedIdempotencyKeys.every((value) => (
        typeof value === 'string' && /^opencanvas-image-[0-9a-f-]{36}$/i.test(value)
      ))).toBe(true);
      expect(new Set(forwardedIdempotencyKeys).size).toBe(forwardedIdempotencyKeys.length);

      const outputMime = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit', provider: 'ai-media', projectId: 'project-1', projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'output mime', size: '1K' },
        }),
      });
      const outputMimeJob = await outputMime.json();
      expect(outputMimeJob.status).toBe('succeeded');
      const outputMimeResult = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${outputMimeJob.job_id}/result`,
        { headers: sessionHeaders },
      );
      expect(outputMimeResult.headers.get('content-type')).toContain('image/webp');
      expect(await outputMimeResult.text()).toBe('webp-image');

      const relativeDownload = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit', provider: 'ai-media', projectId: 'project-1', projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'relative download', size: '1K' },
        }),
      });
      const relativeJob = await relativeDownload.json();
      expect(relativeJob.status).toBe('succeeded');
      const relativeResult = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${relativeJob.job_id}/result`,
        { headers: sessionHeaders },
      );
      expect(relativeResult.headers.get('content-type')).toContain('image/jpeg');
      expect(await relativeResult.text()).toBe('jpeg-image');

      const transientSubmit = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit', provider: 'ai-media', projectId: 'project-1', projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'transient poll', size: '1K' },
        }),
      });
      const transientJob = await transientSubmit.json();
      expect(transientJob.status).toBe('running');
      const transientFirstPoll = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${transientJob.job_id}`,
        { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ operation: 'poll' }) },
      );
      const transientFirstStatus = await transientFirstPoll.json();
      expect(transientFirstStatus).toMatchObject({
        status: 'running',
        recovery: {
          retry_count: 1,
          requires_manual_requery: false,
        },
      });
      const transientSecondPoll = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${transientJob.job_id}`,
        { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ operation: 'poll' }) },
      );
      expect(await transientSecondPoll.json()).toMatchObject({
        status: 'running',
        recovery: { retry_count: 1 },
      });
      expect(transientPolls).toBe(1);
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.max(1, transientFirstStatus.recovery.next_retry_at - Date.now() + 1),
      ));
      const transientRecoveredPoll = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${transientJob.job_id}`,
        { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ operation: 'poll' }) },
      );
      expect(await transientRecoveredPoll.json()).toMatchObject({ status: 'succeeded' });

      const persistentSubmit = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit', provider: 'ai-media', projectId: 'project-1', projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'persistent transient poll', size: '1K' },
        }),
      });
      const persistentJob = await persistentSubmit.json();
      expect(persistentJob.status).toBe('running');
      let persistentStatus;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const response = await fetch(
          `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${persistentJob.job_id}`,
          { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ operation: 'poll' }) },
        );
        persistentStatus = await response.json();
        expect(persistentStatus).toMatchObject({
          status: 'running',
          recovery: {
            retry_count: attempt,
            requires_manual_requery: attempt === 5,
          },
        });
        if (attempt < 5) {
          await new Promise((resolve) => setTimeout(
            resolve,
            Math.max(1, persistentStatus.recovery.next_retry_at - Date.now() + 1),
          ));
        }
      }
      const pollsAtManualFence = persistentTransientPolls;
      const fencedPoll = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${persistentJob.job_id}`,
        { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ operation: 'poll' }) },
      );
      expect(await fencedPoll.json()).toMatchObject({
        status: 'running',
        recovery: { retry_count: 5, requires_manual_requery: true },
      });
      expect(persistentTransientPolls).toBe(pollsAtManualFence);
      const manualRequery = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${persistentJob.job_id}`,
        { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ operation: 'requery' }) },
      );
      expect(await manualRequery.json()).toMatchObject({
        status: 'running',
        recovery: { retry_count: 1, requires_manual_requery: false },
      });
      expect(persistentTransientPolls).toBe(pollsAtManualFence + 1);

      const mixedIdSubmit = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit', provider: 'ai-media', projectId: 'project-1', projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'mixed task identifiers', size: '1K' },
        }),
      });
      const mixedIdJob = await mixedIdSubmit.json();
      expect(mixedIdJob.status).toBe('running');
      const mixedIdPoll = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${mixedIdJob.job_id}`,
        { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ operation: 'poll' }) },
      );
      expect(await mixedIdPoll.json()).toMatchObject({ status: 'succeeded' });

      const providerRejected = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST', headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit', provider: 'ai-media', projectId: 'project-1', projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt: 'provider rejected', size: '1K' },
        }),
      });
      const providerRejectedBody = await providerRejected.json();
      expect(providerRejectedBody).toMatchObject({
        status: 'failed',
        error: 'The image provider rejected the generation request.',
        error_details: 'Provider request failed with HTTP 401.',
      });
      expect(JSON.stringify(providerRejectedBody)).not.toContain('provider-response-secret');
      expect(readFileSync(stateFile, 'utf8')).not.toContain('provider-response-secret');

      const rejectedPoll = await fetch(
        `http://127.0.0.1:${gatewayPort}/api/generation/jobs/${providerRejectedBody.job_id}`,
        { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ operation: 'poll' }) },
      );
      expect(await rejectedPoll.json()).toMatchObject({
        status: 'failed',
        error_details: 'Provider request failed with HTTP 401.',
      });

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

  it('proxies Chaomo model discovery, submission, polling, and result retrieval through its fixed upstream', async () => {
    const received = [];
    const upstream = createServer(async (request, response) => {
      received.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: request.method === 'POST' ? await readRequestBody(request) : undefined,
      });
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'gpt-image2-4K' }] }));
        return;
      }
      if (request.method === 'POST'
        && (request.url === '/v1/images/generations' || request.url === '/v1/images/edits')) {
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { id: 'task-0123456789abcdef' } }));
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/images/task-0123456789abcdef') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${upstream.address().port}/results/chaomo.png` }] }));
        return;
      }
      if (request.method === 'GET' && request.url === '/results/chaomo.png') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('chaomo-image');
        return;
      }
      response.writeHead(404);
      response.end('not found');
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const stateFile = join(tmpdir(), `lumina-gateway-chaomo-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_CHAOMO_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const headers = {
        authorization: 'Bearer chaomo-test-key',
        origin: 'http://127.0.0.1:4173',
        'content-type': 'application/json',
      };
      const models = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/providers/chaomo/models`, { headers });
      expect(models.status).toBe(200);
      expect(await models.json()).toEqual({ data: [{ id: 'gpt-image2-4K' }] });
      const sessionCookie = models.headers.get('set-cookie')?.split(';', 1)[0];
      const referenceMediaKeys = [];
      for (const body of ['chaomo-reference-one', 'chaomo-reference-two']) {
        const media = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/media`, {
          method: 'POST',
          headers: {
            origin: 'http://127.0.0.1:4173',
            cookie: sessionCookie,
            'content-type': 'image/png',
            'x-lumina-media-operation': 'publish',
            'x-lumina-media-kind': 'image',
            'x-lumina-media-provider': 'chaomo',
          },
          body,
        });
        expect(media.status).toBe(201);
        referenceMediaKeys.push((await media.json()).key);
      }

      const submitted = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers: { ...headers, cookie: sessionCookie },
        body: JSON.stringify({
          operation: 'submit',
          provider: 'chaomo',
          projectId: 'project-1',
          projectRevision: 'revision-1',
          request: {
            model: 'chaomo/gpt-image2-4K',
            prompt: 'a lantern',
            size: '4K',
            aspectRatio: '16:9',
            referenceMediaKeys,
          },
        }),
      });
      expect(submitted.status).toBe(202);
      const submission = await submitted.json();
      expect(submission.status).toBe('running');

      const polled = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs/${submission.job_id}`, {
        method: 'POST',
        headers: { ...headers, cookie: sessionCookie },
        body: JSON.stringify({ operation: 'poll' }),
      });
      expect(polled.status).toBe(200);
      const poll = await polled.json();
      expect(poll.status).toBe('succeeded');
      const result = await fetch(`http://127.0.0.1:${gatewayPort}${poll.result}`, {
        headers: { ...headers, cookie: sessionCookie },
      });
      expect(await result.text()).toBe('chaomo-image');

      expect(received).toEqual([
        expect.objectContaining({ method: 'GET', url: '/v1/models', authorization: 'Bearer chaomo-test-key' }),
        expect.objectContaining({
          method: 'POST',
          url: '/v1/images/edits',
          authorization: 'Bearer chaomo-test-key',
        }),
        expect.objectContaining({ method: 'GET', url: '/v1/images/task-0123456789abcdef' }),
        expect.objectContaining({ method: 'GET', url: '/results/chaomo.png' }),
      ]);
      const edit = received.find((request) => request.url === '/v1/images/edits');
      expect(edit.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(edit.body.match(/name="image\[\]"; filename="reference-[12]\.png"/g)).toHaveLength(2);
      expect(edit.body).not.toContain('name="image"; filename=');
      expect(readFileSync(stateFile, 'utf8')).not.toContain('chaomo-test-key');
      expect(readFileSync(stateFile, 'utf8')).not.toContain('a lantern');
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('registers an OpenAI-compatible custom provider per session without persisting its endpoint or key', async () => {
    const received = [];
    const upstream = createServer(async (request, response) => {
      received.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: request.method === 'POST' ? await readRequestBody(request) : undefined,
      });
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'vendor-image-v1' }] }));
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/images/generations') {
        if (received.at(-1)?.body.includes('active custom task')) {
          response.writeHead(202, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: { id: 'provider-0123456789abcdef' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: 'Y3VzdG9tLWltYWdl' }] }));
        return;
      }
      response.writeHead(404);
      response.end('not found');
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const stateFile = join(tmpdir(), `lumina-gateway-custom-provider-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const provider = 'custom-openai:tenant-a';
      const headers = {
        authorization: 'Bearer custom-provider-key',
        origin: 'http://127.0.0.1:4173',
        'content-type': 'application/json',
      };
      const registration = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/providers/custom`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operation: 'register',
          provider: {
            id: provider,
            base_url: `http://127.0.0.1:${upstreamPort}/v1`,
            protocol: 'openai-images',
          },
        }),
      });
      expect(registration.status).toBe(204);
      const sessionCookie = registration.headers.get('set-cookie')?.split(';', 1)[0];
      const sessionHeaders = { ...headers, cookie: sessionCookie };

      const models = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/providers/models?provider=${encodeURIComponent(provider)}`, {
        headers: sessionHeaders,
      });
      expect(await models.json()).toEqual({ data: [{ id: 'vendor-image-v1' }] });

      const submitted = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit',
          provider,
          projectId: 'project-1',
          projectRevision: 'revision-1',
          request: {
            model: `${provider}/vendor-image-v1`,
            prompt: 'custom prompt secret',
            size: '2K',
            aspectRatio: '16:9',
          },
        }),
      });
      expect(await submitted.json()).toMatchObject({ status: 'succeeded' });

      const activeSubmission = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'submit', provider, projectId: 'project-1', projectRevision: 'revision-1',
          request: { model: `${provider}/vendor-image-v1`, prompt: 'active custom task', size: '1K' },
        }),
      });
      expect(await activeSubmission.json()).toMatchObject({ status: 'running' });
      const changedEndpoint = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/providers/custom`, {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({
          operation: 'register',
          provider: {
            id: provider,
            base_url: `http://127.0.0.1:${upstreamPort}/changed-v1`,
            protocol: 'openai-images',
          },
        }),
      });
      expect(changedEndpoint.status).toBe(400);

      const wrongSession = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operation: 'submit', provider, projectId: 'project-1', projectRevision: 'revision-1',
          request: { model: `${provider}/vendor-image-v1`, prompt: 'other session', size: '1K' },
        }),
      });
      expect(await wrongSession.json()).toMatchObject({ error: 'provider_or_operation_not_allowed' });

      expect(received).toEqual([
        expect.objectContaining({ method: 'GET', url: '/v1/models', authorization: 'Bearer custom-provider-key' }),
        expect.objectContaining({
          method: 'POST',
          url: '/v1/images/generations',
          authorization: 'Bearer custom-provider-key',
          body: JSON.stringify({
            model: 'vendor-image-v1', prompt: 'custom prompt secret', n: 1,
            size: '1536x1024', quality: 'medium', response_format: 'b64_json',
          }),
        }),
        expect.objectContaining({
          method: 'POST',
          url: '/v1/images/generations',
          authorization: 'Bearer custom-provider-key',
          body: JSON.stringify({
            model: 'vendor-image-v1', prompt: 'active custom task', n: 1,
            size: '1024x1024', quality: 'low', response_format: 'b64_json',
          }),
        }),
      ]);
      const persisted = readFileSync(stateFile, 'utf8');
      expect(persisted).not.toContain(`127.0.0.1:${upstreamPort}`);
      expect(persisted).not.toContain('custom-provider-key');
      expect(persisted).not.toContain('custom prompt secret');
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
      const commonHeaders = {
        authorization: 'Bearer api-key-secret',
        origin: 'http://127.0.0.1:4173',
      };
      const mediaResponse = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/media`, {
        method: 'POST',
        headers: {
          ...commonHeaders,
          'content-type': 'image/png',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-kind': 'image',
          'x-lumina-media-provider': 'ai-media',
        },
        body: 'media-secret',
      });
      expect(mediaResponse.status).toBe(201);
      const mediaGrant = await mediaResponse.json();
      const sessionCookie = mediaResponse.headers.get('set-cookie')?.split(';', 1)[0];
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/generation/jobs`, {
        method: 'POST',
        headers: {
          ...commonHeaders,
          cookie: sessionCookie,
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
            referenceMediaKeys: [mediaGrant.key],
          },
        }),
      });
      expect((await response.json()).status).toBe('failed');

      const persisted = readFileSync(stateFile, 'utf8');
      const log = await readFileEventually(logFile, 1000, (contents) => {
        try {
          const records = contents.trim().split(/\r?\n/).map((line) => JSON.parse(line));
          return [
            ['media_publish', 'media', 201],
            ['submit', 'ai-media', 202],
          ].every(([operation, provider, status]) => records.some((record) => (
            record.operation === operation && record.provider === provider && record.status === status
          )));
        } catch {
          return false;
        }
      });
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
      const records = log.trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: 'media_publish', provider: 'media', status: 201 }),
        expect.objectContaining({ operation: 'submit', provider: 'ai-media', status: 202 }),
      ]));
      for (const record of records) {
        expect(Object.keys(record).sort()).toEqual([
          'bytes', 'duration_ms', 'operation', 'provider', 'request_id', 'status', 'timestamp',
        ]);
      }
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      try { unlinkSync(logFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('queues work beyond the execution limit and starts it when a slot is released', async () => {
    const upstreamResponses = [];
    const upstream = createServer((_request, response) => {
      upstreamResponses.push(response);
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
        LUMINA_GATEWAY_MAX_REQUESTS_PER_WINDOW: '20',
        LUMINA_GATEWAY_MAX_PENDING_TASKS_PER_SOURCE: '3',
        LUMINA_GATEWAY_MAX_CONCURRENT_TASKS: '1',
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
      const firstSubmission = submit('first');
      await expect.poll(() => upstreamResponses.length).toBe(1);

      const second = await submit('second');
      expect(second.status).toBe(202);
      expect(await second.json()).toMatchObject({ status: 'queued' });
      const third = await submit('third');
      expect(third.status).toBe(202);
      expect(await third.json()).toMatchObject({ status: 'queued' });

      const rejected = await submit('fourth');
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get('retry-after')).toBe('60');
      expect(await rejected.json()).toMatchObject({
        error: 'queue_capacity_exceeded',
        request_id: expect.any(String),
      });

      upstreamResponses[0].writeHead(200, { 'content-type': 'application/json' });
      upstreamResponses[0].end(JSON.stringify({ data: [{ b64_json: 'Zmlyc3Q=' }] }));
      expect(await (await firstSubmission).json()).toMatchObject({ status: 'succeeded' });

      await expect.poll(() => upstreamResponses.length).toBe(2);
      upstreamResponses[1].writeHead(200, { 'content-type': 'application/json' });
      upstreamResponses[1].end(JSON.stringify({ data: [{ b64_json: 'c2Vjb25k' }] }));
      await expect.poll(() => upstreamResponses.length).toBe(3);
      upstreamResponses[2].writeHead(200, { 'content-type': 'application/json' });
      upstreamResponses[2].end(JSON.stringify({ data: [{ b64_json: 'dGhpcmQ=' }] }));
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('fails a persisted queued task after restart without replaying a billable submission', async () => {
    let upstreamCalls = 0;
    const upstream = createServer((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(500);
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const stateFile = join(tmpdir(), `lumina-gateway-queued-restart-${process.pid}-${Date.now()}.json`);
    const timestamp = Date.now();
    writeFileSync(stateFile, JSON.stringify([{
      id: 'job-queued-restart',
      provider: 'ai-media',
      status: 'queued',
      sourceId: 'a'.repeat(64),
      sessionBinding: 'b'.repeat(64),
      createdAt: timestamp,
      updatedAt: timestamp,
    }]), 'utf8');
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
      const persisted = JSON.parse(await readFileEventually(stateFile));
      expect(persisted).toEqual([expect.objectContaining({
        id: 'job-queued-restart',
        status: 'failed',
        errorCode: 'submission_interrupted',
        terminalAt: expect.any(Number),
      })]);
      expect(upstreamCalls).toBe(0);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('serves a completed image result after a Gateway restart before Runtime import', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ image: { b64_json: 'cmVzdGFydC1yZXN1bHQ=' } }] }));
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-gateway-result-restart-${process.pid}-${Date.now()}.json`);
    const gatewayEnvironment = {
      ...process.env,
      LUMINA_GATEWAY_PORT: String(gatewayPort),
      LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
      LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
      LUMINA_GATEWAY_STATE_FILE: stateFile,
    };
    const startGateway = () => spawn(process.execPath, ['gateway/server.mjs'], {
      env: gatewayEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let gateway = startGateway();

    try {
      await waitForReady(gateway);
      const submitted = await fetch(`${canonicalOrigin}/api/generation/jobs`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer restart-result-key',
          origin: canonicalOrigin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'submit',
          provider: 'ai-media',
          projectId: 'project-restart',
          projectRevision: 'revision-restart',
          request: { model: 'ai-media/gpt-image-2', prompt: 'survive restart', size: '1K' },
        }),
      });
      const sessionCookie = submitted.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      const task = await submitted.json();
      expect(task).toMatchObject({ status: 'succeeded' });

      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      gateway = startGateway();
      await waitForReady(gateway);

      const result = await fetch(`${canonicalOrigin}/api/generation/jobs/${task.job_id}/result`, {
        headers: { origin: canonicalOrigin, cookie: sessionCookie },
      });
      expect(result.status).toBe(200);
      expect(result.headers.get('content-type')).toContain('image/png');
      expect(await result.text()).toBe('restart-result');
    } finally {
      if (gateway.exitCode === null) {
        gateway.kill();
        await new Promise((resolve) => gateway.once('exit', resolve));
      }
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      try { rmSync(`${stateFile}.results`, { recursive: true, force: true }); } catch { /* test cleanup is best effort */ }
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

  it('proxies constrained image provider requests and materializes remote image results', async () => {
    const observed = [];
    const upstream = createServer(async (request, response) => {
      const body = request.method === 'POST' ? await readRequestBody(request) : '';
      observed.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body,
      });
      if (request.url === '/v1/images/generations' && request.method === 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${upstream.address().port}/result.png` }] }));
        return;
      }
      if (request.url === '/v1/images/edits' && request.method === 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }));
        return;
      }
      if (request.url === '/result.png' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('provider-image');
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const upstreamPort = await listen(upstream);
    const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
    const baseUrl = `${upstreamOrigin}/v1`;
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-image-provider-proxy-${process.pid}-${Date.now()}.json`);
    const logFile = join(tmpdir(), `lumina-image-provider-proxy-${process.pid}-${Date.now()}.jsonl`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: upstreamOrigin,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
        LUMINA_GATEWAY_LOG_FILE: logFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const gatewayHeaders = (targetUrl, method, contentType) => ({
      authorization: 'Bearer ephemeral-provider-key',
      origin: canonicalOrigin,
      'x-lumina-image-protocol': 'openai-images',
      'x-lumina-image-base-url': encodeURIComponent(baseUrl),
      'x-lumina-image-target-url': encodeURIComponent(targetUrl),
      'x-lumina-image-method': method,
      ...(contentType ? { 'content-type': contentType } : {}),
    });

    try {
      await waitForReady(gateway);
      const generated = await fetch(`${canonicalOrigin}/api/generation/image-provider`, {
        method: 'POST',
        headers: gatewayHeaders(`${baseUrl}/images/generations`, 'POST', 'application/json'),
        body: JSON.stringify({ model: 'gpt-image-1', prompt: 'test' }),
      });
      expect(generated.status).toBe(200);
      const sessionCookie = generated.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      const generatedPayload = await generated.json();
      expect(generatedPayload.data[0].url).toBe(`${upstreamOrigin}/result.png`);
      expect(observed[0]).toMatchObject({
        url: '/v1/images/generations',
        method: 'POST',
        authorization: 'Bearer ephemeral-provider-key',
        contentType: 'application/json',
      });

      const form = new FormData();
      form.append('model', 'gpt-image-1');
      form.append('prompt', 'edit');
      form.append('image', new Blob(['reference'], { type: 'image/png' }), 'reference.png');
      const edited = await fetch(`${canonicalOrigin}/api/generation/image-provider`, {
        method: 'POST',
        headers: { ...gatewayHeaders(`${baseUrl}/images/edits`, 'POST'), cookie: sessionCookie },
        body: form,
      });
      expect(edited.status).toBe(200);
      expect(observed[1].contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(observed[1].body).toContain('filename="reference.png"');

      const materialized = await fetch(`${canonicalOrigin}/api/generation/image-provider/result`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ephemeral-provider-key',
          origin: canonicalOrigin,
          cookie: sessionCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          protocol: 'openai-images',
          base_url: baseUrl,
          source: `${upstreamOrigin}/result.png`,
        }),
      });
      expect(materialized.status).toBe(201);
      const grant = await materialized.json();
      expect(grant.url).toMatch(new RegExp(`^${canonicalOrigin.replaceAll('.', '\\.')}/api/generation/media/`));
      expect(observed[2]).toMatchObject({
        url: '/result.png',
        method: 'GET',
        authorization: 'Bearer ephemeral-provider-key',
      });
      const result = await fetch(grant.url);
      expect(result.status).toBe(200);
      expect(result.headers.get('content-type')).toBe('image/png');
      expect(await result.text()).toBe('provider-image');

      const repeated = await fetch(`${canonicalOrigin}/api/generation/image-provider/result`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ephemeral-provider-key',
          origin: canonicalOrigin,
          cookie: sessionCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          protocol: 'openai-images',
          base_url: baseUrl,
          source: `${upstreamOrigin}/result.png`,
        }),
      });
      expect(repeated.status).toBe(403);
      expect(await repeated.json()).toMatchObject({ error: 'image_provider_result_not_authorized' });

      const unobserved = await fetch(`${canonicalOrigin}/api/generation/image-provider/result`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ephemeral-provider-key',
          origin: canonicalOrigin,
          cookie: sessionCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          protocol: 'openai-images',
          base_url: baseUrl,
          source: `${upstreamOrigin}/unobserved.png`,
        }),
      });
      expect(unobserved.status).toBe(403);
      expect(await unobserved.json()).toMatchObject({ error: 'image_provider_result_not_authorized' });

      const rejected = await fetch(`${canonicalOrigin}/api/generation/image-provider`, {
        method: 'POST',
        headers: { ...gatewayHeaders(`${upstreamOrigin}/admin/delete`, 'POST', 'application/json'), cookie: sessionCookie },
        body: '{}',
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: 'invalid_image_provider_request' });
      expect(observed).toHaveLength(3);
      const logText = await readFileEventually(logFile);
      const records = logText.trim().split('\n').map((line) => JSON.parse(line));
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: 'image_provider_proxy', provider: 'openai-images', status: 200 }),
        expect.objectContaining({ operation: 'image_provider_result', provider: 'openai-images', status: 201 }),
      ]));
      expect(logText).not.toContain('ephemeral-provider-key');
      expect(logText).not.toContain(upstreamOrigin);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      try { unlinkSync(logFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 20000);

  it('accepts 50 MiB URL and base64 image results and permanently rejects one byte more', async () => {
    const maximumResultBytes = 50 * 1024 * 1024;
    const maximumProviderResponseBytes = Math.ceil(maximumResultBytes / 3) * 4 + 1024 * 1024;
    const providerResponseReservationBytes = maximumProviderResponseBytes * 3 + maximumResultBytes;
    const binaryChunk = Buffer.alloc(1024 * 1024, 7);
    const base64ChunkBytes = 3 * 1024 * 1024;
    const base64Chunk = Buffer.alloc(base64ChunkBytes).toString('base64');
    let providerPolls = 0;
    let simultaneousFullBase64Results = 0;
    let maximumSimultaneousFullBase64Results = 0;
    let signalFullBase64ResultsReady;
    const fullBase64ResultsReady = new Promise((resolve) => {
      signalFullBase64ResultsReady = resolve;
    });
    const writeChunk = async (response, chunk) => {
      if (!response.write(chunk)) await once(response, 'drain');
    };
    const writeBase64Result = async (response, byteLength, taskId) => {
      if (byteLength === maximumResultBytes) {
        simultaneousFullBase64Results += 1;
        maximumSimultaneousFullBase64Results = Math.max(
          maximumSimultaneousFullBase64Results,
          simultaneousFullBase64Results,
        );
        if (simultaneousFullBase64Results === 2) signalFullBase64ResultsReady();
        await fullBase64ResultsReady;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      await writeChunk(response, `{"id":"${taskId}","status":"completed","data":[{"image":{"b64_json":"`);
      const fullChunks = Math.floor(byteLength / base64ChunkBytes);
      for (let index = 0; index < fullChunks; index += 1) await writeChunk(response, base64Chunk);
      const remainder = byteLength - fullChunks * base64ChunkBytes;
      if (remainder) await writeChunk(response, Buffer.alloc(remainder).toString('base64'));
      response.end('","mime_type":"image/avif"}}]}');
      if (byteLength === maximumResultBytes) simultaneousFullBase64Results -= 1;
    };
    const upstream = createServer(async (request, response) => {
      if (request.url === '/v1/images/generations' && request.method === 'POST') {
        const body = JSON.parse(await readRequestBody(request));
        if (body.prompt === 'base64-50') {
          await writeBase64Result(response, maximumResultBytes, 'task-5050505050505050');
          return;
        }
        if (body.prompt === 'base64-50-plus-one') {
          await writeBase64Result(response, maximumResultBytes + 1, 'task-5151515151515151');
          return;
        }
        const resultName = body.prompt === 'url-50' ? 'result-50.webp' : 'result-50-plus-one.webp';
        const taskId = body.prompt === 'url-50' ? 'task-5252525252525252' : 'task-5353535353535353';
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: taskId,
          status: 'completed',
          data: [{ url: `http://127.0.0.1:${upstream.address().port}/${resultName}` }],
        }));
        return;
      }
      if (request.url === '/result-50.webp') {
        response.writeHead(200, { 'content-type': 'image/webp', 'content-length': maximumResultBytes });
        for (let index = 0; index < 50; index += 1) await writeChunk(response, binaryChunk);
        response.end();
        return;
      }
      if (request.url === '/result-50-plus-one.webp') {
        response.writeHead(200, {
          'content-type': 'image/webp',
          'content-length': maximumResultBytes + 1,
        });
        response.end();
        return;
      }
      if (request.url?.startsWith('/v1/images/tasks/')) {
        providerPolls += 1;
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(404).end();
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-result-boundary-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
        LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_RESIDENT_BYTES: String(providerResponseReservationBytes * 2),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let sessionCookie = '';
    const headers = () => ({
      authorization: 'Bearer boundary-test-key',
      origin: canonicalOrigin,
      'content-type': 'application/json',
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
    });
    const submit = async (prompt) => {
      const response = await fetch(`${canonicalOrigin}/api/generation/jobs`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          operation: 'submit', provider: 'ai-media', projectId: 'project-boundary', projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt, size: '4K' },
        }),
      });
      sessionCookie ||= response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      return await response.json();
    };
    const readResult = async (job, expectedMime) => {
      const resultPath = `${stateFile}.results/${job.job_id}.result`;
      const response = await fetch(`${canonicalOrigin}/api/generation/jobs/${job.job_id}/result`, {
        headers: headers(),
      });
      expect(response.status, `result request failed for ${job.job_id}`).toBe(200);
      expect(response.headers.get('content-type')).toContain(expectedMime);
      expect(Number(response.headers.get('content-length'))).toBe(maximumResultBytes);
      let byteLength = 0;
      for await (const chunk of response.body) byteLength += chunk.length;
      expect(byteLength).toBe(maximumResultBytes);
      expect(statSync(resultPath).size).toBe(maximumResultBytes);
    };

    try {
      await waitForReady(gateway);
      const urlResult = await submit('url-50');
      expect(urlResult.status).toBe('succeeded');
      await readResult(urlResult, 'image/webp');

      const base64Results = await Promise.all([submit('base64-50'), submit('base64-50')]);
      expect(base64Results.every((result) => result.status === 'succeeded')).toBe(true);
      expect(maximumSimultaneousFullBase64Results).toBe(2);
      for (const base64Result of base64Results) await readResult(base64Result, 'image/avif');

      for (const prompt of ['url-50-plus-one', 'base64-50-plus-one']) {
        const rejected = await submit(prompt);
        expect(rejected).toMatchObject({
          status: 'failed',
          error: 'The image provider returned no usable result.',
        });
        const polled = await fetch(`${canonicalOrigin}/api/generation/jobs/${rejected.job_id}`, {
          method: 'POST', headers: headers(), body: JSON.stringify({ operation: 'poll' }),
        });
        expect(await polled.json()).toMatchObject({ status: 'failed' });
      }
      expect(providerPolls).toBe(0);
      expect(readFileSync(stateFile, 'utf8')).not.toContain('boundary-test-key');
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      rmSync(stateFile, { force: true });
      rmSync(`${stateFile}.results`, { recursive: true, force: true });
      upstream.closeAllConnections();
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 120000);

  it('atomically claims image results and bounds result requests and resident response bytes', async () => {
    let resultFetches = 0;
    let heldResultResponse;
    let releaseHeldResult;
    let recoverableAttempts = 0;
    let abortAttempts = 0;
    let heldAbortResponse;
    let releaseHeldAbort;
    const upstream = createServer(async (request, response) => {
      if (request.url === '/v1/images/generations' && request.method === 'POST') {
        const payload = JSON.parse(await readRequestBody(request));
        const resultName = payload.prompt === 'large'
          ? 'large.png'
          : payload.prompt === 'invalid media'
            ? 'invalid.txt'
          : payload.prompt === 'recoverable'
            ? 'recoverable.png'
            : payload.prompt === 'oversized metadata'
              ? 'metadata.png'
              : payload.prompt === 'abortable'
                ? 'abortable.png'
              : 'concurrent.png';
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${upstream.address().port}/${resultName}` }] }));
        return;
      }
      if (request.url === '/concurrent.png') {
        resultFetches += 1;
        if (resultFetches === 1) {
          heldResultResponse = response;
          await new Promise((resolve) => { releaseHeldResult = resolve; });
        }
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('provider-image');
        return;
      }
      if (request.url === '/recoverable.png') {
        recoverableAttempts += 1;
        if (recoverableAttempts === 1) {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end('{}');
          return;
        }
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('recovered-image');
        return;
      }
      if (request.url === '/abortable.png') {
        abortAttempts += 1;
        if (abortAttempts === 1) {
          heldAbortResponse = response;
          await new Promise((resolve) => { releaseHeldAbort = resolve; });
        }
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('abortable-image');
        return;
      }
      if (request.url === '/large.png') {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': '1024' });
        response.end(Buffer.alloc(1024, 1));
        return;
      }
      if (request.url === '/invalid.txt') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('not an image');
        return;
      }
      if (request.url === '/metadata.png') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('metadata-image');
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const upstreamPort = await listen(upstream);
    const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
    const baseUrl = `${upstreamOrigin}/v1`;
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-image-result-capacity-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: upstreamOrigin,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
        LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_CONCURRENT_REQUESTS: '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const proxyHeaders = {
      authorization: 'Bearer result-key',
      origin: canonicalOrigin,
      'content-type': 'application/json',
      'x-lumina-image-protocol': 'openai-images',
      'x-lumina-image-base-url': encodeURIComponent(baseUrl),
      'x-lumina-image-target-url': encodeURIComponent(`${baseUrl}/images/generations`),
      'x-lumina-image-method': 'POST',
    };
    let sessionCookie = '';
    const register = async (prompt) => {
      const response = await fetch(`${canonicalOrigin}/api/generation/image-provider`, {
        method: 'POST',
        headers: { ...proxyHeaders, ...(sessionCookie ? { cookie: sessionCookie } : {}) },
        body: JSON.stringify({ model: 'gpt-image-1', prompt }),
      });
      sessionCookie ||= response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      expect(response.status).toBe(200);
      return (await response.json()).data[0].url;
    };
    const materialize = (source, extra = {}, signal) => fetch(`${canonicalOrigin}/api/generation/image-provider/result`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer result-key',
        origin: canonicalOrigin,
        cookie: sessionCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ protocol: 'openai-images', base_url: baseUrl, source, ...extra }),
      ...(signal ? { signal } : {}),
    });

    try {
      await waitForReady(gateway);
      const concurrentSource = await register('concurrent');
      const first = materialize(concurrentSource);
      await expect.poll(() => resultFetches).toBe(1);
      const second = materialize(concurrentSource);
      await new Promise((resolve) => setTimeout(resolve, 75));
      const fetchesBeforeRelease = resultFetches;
      releaseHeldResult?.();
      const concurrentStatuses = [(await first).status, (await second).status].sort();
      expect(fetchesBeforeRelease).toBe(1);
      expect(concurrentStatuses).toEqual([201, 403]);

      const recoverableSource = await register('recoverable');
      expect((await materialize(recoverableSource)).status).toBe(502);
      expect((await materialize(recoverableSource)).status).toBe(201);
      expect(recoverableAttempts).toBe(2);

      const abortableSource = await register('abortable');
      const abortController = new AbortController();
      const abandonedResult = materialize(abortableSource, {}, abortController.signal);
      await expect.poll(() => abortAttempts).toBe(1);
      abortController.abort();
      await abandonedResult.catch(() => undefined);
      releaseHeldAbort?.();
      expect((await materialize(abortableSource)).status).toBe(201);
      expect(abortAttempts).toBe(2);

      const metadataSource = await register('oversized metadata');
      const oversizedMetadata = await materialize(metadataSource, { padding: 'x'.repeat(40 * 1024) });
      expect(oversizedMetadata.status).toBe(413);
      expect(await oversizedMetadata.json()).toMatchObject({ error: 'request_too_large' });

      const invalidSource = await register('invalid media');
      const invalidResult = await materialize(invalidSource);
      expect(invalidResult.status).toBe(502);
      expect(await invalidResult.json()).toMatchObject({ error: 'invalid_provider_result' });

    } finally {
      releaseHeldResult?.();
      releaseHeldAbort?.();
      heldResultResponse?.end();
      heldAbortResponse?.end();
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      upstream.closeAllConnections();
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 30000);

  it('does not evict an active result claim when a full capability set re-registers the same source', async () => {
    let resultFetches = 0;
    let releaseHeldResult;
    const upstream = createServer(async (request, response) => {
      if (request.url === '/v1/images/generations' && request.method === 'POST') {
        const payload = JSON.parse(await readRequestBody(request));
        const sources = payload.prompt === 'refresh'
          ? [`http://127.0.0.1:${upstream.address().port}/held-capacity.png`]
          : Array.from({ length: 32 }, (_, index) => {
            const suffix = payload.prompt === 'batch-0' && index === 0
              ? 'held-capacity.png'
              : `${payload.prompt}-${index}.png`;
            return `http://127.0.0.1:${upstream.address().port}/${suffix}`;
          });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: sources.map((url) => ({ url })) }));
        return;
      }
      if (request.url === '/held-capacity.png') {
        resultFetches += 1;
        if (resultFetches === 1) {
          await new Promise((resolve) => { releaseHeldResult = resolve; });
        }
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('capacity-result');
        return;
      }
      response.writeHead(404).end();
    });
    const upstreamPort = await listen(upstream);
    const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
    const baseUrl = `${upstreamOrigin}/v1`;
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-image-result-claim-capacity-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: upstreamOrigin,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const proxyHeaders = {
      authorization: 'Bearer result-key',
      origin: canonicalOrigin,
      'content-type': 'application/json',
      'x-lumina-image-protocol': 'openai-images',
      'x-lumina-image-base-url': encodeURIComponent(baseUrl),
      'x-lumina-image-target-url': encodeURIComponent(`${baseUrl}/images/generations`),
      'x-lumina-image-method': 'POST',
    };
    let sessionCookie = '';
    const register = async (prompt) => {
      const response = await fetch(`${canonicalOrigin}/api/generation/image-provider`, {
        method: 'POST',
        headers: { ...proxyHeaders, ...(sessionCookie ? { cookie: sessionCookie } : {}) },
        body: JSON.stringify({ model: 'gpt-image-1', prompt }),
      });
      sessionCookie ||= response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      expect(response.status).toBe(200);
      return response.json();
    };
    const materialize = (source) => fetch(`${canonicalOrigin}/api/generation/image-provider/result`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer result-key',
        origin: canonicalOrigin,
        cookie: sessionCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ protocol: 'openai-images', base_url: baseUrl, source }),
    });

    try {
      await waitForReady(gateway);
      const firstBatch = await register('batch-0');
      const claimedSource = firstBatch.data[0].url;
      for (let batch = 1; batch < 8; batch += 1) await register(`batch-${batch}`);

      const first = materialize(claimedSource);
      await expect.poll(() => resultFetches).toBe(1);
      await register('refresh');
      const second = materialize(claimedSource);
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(resultFetches).toBe(1);
      releaseHeldResult?.();
      expect((await first).status).toBe(201);
      expect((await second).status).toBe(403);
    } finally {
      releaseHeldResult?.();
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      upstream.closeAllConnections();
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 30000);

  it('coalesces concurrent managed polls so a late provider failure cannot overwrite success', async () => {
    let pollCalls = 0;
    let releaseSuccessfulPoll;
    let releaseLateFailure;
    const upstream = createServer(async (request, response) => {
      if (request.url === '/v1/images/generations' && request.method === 'POST') {
        await readRequestBody(request);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ task_id: 'task-0123456789abcdef' }));
        return;
      }
      if (request.url === '/v1/images/tasks/task-0123456789abcdef?view=summary' && request.method === 'GET') {
        pollCalls += 1;
        if (pollCalls === 1) {
          await new Promise((resolve) => { releaseSuccessfulPoll = resolve; });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            status: 'succeeded',
            data: [{ b64_json: 'Y29uY3VycmVudC1wb2xsLXJlc3VsdA==' }],
          }));
          return;
        }
        await new Promise((resolve) => { releaseLateFailure = resolve; });
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'late provider failure' } }));
        return;
      }
      response.writeHead(404).end();
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-managed-poll-race-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const headers = {
      authorization: 'Bearer managed-poll-key',
      origin: canonicalOrigin,
      'content-type': 'application/json',
    };

    try {
      await waitForReady(gateway);
      const submitted = await fetch(`${canonicalOrigin}/api/generation/jobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operation: 'submit',
          provider: 'ai-media',
          projectId: 'project-poll-race',
          projectRevision: 'revision-poll-race',
          request: { model: 'ai-media/gpt-image-2', prompt: 'poll once', size: '1K' },
        }),
      });
      const task = await submitted.json();
      expect(task.status).toBe('running');
      const sessionCookie = submitted.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      const poll = () => fetch(`${canonicalOrigin}/api/generation/jobs/${task.job_id}`, {
        method: 'POST',
        headers: { ...headers, cookie: sessionCookie },
        body: JSON.stringify({ operation: 'poll' }),
      });

      const first = poll();
      await expect.poll(() => pollCalls).toBe(1);
      const second = poll();
      await new Promise((resolve) => setTimeout(resolve, 75));
      const callsBeforeRelease = pollCalls;
      releaseSuccessfulPoll?.();
      const firstStatus = await (await first).json();
      releaseLateFailure?.();
      const secondStatus = await (await second).json();
      expect(callsBeforeRelease).toBe(1);
      expect(firstStatus).toMatchObject({ status: 'succeeded' });
      expect(secondStatus).toMatchObject({ status: 'succeeded' });

      const finalStatus = await (await poll()).json();
      expect(finalStatus).toMatchObject({ status: 'succeeded' });
      expect(pollCalls).toBe(1);
    } finally {
      releaseSuccessfulPoll?.();
      releaseLateFailure?.();
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      upstream.closeAllConnections();
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 30000);

  it('keeps managed jobs recoverable when result media transport fails and re-polls only the original task', async () => {
    let submissions = 0;
    let immediatePolls = 0;
    let deferredPolls = 0;
    let immediateDownloads = 0;
    let deferredDownloads = 0;
    const upstream = createServer(async (request, response) => {
      if (request.url === '/v1/images/generations' && request.method === 'POST') {
        submissions += 1;
        const payload = JSON.parse(await readRequestBody(request));
        response.writeHead(200, { 'content-type': 'application/json' });
        if (payload.prompt === 'immediate result recovery') {
          response.end(JSON.stringify({
            task_id: 'task-aaaaaaaaaaaaaaaa',
            data: [{ url: `http://127.0.0.1:${upstream.address().port}/immediate-recovery.png` }],
          }));
        } else {
          response.end(JSON.stringify({ task_id: 'task-bbbbbbbbbbbbbbbb' }));
        }
        return;
      }
      if (request.url === '/v1/images/tasks/task-aaaaaaaaaaaaaaaa?view=summary') {
        immediatePolls += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          status: 'succeeded',
          data: [{ url: `http://127.0.0.1:${upstream.address().port}/immediate-recovery.png` }],
        }));
        return;
      }
      if (request.url === '/v1/images/tasks/task-bbbbbbbbbbbbbbbb?view=summary') {
        deferredPolls += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          status: 'succeeded',
          data: [{ url: `http://127.0.0.1:${upstream.address().port}/deferred-recovery.png` }],
        }));
        return;
      }
      if (request.url === '/immediate-recovery.png') {
        immediateDownloads += 1;
        if (immediateDownloads === 1) {
          response.destroy();
          return;
        }
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('immediate-recovered');
        return;
      }
      if (request.url === '/deferred-recovery.png') {
        deferredDownloads += 1;
        if (deferredDownloads === 1) {
          response.destroy();
          return;
        }
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('deferred-recovered');
        return;
      }
      response.writeHead(404).end();
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-managed-result-recovery-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
        LUMINA_GATEWAY_POLL_RETRY_BASE_DELAY_MS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const headers = {
      authorization: 'Bearer managed-result-key',
      origin: canonicalOrigin,
      'content-type': 'application/json',
    };
    let sessionCookie = '';
    const submit = async (prompt) => {
      const response = await fetch(`${canonicalOrigin}/api/generation/jobs`, {
        method: 'POST',
        headers: { ...headers, ...(sessionCookie ? { cookie: sessionCookie } : {}) },
        body: JSON.stringify({
          operation: 'submit',
          provider: 'ai-media',
          projectId: 'project-result-recovery',
          projectRevision: 'revision-result-recovery',
          request: { model: 'ai-media/gpt-image-2', prompt, size: '1K' },
        }),
      });
      sessionCookie ||= response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      return response.json();
    };
    const poll = async (jobId) => {
      const response = await fetch(`${canonicalOrigin}/api/generation/jobs/${jobId}`, {
        method: 'POST',
        headers: { ...headers, cookie: sessionCookie },
        body: JSON.stringify({ operation: 'poll' }),
      });
      return response.json();
    };
    const waitForRetry = async (status) => {
      const nextRetryAt = status.recovery?.next_retry_at;
      if (typeof nextRetryAt === 'number') {
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, nextRetryAt - Date.now() + 1)));
      }
    };

    try {
      await waitForReady(gateway);
      const immediate = await submit('immediate result recovery');
      expect(immediate).toMatchObject({ status: 'running' });
      const immediateStatus = await poll(immediate.job_id);
      await waitForRetry(immediateStatus);
      const immediateRecovered = immediateStatus.status === 'succeeded'
        ? immediateStatus : await poll(immediate.job_id);
      expect(immediateRecovered).toMatchObject({ status: 'succeeded' });

      const deferred = await submit('deferred result recovery');
      expect(deferred.status).toBe('running');
      const deferredFailure = await poll(deferred.job_id);
      expect(deferredFailure).toMatchObject({
        status: 'running',
        recovery: { retry_count: 1, requires_manual_requery: false },
      });
      await waitForRetry(deferredFailure);
      const deferredRecovered = await poll(deferred.job_id);
      expect(deferredRecovered).toMatchObject({ status: 'succeeded' });

      expect({ submissions, immediatePolls, deferredPolls, immediateDownloads, deferredDownloads }).toEqual({
        submissions: 2,
        immediatePolls: 1,
        deferredPolls: 2,
        immediateDownloads: 2,
        deferredDownloads: 2,
      });
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      upstream.closeAllConnections();
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 30000);

  it('enforces image provider proxy concurrency and resident request-body budgets', async () => {
    const maximumResultBytes = 50 * 1024 * 1024;
    const maximumProviderResponseBytes = Math.ceil(maximumResultBytes / 3) * 4 + 1024 * 1024;
    const providerResponseReservationBytes = maximumProviderResponseBytes * 3 + maximumResultBytes;
    const runScenario = async (environment, firstBody, blockedBody) => {
      const upstreamResponses = [];
      const upstream = createServer((_request, response) => {
        upstreamResponses.push(response);
      });
      const upstreamPort = await listen(upstream);
      const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
      const baseUrl = `${upstreamOrigin}/v1`;
      const probe = createServer();
      const gatewayPort = await listen(probe);
      await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
      const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
      const stateFile = join(tmpdir(), `lumina-image-provider-capacity-${process.pid}-${Date.now()}-${Math.random()}.json`);
      const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
        env: {
          ...process.env,
          NODE_ENV: 'development',
          LUMINA_GATEWAY_PORT: String(gatewayPort),
          LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
          LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: upstreamOrigin,
          LUMINA_GATEWAY_STATE_FILE: stateFile,
          ...environment,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const send = (body) => fetch(`${canonicalOrigin}/api/generation/image-provider`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer capacity-key',
          origin: canonicalOrigin,
          'content-type': 'application/json',
          'x-lumina-image-protocol': 'openai-images',
          'x-lumina-image-base-url': encodeURIComponent(baseUrl),
          'x-lumina-image-target-url': encodeURIComponent(`${baseUrl}/images/generations`),
          'x-lumina-image-method': 'POST',
        },
        body,
      });

      try {
        await waitForReady(gateway);
        const first = send(firstBody);
        await expect.poll(() => upstreamResponses.length).toBe(1);
        const blocked = await send(blockedBody);
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
        expect(await blocked.json()).toMatchObject({ error: 'image_provider_proxy_capacity_exceeded' });
        expect(upstreamResponses).toHaveLength(1);

        upstreamResponses[0].writeHead(200, { 'content-type': 'application/json' });
        upstreamResponses[0].end('{}');
        expect((await first).status).toBe(200);

        const afterRelease = send('{}');
        await expect.poll(() => upstreamResponses.length).toBe(2);
        upstreamResponses[1].writeHead(200, { 'content-type': 'application/json' });
        upstreamResponses[1].end('{}');
        expect((await afterRelease).status).toBe(200);
      } finally {
        gateway.kill();
        await new Promise((resolve) => gateway.once('exit', resolve));
        try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
        upstream.closeAllConnections();
        await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
      }
    };

    await runScenario({
      LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_CONCURRENT_REQUESTS: '1',
    }, '{"one":1}', '{"two":2}');
    const firstBody = '{"first":1}';
    const blockedBody = '{"second":2}';
    await runScenario({
      LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_CONCURRENT_REQUESTS: '2',
      LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_RESIDENT_BYTES: String(
        providerResponseReservationBytes + Buffer.byteLength(firstBody) + Buffer.byteLength(blockedBody),
      ),
    }, firstBody, blockedBody);
  }, 30000);

  it('accounts for the aggregation copy of a chunked image provider body', async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const upstreamPort = await listen(upstream);
    const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
    const baseUrl = `${upstreamOrigin}/v1`;
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-image-provider-chunked-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: upstreamOrigin,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
        LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_CONCURRENT_REQUESTS: '1',
        LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_RESIDENT_BYTES: '20',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const status = await new Promise((resolve, reject) => {
        const request = httpRequest(`${canonicalOrigin}/api/generation/image-provider`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer chunked-key',
            origin: canonicalOrigin,
            'content-type': 'application/json',
            'x-lumina-image-protocol': 'openai-images',
            'x-lumina-image-base-url': encodeURIComponent(baseUrl),
            'x-lumina-image-target-url': encodeURIComponent(`${baseUrl}/images/generations`),
            'x-lumina-image-method': 'POST',
          },
        }, (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        });
        request.once('error', reject);
        request.write('{"x":');
        setTimeout(() => request.end('123456}'), 25);
      });
      expect(status).toBe(429);
      expect(upstreamRequests).toBe(0);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 15000);

  it('forwards five thirty-mebibyte image references without the JSON body limit becoming the aggregate limit', async () => {
    let multipart;
    let idempotencyKey;
    const upstream = createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/images/edits') {
        idempotencyKey = request.headers['idempotency-key'];
        multipart = await inspectMultipartRequest(request);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: 'bXVsdGktcmVmLXJlc3VsdA==' }] }));
        return;
      }
      response.writeHead(404).end();
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-large-reference-state-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const mediaBytes = Buffer.alloc(30 * 1024 * 1024, 7);
      const referenceMediaKeys = [];
      let sessionCookie = '';
      for (let index = 0; index < 5; index += 1) {
        const uploaded = await fetch(`${canonicalOrigin}/api/generation/media`, {
          method: 'POST',
          headers: {
            origin: canonicalOrigin,
            ...(sessionCookie ? { cookie: sessionCookie } : {}),
            'content-type': index === 4 ? 'image/jpeg' : 'image/png',
            'x-lumina-media-operation': 'publish',
            'x-lumina-media-kind': 'image',
            'x-lumina-media-provider': 'ai-media',
          },
          body: mediaBytes,
        });
        expect(uploaded.status).toBe(201);
        sessionCookie ||= uploaded.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
        referenceMediaKeys.push((await uploaded.json()).key);
      }

      const submitted = await fetch(`${canonicalOrigin}/api/generation/jobs`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer large-reference-key',
          origin: canonicalOrigin,
          cookie: sessionCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'submit',
          provider: 'ai-media',
          projectId: 'project-large',
          projectRevision: 'revision-large',
          request: {
            model: 'ai-media/gpt-image-2',
            prompt: 'five large references',
            size: '4K',
            referenceMediaKeys,
          },
        }),
      });
      expect(await submitted.json()).toMatchObject({ status: 'succeeded' });
      expect(multipart).toMatchObject({ fileCount: 5 });
      expect(multipart.byteCount).toBeGreaterThan(150 * 1024 * 1024);
      expect(idempotencyKey).toMatch(/^opencanvas-image-[0-9a-f-]{36}$/i);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 60000);

  it('streams five forty-mebibyte text vision references through the provider JSON request', async () => {
    let receivedBytes = 0;
    let declaredBytes = 0;
    let receivedContentType = '';
    const upstream = createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        declaredBytes = Number(request.headers['content-length'] ?? 0);
        receivedContentType = String(request.headers['content-type'] ?? '');
        for await (const chunk of request) receivedBytes += chunk.length;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: 'five references received' } }] }));
        return;
      }
      response.writeHead(404).end();
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
    const stateFile = join(tmpdir(), `lumina-large-text-reference-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: upstreamOrigin,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const mediaBytes = Buffer.alloc(40 * 1024 * 1024, 7);
      const referenceMediaKeys = [];
      let sessionCookie = '';
      for (let index = 0; index < 5; index += 1) {
        const uploaded = await fetch(`${canonicalOrigin}/api/generation/media`, {
          method: 'POST',
          headers: {
            origin: canonicalOrigin,
            ...(sessionCookie ? { cookie: sessionCookie } : {}),
            'content-type': index === 4 ? 'image/jpeg' : 'image/png',
            'x-lumina-media-operation': 'publish',
            'x-lumina-media-kind': 'image',
            'x-lumina-media-provider': 'text-reference',
          },
          body: mediaBytes,
        });
        expect(uploaded.status).toBe(201);
        sessionCookie ||= uploaded.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
        referenceMediaKeys.push((await uploaded.json()).key);
      }

      const response = await fetch(`${canonicalOrigin}/api/generation/text`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer large-text-reference-key',
          origin: canonicalOrigin,
          cookie: sessionCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'request',
          base_url: `${upstreamOrigin}/v1`,
          protocol: 'chat',
          reference_media_keys: referenceMediaKeys,
          request: {
            model: 'vision-text-model',
            messages: [{
              role: 'user',
              content: [
                ...referenceMediaKeys.map((_, index) => ({
                  type: 'image_url', image_url: { url: `lumina-media:${index}` },
                })),
                { type: 'text', text: 'compare these references' },
              ],
            }],
            stream: false,
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ choices: [{ message: { content: 'five references received' } }] });
      expect(receivedContentType).toBe('application/json');
      expect(receivedBytes).toBe(declaredBytes);
      expect(receivedBytes).toBeGreaterThan(266 * 1024 * 1024);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      upstream.closeAllConnections();
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 60000);

  it('keeps queued image references inside the resident media budget after client release', async () => {
    let releaseFirstRequest;
    let signalFirstRequestStarted;
    const firstRequestStarted = new Promise((resolve) => {
      signalFirstRequestStarted = resolve;
    });
    let upstreamRequestCount = 0;
    const upstream = createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/images/edits') {
        await inspectMultipartRequest(request);
        upstreamRequestCount += 1;
        if (upstreamRequestCount === 1) {
          signalFirstRequestStarted();
          await new Promise((resolve) => {
            releaseFirstRequest = resolve;
          });
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ image: { b64_json: 'cXVldWVkLXJlc3VsdA==' } }] }));
        return;
      }
      response.writeHead(404).end();
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-pinned-reference-state-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
        LUMINA_GATEWAY_MAX_MEDIA_BYTES: '16',
        LUMINA_GATEWAY_MAX_TEMPORARY_MEDIA_BYTES_PER_SESSION: '32',
        LUMINA_GATEWAY_MAX_TEMPORARY_MEDIA_BYTES: '32',
        LUMINA_GATEWAY_MAX_CONCURRENT_TASKS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let sessionCookie = '';
    const uploadReference = async (body) => {
      const response = await fetch(`${canonicalOrigin}/api/generation/media`, {
        method: 'POST',
        headers: {
          origin: canonicalOrigin,
          ...(sessionCookie ? { cookie: sessionCookie } : {}),
          'content-type': 'image/png',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-kind': 'image',
          'x-lumina-media-provider': 'ai-media',
        },
        body,
      });
      sessionCookie ||= response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      return response;
    };
    const submitReference = (key, revision) => fetch(`${canonicalOrigin}/api/generation/jobs`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer pinned-reference-key',
        origin: canonicalOrigin,
        cookie: sessionCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operation: 'submit',
        provider: 'ai-media',
        projectId: 'project-pinned',
        projectRevision: revision,
        request: {
          model: 'ai-media/gpt-image-2',
          prompt: `pinned reference ${revision}`,
          size: '1K',
          referenceMediaKeys: [key],
        },
      }),
    });
    const releaseReference = (key) => fetch(`${canonicalOrigin}/api/generation/media/${key}`, {
      method: 'DELETE',
      headers: { origin: canonicalOrigin, cookie: sessionCookie },
    });

    try {
      await waitForReady(gateway);
      const firstUpload = await uploadReference('1234567890abcdef');
      expect(firstUpload.status).toBe(201);
      const firstKey = (await firstUpload.json()).key;
      const firstSubmissionPromise = submitReference(firstKey, 'revision-1');
      await firstRequestStarted;
      expect((await releaseReference(firstKey)).status).toBe(204);

      const secondUpload = await uploadReference('fedcba0987654321');
      expect(secondUpload.status).toBe(201);
      const secondKey = (await secondUpload.json()).key;
      const secondSubmission = await submitReference(secondKey, 'revision-2');
      const secondTask = await secondSubmission.json();
      expect(secondTask).toMatchObject({ status: 'queued' });
      expect((await releaseReference(secondKey)).status).toBe(204);

      const capacityExceeded = await uploadReference('x');
      expect(capacityExceeded.status).toBe(429);
      expect(await capacityExceeded.json()).toMatchObject({
        error: 'temporary_media_capacity_exceeded',
      });

      releaseFirstRequest();
      const firstSubmission = await firstSubmissionPromise;
      expect(await firstSubmission.json()).toMatchObject({ status: 'succeeded' });

      let secondStatus;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const response = await fetch(`${canonicalOrigin}/api/generation/jobs/${secondTask.job_id}`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer pinned-reference-key',
            origin: canonicalOrigin,
            cookie: sessionCookie,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ operation: 'poll' }),
        });
        secondStatus = await response.json();
        if (secondStatus.status === 'succeeded') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(secondStatus).toMatchObject({ status: 'succeeded' });
    } finally {
      releaseFirstRequest?.();
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('proxies text and Seedance operations and materializes the video result on the canonical Origin', async () => {
    const calls = [];
    let deleteCalls = 0;
    const upstream = createServer(async (request, response) => {
      const body = request.method === 'POST' ? await readRequestBody(request) : '';
      calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'text-model' }] }));
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: 'described' } }] }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/v3/contents/generations/tasks') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          task_id: 'task-0123456789abcdef',
          id: 'task-fedcba9876543210',
          status: 'queued',
        }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/v3/contents/generations/tasks/task-0123456789abcdef') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'task-0123456789abcdef',
          status: 'succeeded',
          video_url: `http://127.0.0.1:${upstream.address().port}/results/video.mp4`,
          preview_image_url: `http://127.0.0.1:${upstream.address().port}/results/preview.jpg`,
          last_frame_image_url: `http://127.0.0.1:${upstream.address().port}/results/last-frame.jpg`,
          seed: 42,
        }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/v3/contents/generations/tasks/task-0011223344556677') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'task-0011223344556677',
          status: 'failed',
          error: { message: 'provider video failed' },
          request_id: 'request-video-failure-1',
        }));
        return;
      }
      if (request.method === 'DELETE' && request.url === '/api/v3/contents/generations/tasks/task-0123456789abcdef') {
        deleteCalls += 1;
        response.writeHead(deleteCalls === 1 ? 204 : 404, { 'content-type': 'application/json' });
        response.end(deleteCalls === 1 ? undefined : JSON.stringify({ message: 'not found' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/results/video.mp4') {
        response.writeHead(200, { 'content-type': 'video/mp4' });
        response.end('video-result');
        return;
      }
      if (request.method === 'GET' && request.url === '/results/preview.jpg') {
        response.writeHead(200, { 'content-type': 'image/jpeg' });
        response.end('preview-result');
        return;
      }
      if (request.method === 'GET' && request.url === '/results/last-frame.jpg') {
        response.writeHead(200, { 'content-type': 'image/jpeg' });
        response.end('last-frame-result');
        return;
      }
      response.writeHead(404).end();
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
    const stateFile = join(tmpdir(), `lumina-text-video-state-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: upstreamOrigin,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const jsonHeaders = {
        authorization: 'Bearer proxy-key',
        origin: canonicalOrigin,
        'content-type': 'application/json',
      };
      const models = await fetch(`${canonicalOrigin}/api/generation/text`, {
        method: 'POST', headers: jsonHeaders,
        body: JSON.stringify({ operation: 'models', base_url: `${upstreamOrigin}/v1` }),
      });
      expect(await models.json()).toEqual({ data: [{ id: 'text-model' }] });
      const sessionCookie = models.headers.get('set-cookie')?.split(';', 1)[0];

      const textMedia = await fetch(`${canonicalOrigin}/api/generation/media`, {
        method: 'POST',
        headers: {
          origin: canonicalOrigin,
          cookie: sessionCookie,
          'content-type': 'image/png',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-kind': 'image',
          'x-lumina-media-provider': 'text-reference',
        },
        body: 'text-reference-image',
      });
      const textMediaGrant = await textMedia.json();
      const textResponse = await fetch(`${canonicalOrigin}/api/generation/text`, {
        method: 'POST', headers: { ...jsonHeaders, cookie: sessionCookie },
        body: JSON.stringify({
          operation: 'request',
          base_url: `${upstreamOrigin}/v1`,
          protocol: 'chat',
          reference_media_keys: [textMediaGrant.key],
          request: {
            model: 'text-model',
            messages: [{ role: 'user', content: [
              { type: 'image_url', image_url: { url: 'lumina-media:0' } },
              { type: 'text', text: 'describe' },
            ] }],
            stream: false,
          },
        }),
      });
      expect(await textResponse.json()).toEqual({ choices: [{ message: { content: 'described' } }] });
      const forwardedText = JSON.parse(calls.find((call) => call.url === '/v1/chat/completions').body);
      expect(forwardedText.messages[0].content[0].image_url.url)
        .toBe('data:image/png;base64,dGV4dC1yZWZlcmVuY2UtaW1hZ2U=');

      const videoSubmit = await fetch(`${canonicalOrigin}/api/generation/video`, {
        method: 'POST', headers: { ...jsonHeaders, cookie: sessionCookie },
        body: JSON.stringify({
          operation: 'submit',
          base_url: upstreamOrigin,
          request: {
            model: 'doubao-seedance-2-0-260128',
            content: [{ type: 'text', text: 'a lantern' }],
            duration: 5,
          },
        }),
      });
      expect(await videoSubmit.json()).toEqual({ id: 'task-0123456789abcdef' });

      const videoPoll = await fetch(`${canonicalOrigin}/api/generation/video`, {
        method: 'POST', headers: { ...jsonHeaders, cookie: sessionCookie },
        body: JSON.stringify({
          operation: 'poll', base_url: upstreamOrigin, task_id: 'task-0123456789abcdef',
        }),
      });
      const videoPayload = await videoPoll.json();
      expect(videoPayload).toMatchObject({ status: 'succeeded', seed: 42 });
      expect(videoPayload.output_url).toMatch(new RegExp(`^${canonicalOrigin.replaceAll('.', '\\.')}/api/generation/media/`));
      expect(videoPayload.preview_url).toMatch(new RegExp(`^${canonicalOrigin.replaceAll('.', '\\.')}/api/generation/media/`));
      expect(videoPayload.last_frame_url).toMatch(new RegExp(`^${canonicalOrigin.replaceAll('.', '\\.')}/api/generation/media/`));
      const videoResult = await fetch(videoPayload.output_url);
      expect(videoResult.headers.get('content-type')).toContain('video/mp4');
      expect(await videoResult.text()).toBe('video-result');
      expect(await (await fetch(videoPayload.preview_url)).text()).toBe('preview-result');
      expect(await (await fetch(videoPayload.last_frame_url)).text()).toBe('last-frame-result');

      const failedVideoPoll = await fetch(`${canonicalOrigin}/api/generation/video`, {
        method: 'POST', headers: { ...jsonHeaders, cookie: sessionCookie },
        body: JSON.stringify({
          operation: 'poll', base_url: upstreamOrigin, task_id: 'task-0011223344556677',
        }),
      });
      expect(await failedVideoPoll.json()).toEqual({
        id: 'task-0011223344556677',
        status: 'failed',
        error: { message: 'provider video failed' },
        request_id: 'request-video-failure-1',
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const cancelled = await fetch(`${canonicalOrigin}/api/generation/video`, {
          method: 'POST', headers: { ...jsonHeaders, cookie: sessionCookie },
          body: JSON.stringify({
            operation: 'cancel', base_url: upstreamOrigin, task_id: 'task-0123456789abcdef',
          }),
        });
        expect(cancelled.status).toBe(200);
        expect(await cancelled.json()).toEqual({ deleted: true });
      }
      expect(calls.filter((call) => call.authorization === 'Bearer proxy-key').length).toBeGreaterThanOrEqual(6);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 15000);

  it('publishes FAL canvas references through private TOS delivery and deletes them on release', async () => {
    const tosRequests = [];
    const tos = createServer(async (request, response) => {
      tosRequests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: request.method === 'PUT' ? await readRequestBody(request) : '',
      });
      response.writeHead(request.method === 'DELETE' ? 204 : 200);
      response.end();
    });
    const tosPort = await listen(tos);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-fal-tos-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
        LUMINA_TOS_BUCKET: 'lumina-test',
        LUMINA_TOS_REGION: 'cn-beijing',
        LUMINA_TOS_ENDPOINT: `http://127.0.0.1:${tosPort}`,
        LUMINA_TOS_ACCESS_KEY: 'test-access-key',
        LUMINA_TOS_SECRET_KEY: 'test-secret-key',
        LUMINA_TOS_URL_TTL_SECONDS: '3600',
        LUMINA_TOS_FORCE_PATH_STYLE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const published = await fetch(`${canonicalOrigin}/api/generation/media`, {
        method: 'POST',
        headers: {
          origin: canonicalOrigin,
          'content-type': 'image/png',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-kind': 'image',
          'x-lumina-media-provider': 'fal-reference',
          'x-lumina-project-id': 'project-fal',
        },
        body: 'fal-reference-image',
      });
      expect(published.status).toBe(201);
      const sessionCookie = published.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      const grant = await published.json();
      expect(grant.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${tosPort}/lumina-test/`));
      expect(grant.url).toContain('X-Tos-Signature=');
      expect(grant.url).not.toContain('test-secret-key');
      expect(tosRequests[0]).toMatchObject({
        method: 'PUT',
        authorization: expect.stringMatching(/^TOS4-HMAC-SHA256 /),
        body: 'fal-reference-image',
      });

      const released = await fetch(`${canonicalOrigin}/api/generation/media/${grant.key}`, {
        method: 'DELETE',
        headers: { origin: canonicalOrigin, cookie: sessionCookie },
      });
      expect(released.status).toBe(204);
      expect(tosRequests[1]).toMatchObject({ method: 'DELETE' });
      expect(tosRequests[1].url).toBe(tosRequests[0].url);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => tos.close((error) => error ? reject(error) : resolve()));
    }
  }, 20000);

  it('bounds FAL reference uploads by the image limit and shared proxy capacity', async () => {
    const tosRequests = [];
    let holdNextUpload = false;
    let heldUploadResponse;
    const tos = createServer(async (request, response) => {
      let size = 0;
      for await (const chunk of request) size += chunk.length;
      tosRequests.push({ method: request.method, size });
      if (request.method === 'PUT' && holdNextUpload) {
        holdNextUpload = false;
        heldUploadResponse = response;
        return;
      }
      response.writeHead(request.method === 'DELETE' ? 204 : 200);
      response.end();
    });
    const tosPort = await listen(tos);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const canonicalOrigin = `http://127.0.0.1:${gatewayPort}`;
    const stateFile = join(tmpdir(), `lumina-fal-capacity-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: canonicalOrigin,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
        LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_CONCURRENT_REQUESTS: '2',
        LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_RESIDENT_BYTES: '64',
        LUMINA_TOS_BUCKET: 'lumina-test',
        LUMINA_TOS_REGION: 'cn-beijing',
        LUMINA_TOS_ENDPOINT: `http://127.0.0.1:${tosPort}`,
        LUMINA_TOS_ACCESS_KEY: 'test-access-key',
        LUMINA_TOS_SECRET_KEY: 'test-secret-key',
        LUMINA_TOS_URL_TTL_SECONDS: '3600',
        LUMINA_TOS_FORCE_PATH_STYLE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let sessionCookie = '';
    const upload = async (body, signal) => {
      const response = await fetch(`${canonicalOrigin}/api/generation/media`, {
        method: 'POST',
        headers: {
          origin: canonicalOrigin,
          ...(sessionCookie ? { cookie: sessionCookie } : {}),
          'content-type': 'image/png',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-kind': 'image',
          'x-lumina-media-provider': 'fal-reference',
        },
        body,
        ...(signal ? { signal } : {}),
      });
      sessionCookie ||= response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      return response;
    };

    try {
      await waitForReady(gateway);
      holdNextUpload = true;
      const first = upload(Buffer.alloc(48, 1));
      await expect.poll(() => Boolean(heldUploadResponse)).toBe(true);
      const blocked = await upload(Buffer.alloc(48, 2));
      heldUploadResponse.writeHead(200);
      heldUploadResponse.end();
      expect((await first).status).toBe(201);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(await blocked.json()).toMatchObject({ error: 'image_provider_proxy_capacity_exceeded' });

      heldUploadResponse = undefined;
      holdNextUpload = true;
      const controller = new AbortController();
      const abandoned = upload(Buffer.alloc(48, 4), controller.signal);
      await expect.poll(() => Boolean(heldUploadResponse)).toBe(true);
      controller.abort();
      await abandoned.catch(() => undefined);
      const afterDisconnect = await upload(Buffer.alloc(48, 5));
      expect(afterDisconnect.status).toBe(201);

      const beforeOversized = tosRequests.length;
      const oversized = await upload(Buffer.alloc(50 * 1024 * 1024 + 1, 3));
      expect(oversized.status).toBe(413);
      expect(tosRequests).toHaveLength(beforeOversized);
    } finally {
      if (heldUploadResponse && !heldUploadResponse.writableEnded) heldUploadResponse.end();
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      tos.closeAllConnections();
      await new Promise((resolve, reject) => tos.close((error) => error ? reject(error) : resolve()));
    }
  }, 60000);

  it('transcodes controlled media and serves opaque provider-scoped grants only until reclaim or expiry', async () => {
    const transcoderCalls = [];
    const heldTranscodeReleases = [];
    const upstream = createServer(async (request, response) => {
      if (request.url === '/remote.mp4' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'video/mp4' });
        response.end('remote');
        return;
      }
      if (request.url !== '/transcode' || request.method !== 'POST') {
        response.writeHead(404);
        response.end('not found');
        return;
      }
      const body = await readRequestBody(request);
      transcoderCalls.push({
        type: request.headers['content-type'],
        kind: request.headers['x-lumina-media-kind'],
        body,
      });
      if (body.startsWith('hold-')) {
        await new Promise((resolve) => heldTranscodeReleases.push(resolve));
      }
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
        LUMINA_GATEWAY_MAX_TEMPORARY_MEDIA_BYTES_PER_SESSION: '20',
        LUMINA_GATEWAY_MAX_TEMPORARY_MEDIA_BYTES: '32',
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

      const transcodeCookie = transcoded.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      const heldSessionTranscode = fetch(mediaUrl, {
        method: 'POST',
        headers: { ...headers, cookie: transcodeCookie, 'x-lumina-media-operation': 'transcode' },
        body: 'hold-session-1',
      });
      await expect.poll(() => transcoderCalls.length).toBe(2);
      const sessionCapacityExceeded = await fetch(mediaUrl, {
        method: 'POST',
        headers: { ...headers, cookie: transcodeCookie, 'x-lumina-media-operation': 'transcode' },
        body: 'blocked',
      });
      expect(sessionCapacityExceeded.status).toBe(429);
      expect(await sessionCapacityExceeded.json()).toMatchObject({ error: 'temporary_media_capacity_exceeded' });
      heldTranscodeReleases.shift()?.();
      expect((await heldSessionTranscode).status).toBe(200);

      const afterSessionRelease = await fetch(mediaUrl, {
        method: 'POST',
        headers: { ...headers, cookie: transcodeCookie, 'x-lumina-media-operation': 'transcode' },
        body: 'after-release',
      });
      expect(afterSessionRelease.status).toBe(200);

      const heldProcessA = fetch(mediaUrl, {
        method: 'POST',
        headers: { ...headers, 'x-lumina-media-operation': 'transcode' },
        body: 'hold-process-a',
      });
      const heldProcessB = fetch(mediaUrl, {
        method: 'POST',
        headers: { ...headers, 'x-lumina-media-operation': 'transcode' },
        body: 'hold-process-b',
      });
      await expect.poll(() => transcoderCalls.length).toBe(5);
      const processCapacityExceeded = await fetch(mediaUrl, {
        method: 'POST',
        headers: { ...headers, 'x-lumina-media-operation': 'transcode' },
        body: 'extra',
      });
      expect(processCapacityExceeded.status).toBe(429);
      expect(await processCapacityExceeded.json()).toMatchObject({ error: 'temporary_media_capacity_exceeded' });
      heldTranscodeReleases.splice(0).forEach((release) => release());
      expect((await heldProcessA).status).toBe(200);
      expect((await heldProcessB).status).toBe(200);

      const afterProcessRelease = await fetch(mediaUrl, {
        method: 'POST',
        headers: { ...headers, 'x-lumina-media-operation': 'transcode' },
        body: 'ok',
      });
      expect(afterProcessRelease.status).toBe(200);

      const publishedUrl = await fetch(mediaUrl, {
        method: 'POST',
        headers: {
          origin: canonicalOrigin,
          'content-type': 'application/json',
          'x-lumina-media-kind': 'video',
          'x-lumina-media-operation': 'publish-url',
          'x-lumina-media-provider': 'volcengine-seedance',
        },
        body: JSON.stringify({ source: `http://127.0.0.1:${upstreamPort}/remote.mp4` }),
      });
      expect(publishedUrl.status).toBe(201);
      const publishedUrlGrant = await publishedUrl.json();
      const publishedUrlCookie = publishedUrl.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      expect(await (await fetch(publishedUrlGrant.url)).text()).toBe('remote');
      expect((await fetch(`${mediaUrl}/${publishedUrlGrant.key}`, {
        method: 'DELETE',
        headers: { origin: canonicalOrigin, cookie: publishedUrlCookie },
      })).status).toBe(204);

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

      const heldUpload = httpRequest(mediaUrl, {
        method: 'POST',
        headers: {
          ...headers,
          cookie: sessionCookie,
          'content-type': 'video/mp4',
          'content-length': '4',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-provider': 'volcengine-seedance',
        },
      });
      heldUpload.on('error', () => undefined);
      heldUpload.flushHeaders();
      heldUpload.write('x');
      await new Promise((resolve) => setTimeout(resolve, 50));

      let blockedRequest;
      const blockedBeforeBody = await Promise.race([
        new Promise((resolve, reject) => {
          blockedRequest = httpRequest(mediaUrl, {
            method: 'POST',
            headers: {
              ...headers,
              cookie: sessionCookie,
              'content-type': 'video/mp4',
              'content-length': '2',
              'x-lumina-media-operation': 'publish',
              'x-lumina-media-provider': 'volcengine-seedance',
            },
          }, resolve);
          blockedRequest.once('error', reject);
          blockedRequest.flushHeaders();
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('capacity was not rejected before reading the body')), 1000)),
      ]);
      expect(blockedBeforeBody.statusCode).toBe(429);
      blockedBeforeBody.resume();
      blockedRequest.destroy();
      heldUpload.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const afterAbortedReservation = await fetch(mediaUrl, {
        method: 'POST',
        headers: {
          ...headers,
          cookie: sessionCookie,
          'content-type': 'video/mp4',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-provider': 'volcengine-seedance',
        },
        body: 'ok',
      });
      expect(afterAbortedReservation.status).toBe(201);
      const afterAbortedGrant = await afterAbortedReservation.json();
      expect((await fetch(`${mediaUrl}/${afterAbortedGrant.key}`, {
        method: 'DELETE',
        headers: { origin: canonicalOrigin, cookie: sessionCookie },
      })).status).toBe(204);

      const capacityExceeded = await fetch(mediaUrl, {
        method: 'POST',
        headers: {
          ...headers,
          cookie: sessionCookie,
          'content-type': 'video/mp4',
          'x-lumina-media-operation': 'publish',
          'x-lumina-media-provider': 'volcengine-seedance',
        },
        body: 'capacity',
      });
      expect(capacityExceeded.status).toBe(429);
      expect(await capacityExceeded.json()).toMatchObject({
        error: 'temporary_media_capacity_exceeded',
      });

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
      heldTranscodeReleases.splice(0).forEach((release) => release());
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);
});
