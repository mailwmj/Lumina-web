import type {
  CanvasAgentImagePreview,
  CanvasAgentSnapshot,
} from '@/features/canvas-agent/domain/types';
import {
  postCanvasAgentSnapshot,
  type CanvasAgentEndpoint,
} from '@/features/canvas-agent/infrastructure/canvasAgentBridge';

interface PreviewMarker {
  selection: object;
  previews: readonly CanvasAgentImagePreview[];
}

interface SnapshotPublishRequest {
  endpoint: CanvasAgentEndpoint;
  clientId: string;
  snapshot: CanvasAgentSnapshot;
  previewMarker: PreviewMarker;
  forcePreviews: boolean;
}

interface PublishedPreviewMarker extends PreviewMarker {
  endpoint: CanvasAgentEndpoint;
}

type SnapshotSender = typeof postCanvasAgentSnapshot;

export class CanvasAgentSnapshotPublisher {
  private pending: SnapshotPublishRequest | null = null;
  private publishing = false;
  private lastPublishedPreviewMarker: PublishedPreviewMarker | null = null;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly send: SnapshotSender = postCanvasAgentSnapshot
  ) {}

  enqueue(request: SnapshotPublishRequest): void {
    this.pending = request;
    if (!this.publishing) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.publishing = true;
    try {
      while (this.pending) {
        const request = this.pending;
        this.pending = null;
        const includeSelectedImagePreviews = request.forcePreviews
          || this.hasPreviewMarkerChanged(request);
        try {
          await this.send(
            request.endpoint,
            request.clientId,
            request.snapshot,
            { includeSelectedImagePreviews }
          );
          if (includeSelectedImagePreviews) {
            this.lastPublishedPreviewMarker = {
              endpoint: request.endpoint,
              ...request.previewMarker,
            };
          }
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

  private hasPreviewMarkerChanged(request: SnapshotPublishRequest): boolean {
    const previous = this.lastPublishedPreviewMarker;
    return !previous
      || previous.endpoint.url !== request.endpoint.url
      || previous.endpoint.token !== request.endpoint.token
      || previous.selection !== request.previewMarker.selection
      || previous.previews !== request.previewMarker.previews;
  }
}
