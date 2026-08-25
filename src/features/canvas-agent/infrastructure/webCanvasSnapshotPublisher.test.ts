import { describe, expect, it, vi } from 'vitest';

import { buildCanvasAgentCapabilities } from '@/features/canvas-agent/application/canvasAgentSnapshot';
import type { CanvasAgentSnapshot } from '@/features/canvas-agent/domain/types';
import type { WebCanvasBootstrap } from './webCanvasBootstrap';
import { WebCanvasSnapshotPublisher } from './webCanvasSnapshotPublisher';

const bootstrap: WebCanvasBootstrap = {
  bridge: 'web',
  endpoint: 'http://127.0.0.1:17372',
  canonicalOrigin: 'http://127.0.0.1:49123',
  sessionId: 'session-1',
  token: 'short-lived-web-token',
  expiresAt: Date.now() + 60_000,
};

function snapshot(marker: string): CanvasAgentSnapshot {
  return {
    protocolVersion: 3,
    projectId: 'project-1',
    projectName: marker,
    nodes: [],
    edges: [],
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedImagePreviews: [],
    capabilities: buildCanvasAgentCapabilities(),
    writeAccess: false,
  } as CanvasAgentSnapshot;
}

describe('WebCanvasSnapshotPublisher', () => {
  it('coalesces pending snapshots and drops queued state when its session closes', async () => {
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const send = vi.fn(async (_bootstrap: WebCanvasBootstrap, value: CanvasAgentSnapshot) => {
      if (value.projectName === 'r1') {
        await firstRequest;
      }
    });
    const publisher = new WebCanvasSnapshotPublisher(vi.fn(), send);

    publisher.enqueue(bootstrap, snapshot('r1'));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    publisher.enqueue(bootstrap, snapshot('r2'));
    publisher.enqueue(bootstrap, snapshot('r3'));
    publisher.clear();

    releaseFirst();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls.map(([, value]) => value.projectName)).toEqual(['r1']);
  });
});
