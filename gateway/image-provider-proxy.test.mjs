/* global Blob, Buffer, FormData, Request, URL */

import { describe, expect, it } from 'vitest';

import {
  imageProviderAuthHeaders,
  imageProviderResponseReservationBytes,
  imageProviderProxyRequest,
  imageProviderRequestBodyAllowed,
  imageProviderResultSources,
  imageProviderResultTarget,
  maximumImageProviderRequestBytes,
} from './image-provider-proxy.mjs';
import providerContractFixtures from '../src/features/canvas/infrastructure/image-provider-contract-fixtures.json';

function headers(protocol, baseUrl, targetUrl, method = 'POST') {
  return {
    'x-lumina-image-protocol': protocol,
    'x-lumina-image-base-url': encodeURIComponent(baseUrl),
    'x-lumina-image-target-url': encodeURIComponent(targetUrl),
    'x-lumina-image-method': method,
  };
}

describe('image provider proxy policy', () => {
  it('budgets decoded reference expansion and every live base64 response copy', () => {
    expect(maximumImageProviderRequestBytes({
      maxAggregateImageBytes: 250 * 1024 * 1024,
      maxImageCount: 10,
      maxMetadataBytes: 1024 * 1024,
    })).toBe(350_573_948);
    expect(imageProviderResponseReservationBytes({
      maxProviderResponseBytes: 68,
      maxResultBytes: 50,
    })).toBe(254);
  });

  it.each([
    ['openai-images', 'https://provider.test/v1', 'https://provider.test/v1/images/generations'],
    ['fhl-images', 'https://provider.test/v1', 'https://provider.test/v1/images/edits'],
    ['gemini-native', 'https://provider.test/v1beta', 'https://provider.test/v1beta/models/gemini-3:generateContent'],
    ['fal', 'https://queue.fal.run', 'https://queue.fal.run/fal-ai/nano-banana-2/edit'],
    ['grsai', 'https://provider.test', 'https://provider.test/v1/draw/result'],
    ['kie', 'https://api.kie.ai', 'https://api.kie.ai/api/v1/jobs/createTask'],
    ['runninghub', 'https://provider.test/openapi/v2', 'https://provider.test/openapi/v2/model/image-to-image'],
    ['bltcy', 'https://provider.test', 'https://provider.test/v1/images/edits'],
    ['ppio', 'https://provider.test', 'https://provider.test/v3/gemini-3.1-flash-image-edit'],
  ])('allows the fixed %s submit profile', (protocol, baseUrl, targetUrl) => {
    expect(imageProviderProxyRequest(headers(protocol, baseUrl, targetUrl))).toMatchObject({ protocol, method: 'POST' });
  });

  it('allows only the fixed KIE upload host and blocks arbitrary targets', () => {
    expect(imageProviderProxyRequest(headers(
      'kie',
      'https://api.kie.ai',
      'https://kieai.redpandaai.co/api/file-stream-upload',
    ))).not.toBeNull();
    expect(imageProviderProxyRequest(headers(
      'kie',
      'https://api.kie.ai',
      'https://kieai.redpandaai.co/admin/api/file-stream-upload',
    ))).toBeNull();
    expect(imageProviderProxyRequest(headers(
      'kie',
      'https://api.kie.ai',
      'https://attacker.test/api/file-stream-upload',
    ))).toBeNull();
    expect(imageProviderProxyRequest(headers(
      'fal',
      'https://queue.fal.run',
      'https://queue.fal.run/admin/delete',
    ))).toBeNull();
  });

  it('allows bounded poll paths but rejects credential-bearing query strings', () => {
    expect(imageProviderProxyRequest(headers(
      'kie',
      'https://api.kie.ai',
      'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task-1',
      'GET',
    ))).not.toBeNull();
    expect(imageProviderProxyRequest(headers(
      'fal',
      'https://queue.fal.run',
      'https://queue.fal.run/fal-ai/nano-banana-2/requests/task-1/status?token=secret',
      'GET',
    ))).toBeNull();
  });

  it('rejects allowed suffixes outside the configured base path and arbitrary credentialed GETs', () => {
    expect(imageProviderProxyRequest(headers(
      'openai-images',
      'https://provider.test/v1',
      'https://provider.test/admin/images/generations',
    ))).toBeNull();
    expect(imageProviderProxyRequest(headers(
      'fal',
      'https://queue.fal.run',
      'https://queue.fal.run/admin/export',
      'GET',
    ))).toBeNull();
    expect(imageProviderProxyRequest(headers(
      'kie',
      'https://api.kie.ai',
      'https://api.kie.ai/api/v1/users/me',
      'GET',
    ))).toBeNull();
  });

  it('allows only known model, task status, and task result GET shapes', () => {
    expect(imageProviderProxyRequest(headers(
      'openai-images',
      'https://provider.test/v1',
      'https://provider.test/v1/models',
      'GET',
    ))).not.toBeNull();
    expect(imageProviderProxyRequest(headers(
      'fal',
      'https://queue.fal.run',
      'https://queue.fal.run/fal-ai/nano-banana-2/requests/task-1/status',
      'GET',
    ))).not.toBeNull();
    expect(imageProviderProxyRequest(headers(
      'fal',
      'https://queue.fal.run',
      'https://queue.fal.run/tasks/task-1',
      'GET',
    ))).not.toBeNull();
  });

  it('rebuilds provider authentication and validates materialized result URLs', () => {
    expect(imageProviderAuthHeaders('fal', 'key', 'application/json')).toEqual({
      authorization: 'Key key',
      'x-fal-no-retry': '1',
      'content-type': 'application/json',
    });
    expect(imageProviderAuthHeaders('gemini-native', 'key')).toEqual({ 'x-goog-api-key': 'key' });
    expect(imageProviderResultTarget('https://provider.test/v1', 'https://cdn.test/result.png?sig=1'))
      .toMatchObject({ target: expect.any(URL) });
    expect(imageProviderResultTarget('https://provider.test/v1', 'file:///secret')).toBeNull();
  });

  it('registers every legacy provider result URL shape used by the browser extractor', () => {
    for (const fixture of providerContractFixtures.resultShapes) {
      expect(imageProviderResultSources(fixture.payload), fixture.name).toContain(fixture.expected);
    }
    expect(imageProviderResultSources({ assets: [{ download_url: '/v1/assets/result.png' }] }))
      .toContain('/v1/assets/result.png');
  });

  it('enforces per-image, aggregate, count, and metadata limits for provider bodies', async () => {
    const descriptor = imageProviderProxyRequest(headers(
      'openai-images',
      'https://provider.test/v1',
      'https://provider.test/v1/images/edits',
    ));
    const multipart = async (contents) => {
      const form = new FormData();
      form.append('prompt', 'edit');
      form.append('image', new Blob([contents], { type: 'image/png' }), 'reference.png');
      const request = new Request('https://gateway.test', { method: 'POST', body: form });
      return {
        body: Buffer.from(await request.arrayBuffer()),
        contentType: request.headers.get('content-type'),
      };
    };
    const small = await multipart('1234');
    expect(imageProviderRequestBodyAllowed(descriptor, small.contentType, small.body, {
      maxImageBytes: 4,
      maxImageCount: 1,
      maxAggregateImageBytes: 4,
      maxMetadataBytes: 128,
    })).toBe(true);
    const oversized = await multipart('12345');
    expect(imageProviderRequestBodyAllowed(descriptor, oversized.contentType, oversized.body, {
      maxImageBytes: 4,
      maxImageCount: 1,
      maxAggregateImageBytes: 4,
      maxMetadataBytes: 128,
    })).toBe(false);

    const ppio = imageProviderProxyRequest(headers(
      'ppio',
      'https://provider.test',
      'https://provider.test/v3/gemini-3.1-flash-image-edit',
    ));
    const json = Buffer.from(JSON.stringify({
      prompt: 'edit',
      image_base64s: [Buffer.from('12345').toString('base64')],
    }));
    expect(imageProviderRequestBodyAllowed(ppio, 'application/json', json, {
      maxImageBytes: 4,
      maxImageCount: 1,
      maxAggregateImageBytes: 4,
      maxMetadataBytes: 128,
    })).toBe(false);

    const fal = imageProviderProxyRequest(headers(
      'fal',
      'https://queue.fal.run',
      'https://queue.fal.run/fal-ai/nano-banana-2/edit',
    ));
    const tooManyFalReferences = Buffer.from(JSON.stringify({
      prompt: 'edit',
      image_urls: ['https://media.test/1.png', 'https://media.test/2.png'],
    }));
    expect(imageProviderRequestBodyAllowed(fal, 'application/json', tooManyFalReferences, {
      maxImageBytes: 4,
      maxImageCount: 1,
      maxAggregateImageBytes: 4,
      maxMetadataBytes: 256,
    })).toBe(false);
  });
});
