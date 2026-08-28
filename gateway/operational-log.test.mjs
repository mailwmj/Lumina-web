/* global process */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createGatewayLogger } from './operational-log.mjs';

describe('gateway operational log', () => {
  it('drops expired or unsafe records and writes only the approved fields', () => {
    const now = 1_000_000_000;
    const file = join(tmpdir(), `lumina-gateway-log-${process.pid}-${Date.now()}.jsonl`);
    writeFileSync(file, [
      JSON.stringify({
        timestamp: now - 7 * 24 * 60 * 60 * 1000 - 1,
        request_id: 'old-request',
        operation: 'submit',
        provider: 'ai-media',
        status: 202,
        duration_ms: 1,
        bytes: 1,
        prompt: 'expired-prompt-secret',
      }),
      JSON.stringify({
        timestamp: now,
        request_id: 'unsafe-request',
        operation: 'submit',
        provider: 'ai-media',
        status: 202,
        duration_ms: 1,
        bytes: 1,
        authorization: 'Bearer api-secret',
      }),
    ].join('\n'), 'utf8');

    try {
      const logger = createGatewayLogger({ file, now: () => now });
      logger.record({
        requestId: 'request-42',
        operation: 'submit',
        provider: 'ai-media',
        status: 429,
        durationMs: 12,
        bytes: 345,
      });
      logger.record({
        requestId: 'request-image-provider',
        operation: 'image_provider_proxy',
        provider: 'fal',
        status: 200,
        durationMs: 9,
        bytes: 678,
      });

      const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toEqual([
        {
          timestamp: now,
          request_id: 'request-42',
          operation: 'submit',
          provider: 'ai-media',
          status: 429,
          duration_ms: 12,
          bytes: 345,
        },
        {
          timestamp: now,
          request_id: 'request-image-provider',
          operation: 'image_provider_proxy',
          provider: 'fal',
          status: 200,
          duration_ms: 9,
          bytes: 678,
        },
      ]);
      expect(readFileSync(file, 'utf8')).not.toContain('expired-prompt-secret');
      expect(readFileSync(file, 'utf8')).not.toContain('api-secret');
    } finally {
      try { unlinkSync(file); } catch { /* test cleanup is best effort */ }
    }
  });
});
