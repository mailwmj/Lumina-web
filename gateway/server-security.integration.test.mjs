/* global fetch, process, setTimeout */

import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
  return address.port;
}

async function gatewayPort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
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

function requestBody(prompt = 'test') {
  return JSON.stringify({
    operation: 'submit',
    provider: 'ai-media',
    projectId: 'project-1',
    projectRevision: 'revision-1',
    request: { model: 'ai-media/gpt-image-2', prompt, size: '1K' },
  });
}

function headers() {
  return {
    authorization: 'Bearer ephemeral-test-key',
    origin: 'http://127.0.0.1:4173',
    'content-type': 'application/json',
  };
}

describe('gateway source capacity contracts', () => {
  it('rate-limits one source even when each request starts a fresh session', async () => {
    const port = await gatewayPort();
    const stateFile = join(tmpdir(), `lumina-gateway-rate-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(port),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_MAX_REQUESTS_PER_WINDOW: '1',
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const first = await fetch(`http://127.0.0.1:${port}/api/generation/jobs`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ operation: 'submit', provider: 'unknown' }),
      });
      expect(first.status).toBe(400);

      const limited = await fetch(`http://127.0.0.1:${port}/api/generation/jobs`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ operation: 'submit', provider: 'unknown' }),
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expect(await limited.json()).toMatchObject({
        error: 'rate_limited',
        request_id: expect.any(String),
      });
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
    }
  }, 10000);

  it('uses the shared rate contract for result retrieval', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: 'cmVzdWx0' }] }));
    });
    const upstreamPort = await listen(upstream);
    const port = await gatewayPort();
    const stateFile = join(tmpdir(), `lumina-gateway-result-rate-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(port),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_MAX_REQUESTS_PER_WINDOW: '2',
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const submitted = await fetch(`http://127.0.0.1:${port}/api/generation/jobs`, {
        method: 'POST', headers: headers(), body: requestBody('result-rate'),
      });
      const submission = await submitted.json();
      const cookie = submitted.headers.get('set-cookie')?.split(';', 1)[0];
      const resultUrl = `http://127.0.0.1:${port}/api/generation/jobs/${submission.job_id}/result`;

      expect((await fetch(resultUrl, { headers: { cookie } })).status).toBe(200);
      const limited = await fetch(resultUrl, { headers: { cookie } });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expect(await limited.json()).toMatchObject({
        error: 'rate_limited',
        request_id: expect.any(String),
      });
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('limits active tasks by source before the Provider-wide quota', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'upstream-0123456789abcdef' }));
    });
    const upstreamPort = await listen(upstream);
    const port = await gatewayPort();
    const stateFile = join(tmpdir(), `lumina-gateway-concurrency-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(port),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_MAX_REQUESTS_PER_WINDOW: '10',
        LUMINA_GATEWAY_MAX_CONCURRENT_TASKS_PER_SOURCE: '1',
        LUMINA_GATEWAY_MAX_ACTIVE_TASKS_PER_PROVIDER: '10',
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      expect((await fetch(`http://127.0.0.1:${port}/api/generation/jobs`, {
        method: 'POST', headers: headers(), body: requestBody('first'),
      })).status).toBe(202);

      const limited = await fetch(`http://127.0.0.1:${port}/api/generation/jobs`, {
        method: 'POST', headers: headers(), body: requestBody('second'),
      });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({
        error: 'concurrency_limited',
        request_id: expect.any(String),
      });
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('rejects a same-origin result whose media type is not an allowed image', async () => {
    let resultFetches = 0;
    const upstream = createServer((request, response) => {
      if (request.url === '/v1/images/generations') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          data: [{ url: `http://127.0.0.1:${upstream.address().port}/result` }],
        }));
        return;
      }
      if (request.url === '/result') {
        resultFetches += 1;
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html>not an image</html>');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const port = await gatewayPort();
    const stateFile = join(tmpdir(), `lumina-gateway-result-type-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(port),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const response = await fetch(`http://127.0.0.1:${port}/api/generation/jobs`, {
        method: 'POST',
        headers: headers(),
        body: requestBody('result media type'),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ status: 'failed' });
      expect(resultFetches).toBe(1);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);

  it('does not connect to a private transcoder in production', async () => {
    let transcoderCalls = 0;
    const transcoder = createServer((_request, response) => {
      transcoderCalls += 1;
      response.writeHead(200, { 'content-type': 'video/mp4' });
      response.end('converted');
    });
    const transcoderPort = await listen(transcoder);
    const port = await gatewayPort();
    const origin = `http://127.0.0.1:${port}`;
    const stateFile = join(tmpdir(), `lumina-gateway-private-transcoder-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        LUMINA_GATEWAY_PORT: String(port),
        LUMINA_GATEWAY_ORIGIN: origin,
        LUMINA_GATEWAY_MEDIA_TRANSCODER_URL: `http://127.0.0.1:${transcoderPort}/transcode`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${transcoderPort}`,
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(gateway);
      const response = await fetch(`http://127.0.0.1:${port}/api/generation/media`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'video/quicktime',
          'x-lumina-media-operation': 'transcode',
          'x-lumina-media-kind': 'video',
        },
        body: 'source-media',
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'transcoder_unavailable' });
      expect(transcoderCalls).toBe(0);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => transcoder.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);
});
