import { describe, expect, it, vi } from 'vitest';

import { createCanvasImageDecodeQueue } from './canvasImageDecodeQueue';

describe('canvas image decode queue', () => {
  it('limits concurrent original image decodes', async () => {
    const resolvers: Array<() => void> = [];
    const loadImage = vi.fn(() => new Promise<void>((resolve) => {
      resolvers.push(resolve);
    }));
    const queue = createCanvasImageDecodeQueue(loadImage, 2);

    const first = queue.enqueue('first');
    const second = queue.enqueue('second');
    const third = queue.enqueue('third');
    expect(loadImage).toHaveBeenCalledWith('first');
    expect(loadImage).toHaveBeenCalledWith('second');
    expect(loadImage).toHaveBeenCalledTimes(2);

    resolvers.shift()?.();
    await first.promise;
    await Promise.resolve();
    expect(loadImage).toHaveBeenLastCalledWith('third');

    resolvers.splice(0).forEach((resolve) => resolve());
    await Promise.all([first.promise, second.promise, third.promise]);
  });
});
