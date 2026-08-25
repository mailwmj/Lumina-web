// @vitest-environment happy-dom

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { WebCanvasEvent } from '@/features/canvas-agent/infrastructure/webCanvasBridge';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCodexWebCanvasBridge, type CodexWebCanvasBridgeState } from './useCodexWebCanvasBridge';

const bridgeMocks = vi.hoisted(() => ({
  bootstrap: {
    bridge: 'web' as const,
    endpoint: 'http://127.0.0.1:17372',
    canonicalOrigin: 'http://127.0.0.1:49123',
    sessionId: 'session-1',
    token: 'short-lived-web-token',
    expiresAt: Date.now() + 60_000,
  },
  callbacks: null as null | {
    onOpen: () => void;
    onEvent: (event: WebCanvasEvent) => void;
  },
  postProposalResult: vi.fn(),
  postActionResult: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  publish: vi.fn(),
  clearBootstrap: vi.fn(),
  enableCodexEditing: vi.fn(),
  requestDelegation: vi.fn(),
  handoffToCodex: vi.fn(),
  abortCodexHandoff: vi.fn(),
  withCodexDelegation: vi.fn(),
  saveCurrentProject: vi.fn(),
  runNodes: vi.fn(),
  importImages: vi.fn(),
  getNodeImages: vi.fn(),
  currentProject: { id: 'project-1', name: 'Project' } as { id: string; name: string } | null,
  editorMode: 'chrome' as 'chrome' | 'codex',
  isReadOnly: false,
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      getCurrentProject: () => bridgeMocks.currentProject,
      isCurrentProjectReadOnly: bridgeMocks.isReadOnly,
      editorState: { mode: bridgeMocks.editorMode },
      saveCurrentProject: bridgeMocks.saveCurrentProject,
    }),
  },
}));

vi.mock('@/runtime/runtimeProjectClient', () => ({
  runtimeProjectClient: {
    handoffToCodex: bridgeMocks.handoffToCodex,
    abortCodexHandoff: bridgeMocks.abortCodexHandoff,
    withCodexDelegation: bridgeMocks.withCodexDelegation,
  },
}));

vi.mock('@/features/canvas-agent/infrastructure/webCanvasBootstrap', () => ({
  captureWebCanvasBootstrap: () => bridgeMocks.bootstrap,
  clearCapturedWebCanvasBootstrap: bridgeMocks.clearBootstrap,
}));

vi.mock('@/features/canvas-agent/infrastructure/webCanvasBridge', () => ({
  connectWebCanvasBridge: bridgeMocks.connect,
  consumeWebCanvasEvents: vi.fn((
    _bootstrap,
    signal: AbortSignal,
    callbacks: typeof bridgeMocks.callbacks,
  ) => {
    bridgeMocks.callbacks = callbacks;
    callbacks?.onOpen();
    return new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }),
  disconnectWebCanvasBridge: bridgeMocks.disconnect,
  enableWebCanvasCodexEditing: bridgeMocks.enableCodexEditing,
  requestWebCanvasDelegation: bridgeMocks.requestDelegation,
  postWebCanvasProposalResult: bridgeMocks.postProposalResult,
  postWebCanvasActionResult: bridgeMocks.postActionResult,
  WebCanvasEvent: {},
}));

