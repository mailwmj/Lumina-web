/* global AbortController */

import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { waitForResponseDrain } from './response-backpressure.mjs';

function writableResponse() {
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  return response;
}

function expectNoWaitListeners(response) {
  expect(response.listenerCount('drain')).toBe(0);
  expect(response.listenerCount('close')).toBe(0);
  expect(response.listenerCount('error')).toBe(0);
}

describe('response backpressure', () => {
  it('continues only after the response drains', async () => {
    const response = writableResponse();
    const waiting = waitForResponseDrain(response);

    response.emit('drain');

    await expect(waiting).resolves.toBeUndefined();
    expectNoWaitListeners(response);
  });

  it.each(['close', 'abort'])('stops waiting when the client connection ends via %s', async (cause) => {
    const response = writableResponse();
    const controller = new AbortController();
    const waiting = waitForResponseDrain(response, controller.signal);

    if (cause === 'close') response.emit('close');
    else controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expectNoWaitListeners(response);
  });

  it('propagates response stream errors and removes competing listeners', async () => {
    const response = writableResponse();
    const waiting = waitForResponseDrain(response);
    const failure = new Error('write failed');

    response.emit('error', failure);

    await expect(waiting).rejects.toBe(failure);
    expectNoWaitListeners(response);
  });
});
