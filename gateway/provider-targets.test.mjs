/* global Headers */

import { describe, expect, it } from 'vitest';

import {
  providerErrorMessage,
  providerRequestId,
  seedanceProviderTarget,
  textProviderTarget,
} from './provider-targets.mjs';

describe('gateway provider targets', () => {
  it('derives only the fixed text provider paths', () => {
    expect(textProviderTarget('https://provider.example/v1', 'models')?.toString())
      .toBe('https://provider.example/v1/models');
    expect(textProviderTarget('https://provider.example/api/coding', 'request', 'chat')?.toString())
      .toBe('https://provider.example/api/coding/v3/chat/completions');
    expect(textProviderTarget('https://provider.example/api/v3', 'request', 'responses')?.toString())
      .toBe('https://provider.example/api/v3/responses');
    expect(textProviderTarget('https://provider.example/api/v3/responses', 'request', 'responses')?.toString())
      .toBe('https://provider.example/api/v3/responses');
    expect(textProviderTarget('https://provider.example/v1', 'delete', 'chat')).toBeNull();
    expect(textProviderTarget('https://user:pass@provider.example/v1', 'models')).toBeNull();
  });

  it('derives fixed Seedance submit and task paths and rejects unsafe task ids', () => {
    expect(seedanceProviderTarget('https://ark.example', 'submit')?.toString())
      .toBe('https://ark.example/api/v3/contents/generations/tasks');
    expect(seedanceProviderTarget(
      'https://ark.example/api/v3/',
      'poll',
      'task-0123456789abcdef',
    )?.toString()).toBe(
      'https://ark.example/api/v3/contents/generations/tasks/task-0123456789abcdef',
    );
    expect(seedanceProviderTarget('https://ark.example/api/v3', 'cancel', 'sk-secret')).toBeNull();
  });

  it('sanitizes provider messages and accepts only safe request ids', () => {
    expect(providerErrorMessage({ error: { message: 'bad https://provider.test/result' } }, 'failed'))
      .toBe('bad <URL>');
    expect(providerErrorMessage({ error: { message: 'bad https://provider.test/x?token=secret' } }, 'failed'))
      .toBe('failed');
    expect(providerErrorMessage({ error: { message: 'Bearer secret' } }, 'failed')).toBe('failed');
    expect(providerRequestId(
      { request_id: 'body-id' },
      new Headers({ 'x-request-id': 'header-id' }),
    )).toBe('header-id');
    expect(providerRequestId({ request_id: 'unsafe id' }, new Headers())).toBeNull();
  });
});
