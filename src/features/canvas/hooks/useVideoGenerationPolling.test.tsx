// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useVideoGenerationPolling } from './useVideoGenerationPolling';

const testState = vi.hoisted(() => ({
  nodes: [] as CanvasNode[],
}));
const gateway = vi.hoisted(() => ({
  getGenerateImageJob: vi.fn(),
  retryGenerateImageJob: vi.fn(),
}));

vi.mock('@/features/canvas/application/canvasServices', () => ({
  canvasAiGateway: gateway,
  getCanvasAssetRepository: vi.fn(),
}));

vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: {
    getState: () => testState,
  },
}));

vi.mock('@/runtime/runtime', () => ({
  runtime: {
    isDesktop: () => true,
  },
}));

vi.mock('@/commands/image', () => ({
  autoSaveVideoToProject: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function pendingNode(): CanvasNode {
  return {
    id: 'video-result-1',
    type: 'exportVideoNode',
    position: { x: 0, y: 0 },
    data: {
      isGenerating: true,
      generationJobId: 'job-1',
      generationTaskHandle: null,
      generationProviderId: 'volcvideo',
      generationProviderRequestId: null,
      generationClientSessionId: null,
      generationRecoveryState: null,
      generationRetryCount: 0,
      generationNextRetryAt: null,
      generationRetryError: null,
      model: 'doubao-seedance-2-0-260128',
      videoApiId: 'video-api-1',
    },
  } as CanvasNode;
}

describe('useVideoGenerationPolling', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    testState.nodes = [pendingNode()];
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ignores a late cancelled response after local cancellation clears the current job', async () => {
    const poll = deferred<{
      job_id: string;
      status: 'cancelled';
      result: null;
      error: string;
    }>();
    gateway.getGenerateImageJob.mockReturnValue(poll.promise);
    const updateNodeData = vi.fn();
    const updateNodeDataWithoutHistory = vi.fn();

    function Harness() {
      useVideoGenerationPolling({
        nodes: testState.nodes,
        videoApis: [],
        getCurrentProject: () => ({ id: 'project-1' }),
        updateNodeData,
        updateNodeDataWithoutHistory,
        t: (key) => key,
      });
      return null;
    }

    await act(async () => {
      root = createRoot(container);
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(gateway.getGenerateImageJob).toHaveBeenCalledWith('job-1', undefined, null);

    testState.nodes = [{
      ...pendingNode(),
      data: {
        ...pendingNode().data,
        isGenerating: false,
        generationJobId: null,
      },
    } as CanvasNode];
    await act(async () => {
      poll.resolve({
        job_id: 'job-1',
        status: 'cancelled',
        result: null,
        error: 'cancelled by provider',
      });
      await Promise.resolve();
    });

    expect(updateNodeData).not.toHaveBeenCalled();
    expect(updateNodeDataWithoutHistory).not.toHaveBeenCalled();
  });
});
