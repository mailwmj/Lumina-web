import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { runVideoGenerationNodes } from './videoGenerationRun';

const gateway = vi.hoisted(() => ({
  submitGenerateVideoJob: vi.fn(),
}));

vi.mock('@/features/canvas/application/canvasServices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/canvas/application/canvasServices')>();
  return {
    ...actual,
    canvasAiGateway: {
      ...actual.canvasAiGateway,
      submitGenerateVideoJob: gateway.submitGenerateVideoJob,
    },
  };
});

describe('shared video generation execution', () => {
  beforeEach(() => {
    gateway.submitGenerateVideoJob.mockResolvedValue({
      jobId: 'web-video-1',
      requestId: 'provider-task-1',
      taskHandle: {
        version: 1,
        kind: 'browser-direct',
        externalTaskId: 'provider-task-1',
        protocol: 'volcengine-seedance',
        baseUrl: 'https://video.example.test/v1',
        model: 'doubao-seedance-2-0-260128',
      },
    });
    useSettingsStore.setState({
      videoApis: [{
        id: 'video-api',
        name: 'Seedance',
        apiKey: 'secret-video-key',
        baseUrl: 'https://video.example.test/v1',
        modelId: 'doubao-seedance-2-0-260128',
        enabled: true,
        protocol: 'volcengine-seedance',
      }],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('submits one task for one source node and stores only credential-free recovery state', async () => {
    const source = canvasNodeFactory.createNode(
      CANVAS_NODE_TYPES.seedanceAutoVideo,
      { x: 0, y: 0 },
      {
        prompt: 'A slow orbit around the product.',
        model: 'doubao-seedance-2-0-260128',
        videoApiId: 'video-api',
        resolution: '720p',
        duration: 5,
        aspectRatio: '16:9',
      },
    );
    useCanvasStore.getState().setCanvasData([source], []);

    const result = await runVideoGenerationNodes([source.id, source.id], {
      fallbackResultTitle: 'Localized video result',
    });

    expect(gateway.submitGenerateVideoJob).toHaveBeenCalledTimes(1);
    expect(result.runs).toEqual([expect.objectContaining({
      status: 'started',
      sourceNodeId: source.id,
      resultNodeId: expect.any(String),
      jobId: 'web-video-1',
    })]);
    const run = result.runs[0];
    expect(run?.status).toBe('started');
    if (!run || run.status !== 'started') {
      throw new Error('Expected the video submission to start.');
    }
    const output = useCanvasStore.getState().nodes.find(
      (node) => node.id === run.resultNodeId,
    );
    expect(output?.type).toBe(CANVAS_NODE_TYPES.exportVideo);
    expect(output?.data).toMatchObject({
      generationJobId: 'web-video-1',
      generationProviderRequestId: 'provider-task-1',
      generationTaskHandle: expect.objectContaining({ externalTaskId: 'provider-task-1' }),
      isGenerating: true,
      displayName: 'Localized video result',
    });
    expect(JSON.stringify(output?.data)).not.toContain('secret-video-key');
  });

  it.each([
    CANVAS_NODE_TYPES.videoSingle,
    CANVAS_NODE_TYPES.seedanceAutoVideo,
  ])('submits supported %s nodes', async (nodeType) => {
    const source = canvasNodeFactory.createNode(nodeType, { x: 0, y: 0 }, {
      prompt: 'A slow orbit around the product.',
      model: 'doubao-seedance-2-0-260128',
      videoApiId: 'video-api',
      resolution: '720p',
      duration: 5,
      aspectRatio: '16:9',
    });
    useCanvasStore.getState().setCanvasData([source], []);

    const result = await runVideoGenerationNodes([source.id]);

    expect(result.runs).toEqual([expect.objectContaining({
      status: 'started',
      sourceNodeId: source.id,
      submissionStatus: 'submitted',
    })]);
    expect(gateway.submitGenerateVideoJob).toHaveBeenCalledTimes(1);
  });

  it('submits a strict first-last frame video node', async () => {
    const first = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {
      imageUrl: 'https://media.example.test/first.png',
    });
    const last = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 200 }, {
      imageUrl: 'https://media.example.test/last.png',
    });
    const source = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.videoFrame, { x: 400, y: 0 }, {
      prompt: 'The product turns between the two frames.',
      model: 'doubao-seedance-2-0-260128',
      videoApiId: 'video-api',
      resolution: '720p',
      duration: 5,
      aspectRatio: '16:9',
    });
    useCanvasStore.getState().setCanvasData([first, last, source], [{
      id: 'first-edge',
      source: first.id,
      target: source.id,
      sourceHandle: 'source',
      targetHandle: 'target-first',
      data: { valueType: 'image', inputOrder: 0 },
    }, {
      id: 'last-edge',
      source: last.id,
      target: source.id,
      sourceHandle: 'source',
      targetHandle: 'target-last',
      data: { valueType: 'image', inputOrder: 1 },
    }]);

    const result = await runVideoGenerationNodes([source.id]);

    expect(result.runs).toEqual([expect.objectContaining({
      status: 'started',
      sourceNodeId: source.id,
      submissionStatus: 'submitted',
    })]);
    expect(gateway.submitGenerateVideoJob).toHaveBeenCalledWith(expect.objectContaining({
      videoContent: expect.arrayContaining([
        expect.objectContaining({ type: 'image_url', role: 'first_frame' }),
        expect.objectContaining({ type: 'image_url', role: 'last_frame' }),
      ]),
    }));
  });

  it('rejects unsupported sd2VideoGen nodes without submitting', async () => {
    const source = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.sd2VideoGen, { x: 0, y: 0 });
    useCanvasStore.getState().setCanvasData([source], []);

    const result = await runVideoGenerationNodes([source.id]);

    expect(result.runs).toEqual([expect.objectContaining({
      status: 'failed',
      sourceNodeId: source.id,
    })]);
    expect(gateway.submitGenerateVideoJob).not.toHaveBeenCalled();
  });

  it('fails closed when authorization becomes stale immediately before submission', async () => {
    const source = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.seedanceAutoVideo, { x: 0, y: 0 }, {
      prompt: 'A slow orbit around the product.',
      model: 'doubao-seedance-2-0-260128',
      videoApiId: 'video-api',
      resolution: '720p',
      duration: 5,
      aspectRatio: '16:9',
    });
    useCanvasStore.getState().setCanvasData([source], []);
    let resultGuardCalls = 0;

    await expect(runVideoGenerationNodes([source.id], {
      assertCurrent: (ownedResultNodeIds = []) => {
        if (ownedResultNodeIds.length > 0 && ++resultGuardCalls === 2) {
          throw new Error('authorization expired');
        }
      },
    })).rejects.toThrow('authorization expired');
    expect(gateway.submitGenerateVideoJob).not.toHaveBeenCalled();
  });

  it('records a provider failure once without retrying the billable submission', async () => {
    gateway.submitGenerateVideoJob.mockRejectedValueOnce(new Error('provider unavailable'));
    const source = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.seedanceAutoVideo, { x: 0, y: 0 }, {
      prompt: 'A slow orbit around the product.',
      model: 'doubao-seedance-2-0-260128',
      videoApiId: 'video-api',
      resolution: '720p',
      duration: 5,
      aspectRatio: '16:9',
    });
    useCanvasStore.getState().setCanvasData([source], []);

    const result = await runVideoGenerationNodes([source.id, source.id]);

    expect(gateway.submitGenerateVideoJob).toHaveBeenCalledTimes(1);
    expect(result.runs).toEqual([expect.objectContaining({
      status: 'started',
      sourceNodeId: source.id,
      submissionStatus: 'failed',
      error: 'provider unavailable',
    })]);
  });
});
