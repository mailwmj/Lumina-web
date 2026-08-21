/* global Buffer, fetch, process, setTimeout */

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

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('gateway retention process contract', () => {
  it('cleans result and task state at the configured caps', async () => {
    const upstream = createServer(async (request, response) => {
      const body = await readBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body.prompt === 'active'
        ? { id: 'upstream-0123456789abcdef' }
        : { data: [{ b64_json: 'cmVzdWx0' }] }));
    });
    const upstreamPort = await listen(upstream);
    const probe = createServer();
    const gatewayPort = await listen(probe);
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const stateFile = join(tmpdir(), `lumina-gateway-retention-${process.pid}-${Date.now()}.json`);
    const gateway = spawn(process.execPath, ['gateway/server.mjs'], {
      env: {
        ...process.env,
        LUMINA_GATEWAY_PORT: String(gatewayPort),
        LUMINA_GATEWAY_ORIGIN: 'http://127.0.0.1:4173',
        LUMINA_GATEWAY_AI_MEDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS: `http://127.0.0.1:${upstreamPort}`,
        LUMINA_GATEWAY_ACTIVE_TASK_TTL_MS: '1200',
        LUMINA_GATEWAY_TERMINAL_TASK_TTL_MS: '1600',
        LUMINA_GATEWAY_RESULT_TTL_MS: '1000',
        LUMINA_GATEWAY_RESULT_CONFIRMATION_TTL_MS: '500',
        LUMINA_GATEWAY_STATE_FILE: stateFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = `http://127.0.0.1:${gatewayPort}/api/generation/jobs`;
    const headers = {
      authorization: 'Bearer ephemeral-test-key',
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
    };
    const submit = async (prompt, cookie) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...headers, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({
          operation: 'submit',
          provider: 'ai-media',
          projectId: 'project-1',
          projectRevision: 'revision-1',
          request: { model: 'ai-media/gpt-image-2', prompt, size: '1K' },
        }),
      });
      return { response, body: await response.json() };
    };

    try {
      await waitForReady(gateway);
      const confirmed = await submit('confirmed');
      const cookie = confirmed.response.headers.get('set-cookie')?.split(';', 1)[0];
      const confirmedResult = `${url}/${confirmed.body.job_id}/result`;
      expect((await fetch(confirmedResult, { headers: { ...headers, cookie } })).status).toBe(200);
      expect((await fetch(`${confirmedResult}/confirmed`, {
        method: 'POST',
        headers: { origin: headers.origin, cookie },
      })).status).toBe(204);
      await delay(600);
      expect((await fetch(confirmedResult, { headers: { ...headers, cookie } })).status).toBe(404);

      const repeatedConfirmation = await submit('repeated-confirmation', cookie);
      const repeatedConfirmationResult = `${url}/${repeatedConfirmation.body.job_id}/result`;
      expect((await fetch(repeatedConfirmationResult, { headers: { ...headers, cookie } })).status).toBe(200);
      expect((await fetch(`${repeatedConfirmationResult}/confirmed`, {
        method: 'POST',
        headers: { origin: headers.origin, cookie },
      })).status).toBe(204);
      await delay(300);
      expect((await fetch(`${repeatedConfirmationResult}/confirmed`, {
        method: 'POST',
        headers: { origin: headers.origin, cookie },
      })).status).toBe(204);
      await delay(300);
      expect((await fetch(repeatedConfirmationResult, { headers: { ...headers, cookie } })).status).toBe(404);

      const unconfirmed = await submit('unconfirmed', cookie);
      const unconfirmedResult = `${url}/${unconfirmed.body.job_id}/result`;
      expect((await fetch(unconfirmedResult, { headers: { ...headers, cookie } })).status).toBe(200);
      await delay(400);
      expect((await fetch(unconfirmedResult, { headers: { ...headers, cookie } })).status).toBe(200);
      await delay(700);
      expect((await fetch(unconfirmedResult, { headers: { ...headers, cookie } })).status).toBe(404);

      const active = await submit('active', cookie);
      await delay(1300);
      const missingActive = await fetch(`${url}/${active.body.job_id}`, {
        method: 'POST',
        headers: { ...headers, cookie },
        body: JSON.stringify({ operation: 'poll' }),
      });
      expect(missingActive.status).toBe(404);

      const terminal = await submit('terminal', cookie);
      await delay(1700);
      const missingTerminal = await fetch(`${url}/${terminal.body.job_id}`, {
        method: 'POST',
        headers: { ...headers, cookie },
        body: JSON.stringify({ operation: 'poll' }),
      });
      expect(missingTerminal.status).toBe(404);
    } finally {
      gateway.kill();
      await new Promise((resolve) => gateway.once('exit', resolve));
      try { unlinkSync(stateFile); } catch { /* test cleanup is best effort */ }
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 10000);
});