vi.mock('@/features/canvas-agent/infrastructure/webCanvasSnapshotPublisher', () => ({
  WebCanvasSnapshotPublisher: class WebCanvasSnapshotPublisher {
    enqueue(...args: unknown[]) {
      bridgeMocks.publish(...args);
    }

    clear() {}
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

let bridgeState: CodexWebCanvasBridgeState | null = null;

function BridgeHarness({ projectId = 'project-1' }: { projectId?: string | null }) {
  const canvas = useCanvasStore();
  bridgeState = useCodexWebCanvasBridge({
    projectId,
    projectName: projectId === 'project-1' ? 'Project' : 'Next project',
    nodes: canvas.nodes,
    edges: canvas.edges,
    selectedNodeIds: [],
    viewport: canvas.currentViewport,
  });
  return null;
}

describe('useCodexWebCanvasBridge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    bridgeState = null;
    bridgeMocks.callbacks = null;
    bridgeMocks.bootstrap.expiresAt = Date.now() + 60_000;
    bridgeMocks.currentProject = { id: 'project-1', name: 'Project' };
    bridgeMocks.editorMode = 'chrome';
    bridgeMocks.isReadOnly = false;
    bridgeMocks.connect.mockResolvedValue(undefined);
    bridgeMocks.disconnect.mockResolvedValue(undefined);
    bridgeMocks.enableCodexEditing.mockResolvedValue(undefined);
    bridgeMocks.requestDelegation.mockResolvedValue({
      token: 'delegation-token',
      actionId: 'action',
      expiresAt: Date.now() + 10_000,
    });
    bridgeMocks.handoffToCodex.mockImplementation(async () => {
      bridgeMocks.editorMode = 'codex';
      return { mode: 'codex', expiresAt: Date.now() + 30_000 };
    });
    bridgeMocks.abortCodexHandoff.mockResolvedValue(undefined);
    bridgeMocks.withCodexDelegation.mockImplementation(async (_delegation, operation) => operation());
    bridgeMocks.saveCurrentProject.mockResolvedValue(undefined);
    bridgeMocks.postProposalResult.mockResolvedValue(undefined);
    bridgeMocks.postActionResult.mockResolvedValue(undefined);
    bridgeMocks.runNodes.mockResolvedValue({ runs: [] });
    bridgeMocks.importImages.mockResolvedValue({ createdNodeIds: [] });
    bridgeMocks.getNodeImages.mockResolvedValue({ projectId: 'project-1', images: [] });
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 0 });
    useCanvasStore.getState().setCanvasData([node], []);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useCanvasStore.getState().setCanvasData([], []);
    vi.unstubAllGlobals();
  });

  it('keeps the current project read-only until the owner grants bounded write access', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());
    const source = useCanvasStore.getState().nodes[0]!;

    await act(async () => {
      bridgeMocks.callbacks?.onEvent({
        type: 'change_proposal',
        payload: changeProposal('proposal-read-only', source.id),
      });
    });
    await vi.waitFor(() => expect(bridgeMocks.postProposalResult).toHaveBeenCalledWith(
      bridgeMocks.bootstrap,
      expect.objectContaining({
        proposalId: 'proposal-read-only',
        status: 'stale',
        error: 'project_write_not_authorized',
      }),
    ));
    expect(useCanvasStore.getState().history.past).toHaveLength(0);

    await act(async () => {
      bridgeMocks.callbacks?.onEvent({
        type: 'action_request',
        payload: {
          actionId: 'import-read-only',
          createdAt: Date.now(),
          request: {
            type: 'import_images',
            projectId: 'project-1',
            images: [{ clientId: 'image', source: 'data:image/png;base64,AA==' }],
          },
        },
      });
    });
    await vi.waitFor(() => expect(bridgeMocks.postActionResult).toHaveBeenCalledWith(
      bridgeMocks.bootstrap,
      expect.objectContaining({
        actionId: 'import-read-only',
        status: 'stale',
        error: 'project_write_not_authorized',
      }),
    ));
    expect(bridgeMocks.importImages).not.toHaveBeenCalled();

    await act(async () => bridgeState?.grantWriteAccess());
    await act(async () => {
      bridgeMocks.callbacks?.onEvent({
        type: 'change_proposal',
        payload: changeProposal('proposal-write', source.id),
      });
    });
    await vi.waitFor(() => expect(bridgeMocks.postProposalResult).toHaveBeenCalledWith(
      bridgeMocks.bootstrap,
      expect.objectContaining({ proposalId: 'proposal-write', status: 'applied' }),
    ));
    expect(useCanvasStore.getState().nodes[0]?.position).toEqual({ x: 240, y: 160 });
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
  });

  it('survives StrictMode effect replay without consuming its one-time bootstrap twice', async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <BridgeHarness />
        </StrictMode>
      );
    });

    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());
    expect(bridgeMocks.connect).toHaveBeenCalledTimes(1);
  });

  it('connects before a project is open and publishes only after one is selected', async () => {
    bridgeMocks.currentProject = null;
    await act(async () => {
      root.render(<BridgeHarness projectId={null} />);
    });

    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());
    expect(bridgeMocks.publish).not.toHaveBeenCalled();

    bridgeMocks.currentProject = { id: 'project-1', name: 'Project' };
    await act(async () => {
      root.render(<BridgeHarness />);
    });

    await vi.waitFor(() => expect(bridgeMocks.publish).toHaveBeenCalledWith(
      bridgeMocks.bootstrap,
      expect.objectContaining({ projectId: 'project-1' }),
      true,
    ));
  });

  it('requires a separate current authorization before starting image generation', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());
    await act(async () => bridgeState?.grantWriteAccess());
    const source = useCanvasStore.getState().nodes[0]!;

    await act(async () => {
      bridgeMocks.callbacks?.onEvent({
        type: 'action_request',
        payload: {
          actionId: 'run-1',
          createdAt: Date.now(),
          request: {
            type: 'run_nodes',
            projectId: 'project-1',
            nodeIds: [source.id],
          },
        },
      });
    });
    await vi.waitFor(() => expect(bridgeState?.pendingRunAuthorization).toMatchObject({
      actionId: 'run-1',
      nodeIds: [source.id],
    }));
    expect(bridgeMocks.runNodes).not.toHaveBeenCalled();

    await act(async () => bridgeState?.grantRunAuthorization());
    await vi.waitFor(() => expect(bridgeMocks.runNodes).toHaveBeenCalledWith(
      [source.id],
      expect.objectContaining({ assertCurrent: expect.any(Function) }),
    ));
    await vi.waitFor(() => expect(bridgeMocks.postActionResult).toHaveBeenCalledWith(
      bridgeMocks.bootstrap,
      expect.objectContaining({ actionId: 'run-1', status: 'applied' }),
    ));
  });

  it('disconnects and clears the bound bootstrap when the active project changes', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());
    bridgeMocks.currentProject = { id: 'project-2', name: 'Next project' };

    await act(async () => {
      root.render(<BridgeHarness projectId="project-2" />);
    });
    await vi.waitFor(() => expect(bridgeMocks.disconnect).toHaveBeenCalledWith(bridgeMocks.bootstrap));
    expect(bridgeMocks.clearBootstrap).toHaveBeenCalledWith(bridgeMocks.bootstrap);
  });

  it('invalidates an in-flight import when the Web bridge closes without changing projects', async () => {
    let assertCurrent: (() => void) | undefined;
    let releaseImport!: () => void;
    bridgeMocks.importImages.mockImplementation(({ assertCurrent: guard }) => {
      assertCurrent = guard;
      return new Promise((resolve) => {
        releaseImport = () => resolve({ createdNodeIds: [] });
      });
    });
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());
    await act(async () => bridgeState?.grantWriteAccess());

    await act(async () => {
      bridgeMocks.callbacks?.onEvent({
        type: 'action_request',
        payload: {
          actionId: 'import-disconnected',
          createdAt: Date.now(),
          request: {
            type: 'import_images',
            projectId: 'project-1',
            images: [{ clientId: 'image', source: 'data:image/png;base64,AA==' }],
          },
        },
      });
    });
    await vi.waitFor(() => expect(assertCurrent).toBeTypeOf('function'));

    await act(async () => root.unmount());
    expect(assertCurrent).toThrow(/canvas_disconnected/);
    releaseImport();
  });

  it('invalidates a generation guard when the Web bridge closes after approval', async () => {
    let assertCurrent: (() => void) | undefined;
    let releaseRun!: () => void;
    bridgeMocks.runNodes.mockImplementation((_nodeIds, { assertCurrent: guard }) => {
      assertCurrent = guard;
      return new Promise((resolve) => {
        releaseRun = () => resolve({ runs: [] });
      });
    });
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());
    await act(async () => bridgeState?.grantWriteAccess());
    const source = useCanvasStore.getState().nodes[0]!;

    await act(async () => {
      bridgeMocks.callbacks?.onEvent({
        type: 'action_request',
        payload: {
          actionId: 'run-disconnected',
          createdAt: Date.now(),
          request: {
            type: 'run_nodes',
            projectId: 'project-1',
            nodeIds: [source.id],
          },
        },
      });
    });
    await vi.waitFor(() => expect(bridgeState?.pendingRunAuthorization).not.toBeNull());
    await act(async () => bridgeState?.grantRunAuthorization());
    await vi.waitFor(() => expect(assertCurrent).toBeTypeOf('function'));

    await act(async () => root.unmount());
    expect(assertCurrent).toThrow(/canvas_disconnected/);
    releaseRun();
  });

  it('continues to apply a proposal after its connected bootstrap expires', async () => {
    await act(async () => {
      root.render(<BridgeHarness />);
    });
    await vi.waitFor(() => expect(bridgeMocks.callbacks).not.toBeNull());
    await act(async () => bridgeState?.grantWriteAccess());
    const source = useCanvasStore.getState().nodes[0]!;
    bridgeMocks.bootstrap.expiresAt = Date.now() - 1;

    await act(async () => {
      bridgeMocks.callbacks?.onEvent({
        type: 'change_proposal',
        payload: changeProposal('proposal-expired', source.id),
      });
    });

    await vi.waitFor(() => expect(bridgeMocks.postProposalResult).toHaveBeenCalledWith(
      bridgeMocks.bootstrap,
      expect.objectContaining({ proposalId: 'proposal-expired', status: 'applied' }),
    ));
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
  });
});

function changeProposal(proposalId: string, nodeId: string) {
  return {
    proposalId,
    createdAt: Date.now(),
    changeSet: {
      projectId: 'project-1',
      summary: 'Move the note',
      operations: [{
        type: 'move_node',
        nodeId,
        position: { x: 240, y: 160 },
      }],
    },
  };
}
