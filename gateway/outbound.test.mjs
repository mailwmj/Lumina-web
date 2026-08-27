/* global Blob, Buffer, FormData, setTimeout */

import { once } from 'node:events';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { createOutboundClient } from './outbound.mjs';

describe('gateway outbound policy', () => {
  it('rejects an unapproved scheme, host, port, or fragment before DNS lookup', async () => {
    const resolveHost = vi.fn();
    const outbound = createOutboundClient({ resolveHost });

    for (const target of [
      'ftp://provider.example/v1/images',
      'https://other.example/v1/images',
      'https://provider.example:8443/v1/images',
      'https://provider.example/v1/images#credential-fragment',
    ]) {
      await expect(outbound.fetch(target, {
        allowedOrigin: 'https://provider.example',
        maxResponseBytes: 1024,
      })).rejects.toMatchObject({ code: 'outbound_url_not_allowed' });
    }
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('rejects a host when any DNS answer is a private address', async () => {
    const outbound = createOutboundClient({
      resolveHost: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });

    await expect(outbound.fetch('https://provider.example/v1/images', {
      allowedOrigin: 'https://provider.example',
      maxResponseBytes: 1024,
    })).rejects.toMatchObject({ code: 'outbound_address_not_allowed' });
  });

  it('allows a Fake-IP only for an explicitly trusted HTTPS provider origin', async () => {
    const requestTransport = vi.fn(async () => new Response('ok', { status: 200 }));
    const outbound = createOutboundClient({
      resolveHost: async () => [{ address: '198.18.2.23', family: 4 }],
      trustedHttpsSyntheticOrigins: ['https://provider.example'],
      requestTransport,
    });

    const response = await outbound.fetch('https://provider.example/v1/images', {
      allowedOrigin: 'https://provider.example',
      maxResponseBytes: 1024,
    });

    expect(response.status).toBe(200);
    expect(requestTransport).toHaveBeenCalledWith(
      expect.any(URL),
      'provider.example',
      '198.18.2.23',
      4,
      expect.objectContaining({ maxResponseBytes: 1024 }),
    );

    const loopback = createOutboundClient({
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      trustedHttpsSyntheticOrigins: ['https://provider.example'],
      requestTransport,
    });
    await expect(loopback.fetch('https://provider.example/v1/images', {
      allowedOrigin: 'https://provider.example',
      maxResponseBytes: 1024,
    })).rejects.toMatchObject({ code: 'outbound_address_not_allowed' });
    expect(requestTransport).toHaveBeenCalledTimes(1);
  });

  it('rejects an IPv4-mapped IPv6 loopback literal before DNS lookup', async () => {
    const resolveHost = vi.fn(() => {
      throw new Error('IPv6 literals must not be resolved again.');
    });
    const outbound = createOutboundClient({ resolveHost });

    await expect(outbound.fetch('http://[::ffff:7f00:1]:8080/v1/images', {
      allowedOrigin: 'http://[::ffff:7f00:1]:8080',
      maxResponseBytes: 1024,
    })).rejects.toMatchObject({ code: 'outbound_address_not_allowed' });
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('pins an approved outbound hop to its validated DNS address', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const origin = `http://gateway-test.invalid:${address.port}`;
    const outbound = createOutboundClient({
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      trustedPrivateOrigins: [origin],
    });

    try {
      const response = await outbound.fetch(`${origin}/v1/images`, {
        allowedOrigin: origin,
        maxResponseBytes: 1024,
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"ok":true}');
    } finally {
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('streams an approved response without waiting for its full body', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp4' });
      response.write('first');
      setTimeout(() => response.end('second'), 100);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const origin = `http://stream-test.invalid:${address.port}`;
    const outbound = createOutboundClient({
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      trustedPrivateOrigins: [origin],
    });

    try {
      const response = await outbound.fetch(`${origin}/transcode`, {
        allowedOrigin: origin,
        maxResponseBytes: 1024,
        streamResponse: true,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Expected a streamed response body.');

      const first = await reader.read();
      expect(Buffer.from(first.value).toString('utf8')).toBe('first');
      const second = await reader.read();
      expect(Buffer.from(second.value).toString('utf8')).toBe('second');
      expect((await reader.read()).done).toBe(true);
    } finally {
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects a redirect without following its Location', async () => {
    let redirectedRequests = 0;
    const upstream = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/private' });
        response.end();
        return;
      }
      redirectedRequests += 1;
      response.writeHead(200);
      response.end('unexpected');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const origin = `http://redirect-test.invalid:${address.port}`;
    const outbound = createOutboundClient({
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      trustedPrivateOrigins: [origin],
    });

    try {
      await expect(outbound.fetch(`${origin}/redirect`, {
        allowedOrigin: origin,
        maxResponseBytes: 1024,
      })).rejects.toMatchObject({ code: 'outbound_redirect_not_allowed' });
      expect(redirectedRequests).toBe(0);
    } finally {
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('enforces the response limit after decompression', async () => {
    const upstream = createServer((_request, response) => {
      const payload = gzipSync(Buffer.from('x'.repeat(2048)));
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': payload.length,
      });
      response.end(payload);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const origin = `http://compression-test.invalid:${address.port}`;
    const outbound = createOutboundClient({
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      trustedPrivateOrigins: [origin],
    });

    try {
      await expect(outbound.fetch(`${origin}/result`, {
        allowedOrigin: origin,
        maxResponseBytes: 128,
      })).rejects.toMatchObject({ code: 'outbound_response_too_large' });
    } finally {
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('forwards a bounded request through the validated connection', async () => {
    let received;
    const upstream = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received = {
          method: request.method,
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const origin = `http://post-test.invalid:${address.port}`;
    const outbound = createOutboundClient({
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      trustedPrivateOrigins: [origin],
    });

    try {
      const response = await outbound.fetch(`${origin}/v1/images`, {
        allowedOrigin: origin,
        method: 'POST',
        headers: {
          authorization: 'Bearer ephemeral-key',
          'content-type': 'application/json',
        },
        body: '{"model":"ai-media/gpt-image-2"}',
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
      });

      expect(response.status).toBe(200);
      expect(received).toEqual({
        method: 'POST',
        authorization: 'Bearer ephemeral-key',
        body: '{"model":"ai-media/gpt-image-2"}',
      });
    } finally {
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('encodes FormData through the validated connection', async () => {
    let received;
    const upstream = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received = {
          type: request.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        };
        response.writeHead(200);
        response.end('ok');
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const origin = `http://form-test.invalid:${address.port}`;
    const outbound = createOutboundClient({
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      trustedPrivateOrigins: [origin],
    });
    const form = new FormData();
    form.append('model', 'ai-media/gpt-image-2');
    form.append('image', new Blob(['image-bytes'], { type: 'image/png' }), 'image.png');

    try {
      await outbound.fetch(`${origin}/v1/images/edits`, {
        allowedOrigin: origin,
        method: 'POST',
        body: form,
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
      });

      expect(received.type).toMatch(/^multipart\/form-data; boundary=/);
      expect(received.body).toContain('ai-media/gpt-image-2');
      expect(received.body).toContain('image-bytes');
    } finally {
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });
});
