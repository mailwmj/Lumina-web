import { describe, expect, it, vi } from 'vitest';

import type { CanvasAgentSnapshot } from '@/features/canvas-agent/domain/types';
import type { CanvasAgentEndpoint } from './canvasAgentBridge';
import { CanvasAgentSnapshotPublisher } from './canvasAgentSnapshotPublisher';

const endpoint: CanvasAgentEndpoint = {
  url: 'http://127.0.0.1:17372',
  token: 'token',
};

function snapshot(revision: string): CanvasAgentSnapshot {
  return {
    protocolVersion: 2,
    projectId: 'project-1',
    projectName: 'Project',
    revision,
    nodes: [],
    edges: [],
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedImagePreviews: [],
    capabilities: {
      nodeTypes: [],
      operations: ['create_node', 'update_node', 'move_node', 'connect_nodes'],
      actions: ['import_images', 'run_nodes', 'get_node_images'],
      restrictions: [
        'active_project_only',
        'direct_apply',
        'no_delete',
        'no_arbitrary_result_node_creation',
        'explicit_image_reads',
      ],
    },
  };
}

describe('CanvasAgentSnapshotPublisher', () => {
  it('serializes requests and coalesces queued snapshots to the latest revision', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const send = vi.fn()
      .mockImplementationOnce(() => firstRequest)
      .mockResolvedValue(undefined);
    const publisher = new CanvasAgentSnapshotPublisher(() => undefined, send);
    const selection = {};
    const previews: [] = [];

    publisher.enqueue({
      endpoint,
      clientId: 'client-1',
      snapshot: snapshot('revision-1'),
      previewMarker: { selection, previews },
      forcePreviews: true,
    });
    publisher.enqueue({
      endpoint,
      clientId: 'client-1',
      snapshot: snapshot('revision-2'),
      previewMarker: { selection, previews },
      forcePreviews: false,
    });
    publisher.enqueue({
      endpoint,
      clientId: 'client-1',
      snapshot: snapshot('revision-3'),
      previewMarker: { selection, previews },
      forcePreviews: false,
    });

    expect(send).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    expect(send.mock.calls[1]?.[2]).toMatchObject({ revision: 'revision-3' });
    expect(send.mock.calls[1]?.[3]).toEqual({ includeSelectedImagePreviews: false });
  });
});
