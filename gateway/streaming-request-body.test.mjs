/* global Buffer */

import { describe, expect, it } from 'vitest';

import {
  createJsonMediaRequestBody,
  createMultipartRequestBody,
} from './streaming-request-body.mjs';

async function collect(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('streaming provider request bodies', () => {
  it('streams multipart files from their admitted Buffers with an exact length', async () => {
    const first = Buffer.from('first-image');
    const second = Buffer.from('second-image');
    const body = createMultipartRequestBody({
      boundary: 'lumina-test-boundary',
      fields: { model: 'gpt-image-2', prompt: 'edit' },
      files: [
        { name: 'image', filename: 'reference-1.png', contentType: 'image/png', bytes: first },
        { name: 'image', filename: 'reference-2.webp', contentType: 'image/webp', bytes: second },
      ],
    });
    const yielded = [];
    for await (const chunk of body) yielded.push(chunk);
    expect(yielded).toContain(first);
    expect(yielded).toContain(second);
    const bytes = Buffer.concat(yielded);
    expect(bytes.length).toBe(body.byteLength);
    expect(bytes.toString('latin1')).toContain('filename="reference-2.webp"');
  });

  it('streams text image placeholders as valid base64 JSON with an exact length', async () => {
    const media = [{ bytes: Buffer.from('reference-image'), contentType: 'image/png' }];
    const body = createJsonMediaRequestBody({
      model: 'vision-model',
      messages: [{ content: [{ type: 'image_url', image_url: { url: 'lumina-media:0' } }] }],
    }, media);
    const bytes = await collect(body);
    expect(bytes.length).toBe(body.byteLength);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({
      model: 'vision-model',
      messages: [{ content: [{
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${Buffer.from('reference-image').toString('base64')}` },
      }] }],
    });
  });
});
