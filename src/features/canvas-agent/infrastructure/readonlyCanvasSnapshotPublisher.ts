import type { ReadonlyCanvasSnapshot } from '@/features/canvas-agent/application/readonlyCanvasSnapshot';
import type { ReadonlyCanvasBootstrap } from './readonlyCanvasBootstrap';
import { publishReadonlyCanvasSnapshot } from './readonlyCanvasBridge';

type SnapshotSender = typeof publishReadonlyCanvasSnapshot;

interface SnapshotPublishRequest {
  bootstrap: ReadonlyCanvasBootstrap;
  snapshot: ReadonlyCanvasSnapshot;
}

export class ReadonlyCanvasSnapshotPublisher {
  private pending: SnapshotPublishRequest | null = null;
  private publishing = false;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly send: SnapshotSender = publishReadonlyCanvasSnapshot,
  ) {}

  enqueue(bootstrap: ReadonlyCanvasBootstrap, snapshot: ReadonlyCanvasSnapshot): void {
    this.pending = { bootstrap, snapshot };
    if (!this.publishing) {
      void this.drain();
    }
  }

  clear(): void {
    this.pending = null;
  }

  private async drain(): Promise<void> {
    this.publishing = true;
    try {
      while (this.pending) {
        const request = this.pending;
        this.pending = null;
        try {
          await this.send(request.bootstrap, request.snapshot);
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.publishing = false;
      if (this.pending) {
        void this.drain();
      }
    }
  }
}
