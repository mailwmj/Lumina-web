import type { CanvasAgentSnapshot } from '@/features/canvas-agent/domain/types';
import {
  publishWebCanvasSnapshot,
} from '@/features/canvas-agent/infrastructure/webCanvasBridge';
import type { WebCanvasBootstrap } from './webCanvasBootstrap';

interface SnapshotPublishRequest {
  bootstrap: WebCanvasBootstrap;
  snapshot: CanvasAgentSnapshot;
  includeSelectedImagePreviews: boolean;
}

export class WebCanvasSnapshotPublisher {
  private pending: SnapshotPublishRequest | null = null;
  private publishing = false;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly send = publishWebCanvasSnapshot,
  ) {}

  enqueue(
    bootstrap: WebCanvasBootstrap,
    snapshot: CanvasAgentSnapshot,
    includeSelectedImagePreviews = false,
  ): void {
    this.pending = { bootstrap, snapshot, includeSelectedImagePreviews };
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
          await this.send(request.bootstrap, request.snapshot, {
            includeSelectedImagePreviews: request.includeSelectedImagePreviews,
          });
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
