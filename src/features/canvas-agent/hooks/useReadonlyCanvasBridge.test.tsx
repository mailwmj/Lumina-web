// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  captureReadonlyCanvasBootstrap,
  clearCapturedReadonlyCanvasBootstrap,
  type ReadonlyCanvasBootstrap,
} from '@/features/canvas-agent/infrastructure/readonlyCanvasBootstrap';
import { useReadonlyCanvasBridge } from './useReadonlyCanvasBridge';

const bridgeMocks = vi.hoisted(() => ({
  buildSnapshot: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@/features/canvas-agent/application/readonlyCanvasSnapshot', () => ({
  buildReadonlyCanvasSnapshot: bridgeMocks.buildSnapshot,
}));

vi.mock('@/features/canvas-agent/infrastructure/readonlyCanvasBridge', () => ({
  connectReadonlyCanvasBridge: bridgeMocks.connect,
  disconnectReadonlyCanvasBridge: bridgeMocks.disconnect,
  publishReadonlyCanvasSnapshot: bridgeMocks.publish,
}));

function BridgeHarness({ revision }: { revision: string }) {
  useReadonlyCanvasBridge({
    projectId: 'project-1',
    projectName: 'Current project',
    projectRevision: revision,
    nodes: [],
    edges: [],
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  return null;
}

describe('useReadonlyCanvasBridge', () => {
  let container: HTMLDivElement;
  let root: Root;
  let capturedBootstrap: ReadonlyCanvasBootstrap | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    bridgeMocks.connect.mockResolvedValue(undefined);
    bridgeMocks.disconnect.mockResolvedValue(undefined);
    bridgeMocks.publish.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (capturedBootstrap) {
      clearCapturedReadonlyCanvasBootstrap(capturedBootstrap);
      capturedBootstrap = null;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not build snapshots while no fragment bootstrap has enabled the bridge', async () => {
    await act(async () => {
      root.render(<BridgeHarness revision="r1" />);
    });
    await act(async () => {
      root.render(<BridgeHarness revision="r2" />);
    });

    expect(bridgeMocks.buildSnapshot).not.toHaveBeenCalled();
  });

  it('coalesces active bridge snapshot construction until canvas changes settle', async () => {
    vi.useFakeTimers();
    const bootstrap = getCapturedBootstrap();
    capturedBootstrap = captureReadonlyCanvasBootstrap({
      hash: `#lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`,
      origin: bootstrap.canonicalOrigin,
      pathname: '/',
      search: '',
    }, { replaceState: () => undefined });

    await act(async () => {
      root.render(<BridgeHarness revision="r1" />);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(bridgeMocks.buildSnapshot).toHaveBeenCalledTimes(1);
    bridgeMocks.buildSnapshot.mockClear();

    await act(async () => {
      root.render(<BridgeHarness revision="r2" />);
    });
    await act(async () => {
      root.render(<BridgeHarness revision="r3" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(99);
    });
    expect(bridgeMocks.buildSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(bridgeMocks.buildSnapshot).toHaveBeenCalledTimes(1);
  });
});

function getCapturedBootstrap(): ReadonlyCanvasBootstrap {
  return {
    endpoint: 'http://127.0.0.1:17372',
    canonicalOrigin: 'http://127.0.0.1:49123',
    sessionId: 'session-1',
    token: 'short-lived-test-token',
    expiresAt: Date.now() + 60_000,
  };
}
