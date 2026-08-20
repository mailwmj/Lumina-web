import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  runImageGenerationNode,
  runImageGenerationNodes,
} from './imageGenerationRun';

const gateway = vi.hoisted(() => ({
  setApiKey: vi.fn(),
  submitGenerateImageJobs: vi.fn(),
}));

vi.mock('@/features/canvas/application/canvasServices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/canvas/application/canvasServices')>();
  return {
    ...actual,
    canvasAiGateway: {
      ...actual.canvasAiGateway,
      setApiKey: gateway.setApiKey,
      submitGenerateImageJobs: gateway.submitGenerateImageJobs,
    },
  };
});

describe('shared image generation execution', () => {
  beforeEach(() => {
    gateway.setApiKey.mockResolvedValue(undefined);
    gateway.submitGenerateImageJobs.mockImplementation(async (
      _payload: unknown,
      outputCount: number,
      onSettled: (result: { status: 'fulfilled'; jobId: string }, index: number) => void,
      beforeSubmit?: () => void
    ) => {
      beforeSubmit?.();
      return Array.from({ length: outputCount }, (_, index) => {
        const result = { status: 'fulfilled' as const, jobId: `job-${index + 1}` };
        onSettled(result, index);
        return result;
      });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    useCanvasStore.getState().setCanvasData([], []);
    useSettingsStore.setState({
      openAiImageApi: {
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        modelCatalog: null,
        selectedModelIds: [],
      },
      lastImageModelSelection: null,
    });
  });

  it('rejects nodes outside the existing image-generation node type', async () => {
    const upload = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 });
    useCanvasStore.getState().setCanvasData([upload], []);

    await expect(runImageGenerationNode(upload.id)).rejects.toMatchObject({
      code: 'NODE_NOT_FOUND',
    });
  });

  it('isolates invalid node failures in a batch without creating result nodes', async () => {
    const upload = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 });
    useCanvasStore.getState().setCanvasData([upload], []);

    const result = await runImageGenerationNodes([upload.id, 'missing']);

    expect(result.runs).toEqual([
      expect.objectContaining({ status: 'failed', sourceNodeId: upload.id }),
      expect.objectContaining({ status: 'failed', sourceNodeId: 'missing' }),
    ]);
    expect(useCanvasStore.getState().nodes).toEqual([upload]);
  });

  it('names generated results after the source node instead of its prompt', async () => {
    const source = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, {
      displayName: 'Sweater front full-body',
      prompt: 'A very long production prompt that should remain in node data, not the result title.',
      model: 'ai-media/gpt-image-2',
      requestAspectRatio: '4:5',
      outputCount: 1,
    });
    useCanvasStore.getState().setCanvasData([source], []);
    useSettingsStore.setState({
      openAiImageApi: {
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        modelCatalog: {
          models: [{ id: 'ai-media/gpt-image-2' }],
          refreshedAt: 1,
        },
        selectedModelIds: ['ai-media/gpt-image-2'],
      },
      lastImageModelSelection: {
        providerId: 'ai-media',
        modelId: 'ai-media/gpt-image-2',
      },
    });

    const result = await runImageGenerationNode(source.id);
    const resultNode = useCanvasStore.getState().nodes.find(
      (node) => node.id === result.resultNodeIds[0]
    );

    expect(resultNode?.data.displayName).toBe('Sweater front full-body · 结果');
    expect(resultNode?.data.displayName).not.toContain('production prompt');
  });

  it('registers its result nodes before revalidating the authorized canvas', async () => {
    const source = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, {
      prompt: 'Create one product image.',
      model: 'ai-media/gpt-image-2',
      requestAspectRatio: '1:1',
      outputCount: 1,
    });
    useCanvasStore.getState().setCanvasData([source], []);
    useSettingsStore.setState({
      openAiImageApi: {
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        modelCatalog: {
          models: [{ id: 'ai-media/gpt-image-2' }],
          refreshedAt: 1,
        },
        selectedModelIds: ['ai-media/gpt-image-2'],
      },
      lastImageModelSelection: {
        providerId: 'ai-media',
        modelId: 'ai-media/gpt-image-2',
      },
    });
    const ownedResultNodeIds = new Set<string>();

    const result = await runImageGenerationNode(source.id, {
      assertCurrent: (newResultNodeIds = []) => {
        newResultNodeIds.forEach((nodeId) => ownedResultNodeIds.add(nodeId));
        const unexpectedNode = useCanvasStore.getState().nodes.find(
          (node) => node.id !== source.id && !ownedResultNodeIds.has(node.id)
        );
        if (unexpectedNode) {
          throw new Error(`Unregistered canvas mutation: ${unexpectedNode.id}`);
        }
      },
    });

    expect(result.submissions).toEqual([
      expect.objectContaining({ status: 'submitted', resultNodeId: result.resultNodeIds[0] }),
    ]);
  });

  it('revalidates after asynchronous request preparation before creating jobs or result nodes', async () => {
    const source = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, {
      prompt: 'Authorized prompt',
      model: 'ai-media/gpt-image-2',
      requestAspectRatio: '1:1',
      outputCount: 1,
    });
    useCanvasStore.getState().setCanvasData([source], []);
    useSettingsStore.setState({
      openAiImageApi: {
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        modelCatalog: {
          models: [{ id: 'ai-media/gpt-image-2' }],
          refreshedAt: 1,
        },
        selectedModelIds: ['ai-media/gpt-image-2'],
      },
      lastImageModelSelection: {
        providerId: 'ai-media',
        modelId: 'ai-media/gpt-image-2',
      },
    });
    let finishPreparation: (() => void) | undefined;
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    let providerSubmitted = false;
    gateway.submitGenerateImageJobs.mockImplementation(async (
      _payload: unknown,
      _outputCount: number,
      _onSettled: unknown,
      beforeSubmit?: () => void
    ) => {
      await preparation;
      beforeSubmit?.();
      providerSubmitted = true;
      return [];
    });
    const staleError = new Error('canvas_changed');
    let stale = false;
    const run = runImageGenerationNodes([source.id], {
      assertCurrent: () => {
        if (stale) {
          throw staleError;
        }
      },
    });
    await vi.waitFor(() => expect(gateway.submitGenerateImageJobs).toHaveBeenCalled());

    stale = true;
    finishPreparation?.();

    await expect(run).rejects.toBe(staleError);
    expect(providerSubmitted).toBe(false);
    expect(useCanvasStore.getState().nodes).toEqual([source]);
  });

  it('does not downgrade an already submitted batch to stale', async () => {
    const source = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, {
      prompt: 'Authorized prompt',
      model: 'ai-media/gpt-image-2',
      requestAspectRatio: '1:1',
      outputCount: 1,
    });
    useCanvasStore.getState().setCanvasData([source], []);
    useSettingsStore.setState({
      openAiImageApi: {
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        modelCatalog: {
          models: [{ id: 'ai-media/gpt-image-2' }],
          refreshedAt: 1,
        },
        selectedModelIds: ['ai-media/gpt-image-2'],
      },
      lastImageModelSelection: {
        providerId: 'ai-media',
        modelId: 'ai-media/gpt-image-2',
      },
    });
    let providerSubmitted = false;
    gateway.submitGenerateImageJobs.mockImplementation(async (
      _payload: unknown,
      _outputCount: number,
      onSettled: (result: { status: 'fulfilled'; jobId: string }, index: number) => void,
      beforeSubmit?: () => void
    ) => {
      beforeSubmit?.();
      providerSubmitted = true;
      const submission = { status: 'fulfilled' as const, jobId: 'job-submitted' };
      onSettled(submission, 0);
      return [submission];
    });

    const result = await runImageGenerationNodes([source.id], {
      assertCurrent: () => {
        if (providerSubmitted) {
          throw new Error('canvas_changed_after_submission');
        }
      },
    });

    expect(result.runs).toEqual([
      expect.objectContaining({
        status: 'started',
        submissions: [expect.objectContaining({ jobId: 'job-submitted' })],
      }),
    ]);
  });

  it('initializes each custom Gemini configuration independently in one batch', async () => {
    const firstProviderId = 'custom-openai:gemini-first' as const;
    const secondProviderId = 'custom-openai:gemini-second' as const;
    const firstModelId = `${firstProviderId}/gemini-3-pro-image-preview`;
    const secondModelId = `${secondProviderId}/gemini-3-pro-image-preview`;
    const firstSource = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, {
      prompt: 'First image',
      model: firstModelId,
      requestAspectRatio: '1:1',
      outputCount: 1,
    });
    const secondSource = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.imageEdit, { x: 400, y: 0 }, {
      prompt: 'Second image',
      model: secondModelId,
      requestAspectRatio: '1:1',
      outputCount: 1,
    });
    useCanvasStore.getState().setCanvasData([firstSource, secondSource], []);
    useSettingsStore.setState({
      customImageApis: [
        {
          id: firstProviderId,
          name: 'Gemini First',
          protocol: 'gemini-native',
          apiKey: 'first-key',
          baseUrl: 'https://first.example/v1beta',
          modelCatalog: {
            models: [{ id: firstModelId }],
            refreshedAt: 1,
          },
          selectedModelIds: [firstModelId],
        },
        {
          id: secondProviderId,
          name: 'Gemini Second',
          protocol: 'gemini-native',
          apiKey: 'second-key',
          baseUrl: 'https://second.example/v1beta',
          modelCatalog: {
            models: [{ id: secondModelId }],
            refreshedAt: 1,
          },
          selectedModelIds: [secondModelId],
        },
      ],
    });

    await runImageGenerationNodes([firstSource.id, secondSource.id]);

    expect(gateway.setApiKey).toHaveBeenCalledTimes(2);
    expect(gateway.setApiKey).toHaveBeenCalledWith('gemini', 'first-key');
    expect(gateway.setApiKey).toHaveBeenCalledWith('gemini', 'second-key');
  });
});
