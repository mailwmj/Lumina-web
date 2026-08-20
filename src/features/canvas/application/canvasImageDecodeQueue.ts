export const MAX_CONCURRENT_CANVAS_IMAGE_DECODES = 4;

export interface CanvasImageDecodeTask {
  cancel: () => void;
  promise: Promise<void>;
}

interface QueuedImageDecode {
  cancelled: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
  source: string;
  started: boolean;
}

export function createCanvasImageDecodeQueue(
  loadImage: (source: string) => Promise<void>,
  maxConcurrent = MAX_CONCURRENT_CANVAS_IMAGE_DECODES
): { enqueue: (source: string) => CanvasImageDecodeTask } {
  const queue: QueuedImageDecode[] = [];
  let activeCount = 0;
  const safeMaxConcurrent = Math.max(1, Math.floor(maxConcurrent));

  const runNext = () => {
    while (activeCount < safeMaxConcurrent && queue.length > 0) {
      const next = queue.shift();
      if (!next || next.cancelled) {
        next?.resolve();
        continue;
      }

      next.started = true;
      activeCount += 1;
      void loadImage(next.source)
        .then(next.resolve, next.reject)
        .finally(() => {
          activeCount -= 1;
          runNext();
        });
    }
  };

  return {
    enqueue: (source) => {
      let job: QueuedImageDecode;
      const promise = new Promise<void>((resolve, reject) => {
        job = {
          cancelled: false,
          reject,
          resolve,
          source,
          started: false,
        };
        queue.push(job);
        runNext();
      });

      return {
        promise,
        cancel: () => {
          if (!job.started) {
            job.cancelled = true;
            runNext();
          }
        },
      };
    },
  };
}
