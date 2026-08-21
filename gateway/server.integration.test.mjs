/* global Buffer, fetch, process, setTimeout */

import { once } from 'node:events';
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
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);
});
