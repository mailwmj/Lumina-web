import { describe, expect, it, vi } from 'vitest';

import type { ReadonlyCanvasSnapshot } from '@/features/canvas-agent/application/readonlyCanvasSnapshot';
import type { ReadonlyCanvasBootstrap } from './readonlyCanvasBootstrap';
import { ReadonlyCanvasSnapshotPublisher } from './readonlyCanvasSnapshotPublisher';

const bootstrap: ReadonlyCanvasBootstrap = {
  endpoint: 'http://127.0.0.1:17372',
  canonicalOrigin: 'http://127.0.0.1:49123',
  sessionId: 'session-1',
  token: 'short-lived-token',
  expiresAt: Date.now() + 60_000,
};

function snapshot(revision: string): ReadonlyCanvasSnapshot {
  return {
    protocol: { major: 1, minor: 0, build: 'lumina-canvas-readonly-v1' },
    capabilities: ['canvas.read.state'],
    state: {
      project: { id: 'project-1', name: 'Current project', revision },
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    selection: { nodeIds: [] },
  };
}

describe('ReadonlyCanvasSnapshotPublisher', () => {
  it('serializes publication and coalesces queued snapshots to the latest revision', async () => {
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const send = vi.fn(async (_bootstrap: ReadonlyCanvasBootstrap, value: ReadonlyCanvasSnapshot) => {
      if (value.state.project.revision === 'r1') {
        await firstRequest;
      }
    });
    const publisher = new ReadonlyCanvasSnapshotPublisher(vi.fn(), send);

    publisher.enqueue(bootstrap, snapshot('r1'));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    publisher.enqueue(bootstrap, snapshot('r2'));
    publisher.enqueue(bootstrap, snapshot('r3'));

    releaseFirst();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(([, value]) => value.state.project.revision)).toEqual(['r1', 'r3']);
  });
});
