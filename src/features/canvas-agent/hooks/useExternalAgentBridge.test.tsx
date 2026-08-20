// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { buildCanvasAgentSnapshot } from '@/features/canvas-agent/application/canvasAgentSnapshot';
import type { CanvasAgentEvent } from '@/features/canvas-agent/infrastructure/canvasAgentBridge';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useExternalAgentBridge } from './useExternalAgentBridge';

const bridgeMocks = vi.hoisted(() => ({
  callbacks: null as null | {
    onOpen: () => void;
    onEvent: (event: CanvasAgentEvent) => void;
  },
  postResult: vi.fn(),
  postActionResult: vi.fn(),
  importImages: vi.fn(),
  runNodes: vi.fn(),
  getNodeImages: vi.fn(),
}));

vi.mock('@/commands/canvasAgent', () => ({
  isCanvasAgentManagedByLumina: () => false,
  getCanvasAgentRuntime: vi.fn(),
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      getCurrentProject: () => ({ id: 'project-1', name: 'Project' }),
    }),
  },
}));

vi.mock('@/features/canvas-agent/application/importCanvasAgentImages', () => ({
  importCanvasAgentImages: bridgeMocks.importImages,
}));

vi.mock('@/features/canvas-agent/application/canvasAgentNodeImages', () => ({
  buildCanvasAgentNodeImages: bridgeMocks.getNodeImages,
}));

vi.mock('@/features/canvas/application/imageGenerationRun', () => ({
  runImageGenerationNodes: bridgeMocks.runNodes,
}));

vi.mock('@/features/canvas-agent/infrastructure/canvasAgentBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/canvas-agent/infrastructure/canvasAgentBridge')>();
  return {
    ...actual,
    consumeCanvasAgentEvents: vi.fn((
      _endpoint,
      _clientId,
      signal: AbortSignal,
      callbacks: typeof bridgeMocks.callbacks
    ) => {
      bridgeMocks.callbacks = callbacks;
      callbacks?.onOpen();
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }),
    postCanvasProposalResult: bridgeMocks.postResult,
    postCanvasActionResult: bridgeMocks.postActionResult,
  };
});

vi.mock('@/features/canvas-agent/infrastructure/canvasAgentSnapshotPublisher', () => ({
  CanvasAgentSnapshotPublisher: class CanvasAgentSnapshotPublisher {
    enqueue() {}
  },
}));

function BridgeHarness() {
  const canvas = useCanvasStore();
  useExternalAgentBridge({
    projectId: 'project-1',
    projectName: 'Project',
    nodes: canvas.nodes,
    edges: canvas.edges,
    selectedNodeIds: [],
    viewport: canvas.currentViewport,
  });
  return null;
}

describe('useExternalAgentBridge direct apply', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    bridgeMocks.callbacks = null;
    bridgeMocks.postResult.mockResolvedValue(undefined);
    bridgeMocks.postActionResult.mockResolvedValue(undefined);
    bridgeMocks.importImages.mockResolvedValue({ createdNodeIds: ['upload-1'] });
    bridgeMocks.runNodes.mockResolvedValue({ runs: [] });
    bridgeMocks.getNodeImages.mockResolvedValue({ projectId: 'project-1', images: [] });
    useSettingsStore.getState().setExternalAgentConnection({
      enabled: true,
      url: 'http://127.0.0.1:17372',
      token: 'test-token',
    });
    const node = canvasNodeFactory.createNode(
      CANVAS_NODE_TYPES.textAnnotation,
      { x: 0, y: 0 }
    );
    useCanvasStore.getState().setCanvasData([node], []);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useCanvasStore.getState().setCanvasData([], []);
    useSettingsStore.getState().setExternalAgentConnection({
      enabled: false,
      url: 'http://127.0.0.1:17372',
      token: '',
    });
    vi.unstubAllGlobals();
  });

  it('applies a valid event immediately and records one undo checkpoint', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());

    const canvas = useCanvasStore.getState();
    const node = canvas.nodes[0];
    const snapshot = buildCanvasAgentSnapshot({
      projectId: 'project-1',
      projectName: 'Project',
      nodes: canvas.nodes,
      edges: canvas.edges,
      selectedNodeIds: [],
      viewport: canvas.currentViewport,
    });

    await act(async () => {
      bridgeMocks.callbacks?.onEvent({
        type: 'change_proposal',
        payload: {
          proposalId: 'proposal-1',
          createdAt: Date.now(),
          changeSet: {
            projectId: 'project-1',
            baseRevision: snapshot.revision,
            summary: 'Move the note',
            operations: [{
              type: 'move_node',
              nodeId: node.id,
              position: { x: 240, y: 160 },
            }],
          },
        },
      });
    });

    expect(useCanvasStore.getState().nodes[0]?.position).toEqual({ x: 240, y: 160 });
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    await vi.waitFor(() => expect(bridgeMocks.postResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ proposalId: 'proposal-1', status: 'applied' })
    ));
  });

  it('runs image nodes through the shared generation action and reports the direct result', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());
    const canvas = useCanvasStore.getState();
    const sourceNodeId = canvas.nodes[0].id;
    const snapshot = buildCanvasAgentSnapshot({
      projectId: 'project-1',
      projectName: 'Project',
      nodes: canvas.nodes,
      edges: canvas.edges,
      selectedNodeIds: [],
      viewport: canvas.currentViewport,
    });
    bridgeMocks.runNodes.mockResolvedValue({
      runs: [{ status: 'started', sourceNodeId, resultNodeIds: ['result-1'], submissions: [] }],
    });

    await act(async () => {
      bridgeMocks.callbacks?.onEvent({
        type: 'action_request',
        payload: {
          actionId: 'action-1',
          createdAt: Date.now(),
          request: {
            type: 'run_nodes',
            projectId: 'project-1',
            baseRevision: snapshot.revision,
            nodeIds: [sourceNodeId],
          },
        },
      });
    });

    await vi.waitFor(() => expect(bridgeMocks.runNodes).toHaveBeenCalledWith(
      [sourceNodeId],
      expect.objectContaining({ assertCurrent: expect.any(Function) })
    ));
    await vi.waitFor(() => expect(bridgeMocks.postActionResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ actionId: 'action-1', status: 'applied' })
    ));
  });

  it('rejects a run when the authorized canvas changes before submission', async () => {
    let continueRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      continueRun = resolve;
    });
    bridgeMocks.runNodes.mockImplementation(async (
      _nodeIds: string[],
      options: { assertCurrent?: (ownedResultNodeIds?: readonly string[]) => void }
    ) => {
      await runGate;
      options.assertCurrent?.();
      return { runs: [] };
    });
    const source = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, {
      prompt: 'Authorized prompt',
    });
    useCanvasStore.getState().setCanvasData([source], []);
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());
    const canvas = useCanvasStore.getState();
    const snapshot = buildCanvasAgentSnapshot({
      projectId: 'project-1',
      projectName: 'Project',
      nodes: canvas.nodes,
      edges: canvas.edges,
      selectedNodeIds: [],
      viewport: canvas.currentViewport,
    });

    await act(async () => {
      bridgeMocks.callbacks?.onEvent({
        type: 'action_request',
        payload: {
          actionId: 'action-concurrent-change',
          createdAt: Date.now(),
          request: {
            type: 'run_nodes',
            projectId: 'project-1',
            baseRevision: snapshot.revision,
            nodeIds: [source.id],
          },
        },
      });
    });
    await vi.waitFor(() => expect(bridgeMocks.runNodes).toHaveBeenCalled());

    act(() => {
      useCanvasStore.getState().updateNodeData(source.id, { prompt: 'Changed after authorization' });
    });
    continueRun?.();

    await vi.waitFor(() => expect(bridgeMocks.postActionResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        actionId: 'action-concurrent-change',
        status: 'stale',
        error: 'canvas_changed',
      })
    ));
  });

  it('rejects an action whose canvas revision is already stale', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());

    await act(async () => {
      bridgeMocks.callbacks?.onEvent({
        type: 'action_request',
        payload: {
          actionId: 'action-stale',
          createdAt: Date.now(),
          request: {
            type: 'import_images',
            projectId: 'project-1',
            baseRevision: 'old-revision',
            images: [{ clientId: 'model', source: '/tmp/model.png' }],
          },
        },
      });
    });

    expect(bridgeMocks.importImages).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(bridgeMocks.postActionResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        actionId: 'action-stale',
        status: 'stale',
        error: 'canvas_changed',
      })
    ));
  });
});
