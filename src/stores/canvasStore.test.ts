import { afterEach, describe, expect, it } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { createImageReferencePromptToken } from '@/features/canvas/application/imageReferencePrompt';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

import { useCanvasStore } from './canvasStore';
import {
  createDefaultChaomoImageApiConfig,
  createDefaultOpenAiImageApiConfig,
  useSettingsStore,
} from './settingsStore';

function createNode(type: CanvasNode['type'], id: string): CanvasNode {
  return {
    ...canvasNodeFactory.createNode(type, { x: 0, y: 0 }),
    id,
  };
}

function imageInputEdge(id: string, source: string, target: string, inputOrder: number): CanvasEdge {
  return {
    id,
    source,
    target,
    sourceHandle: 'source',
    targetHandle: 'target',
    data: { valueType: 'image', inputOrder },
  };
}

describe('canvas store batch connections', () => {
  afterEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('records a batch as one undoable history step', () => {
    const sourceA = createNode(CANVAS_NODE_TYPES.upload, 'source-a');
    const sourceB = createNode(CANVAS_NODE_TYPES.upload, 'source-b');
    const target = createNode(CANVAS_NODE_TYPES.imageEdit, 'target');
    const store = useCanvasStore.getState();

    store.setCanvasData([sourceA, sourceB, target], []);

    const addedCount = useCanvasStore.getState().onConnectBatch([
      {
        source: sourceA.id,
        target: target.id,
        sourceHandle: 'source',
        targetHandle: 'target',
      },
      {
        source: sourceB.id,
        target: target.id,
        sourceHandle: 'source',
        targetHandle: 'target',
      },
    ]);

    expect(addedCount).toBe(2);
    expect(useCanvasStore.getState().edges).toHaveLength(2);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().edges).toHaveLength(0);

    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().edges).toHaveLength(2);
  });

  it('creates and connects a node batch as one undoable history step', () => {
    const source = createNode(CANVAS_NODE_TYPES.imageEdit, 'source');
    const store = useCanvasStore.getState();
    store.setCanvasData([source], []);

    const resultIds = useCanvasStore.getState().addNodeBatch(
      Array.from({ length: 4 }, (_, index) => ({
        type: CANVAS_NODE_TYPES.exportImage,
        position: { x: 300, y: index * 196 },
      }))
    );
    resultIds.forEach((resultId) => {
      useCanvasStore.getState().addEdge(source.id, resultId);
    });

    expect(useCanvasStore.getState().nodes).toHaveLength(5);
    expect(useCanvasStore.getState().edges).toHaveLength(4);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual([source.id]);
    expect(useCanvasStore.getState().edges).toHaveLength(0);

    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(5);
    expect(useCanvasStore.getState().edges).toHaveLength(4);
  });
});

describe('canvas store image reference cleanup', () => {
  afterEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('removes only the disconnected edge tag in the same undo step', () => {
    const red = createNode(CANVAS_NODE_TYPES.upload, 'red');
    const yellow = createNode(CANVAS_NODE_TYPES.upload, 'yellow');
    const target = createNode(CANVAS_NODE_TYPES.textGeneration, 'target');
    target.data = {
      ...target.data,
      inputText: [
        '衣服参考',
        createImageReferencePromptToken('red-edge'),
        '；帽子参考',
        createImageReferencePromptToken('yellow-edge'),
        '。',
      ].join(''),
    };
    useCanvasStore.getState().setCanvasData([red, yellow, target], [
      imageInputEdge('red-edge', red.id, target.id, 0),
      imageInputEdge('yellow-edge', yellow.id, target.id, 1),
    ]);

    useCanvasStore.getState().deleteEdge('red-edge');

    expect(useCanvasStore.getState().edges.map((edge) => edge.id)).toEqual(['yellow-edge']);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === target.id)?.data)
      .toMatchObject({
        inputText: `衣服参考；帽子参考${createImageReferencePromptToken('yellow-edge')}。`,
      });
    expect(useCanvasStore.getState().history.past).toHaveLength(1);

    // React Flow can report an already-removed edge after a node removal path;
    // that acknowledgement must not create a second, no-op undo checkpoint.
    useCanvasStore.getState().onEdgesChange([{ id: 'red-edge', type: 'remove' }]);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().edges.map((edge) => edge.id)).toEqual([
      'red-edge',
      'yellow-edge',
    ]);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === target.id)?.data)
      .toMatchObject({
        inputText: target.data.inputText,
      });
  });

  it('cleans tags for React Flow edge and node removal paths across both supported nodes', () => {
    const red = createNode(CANVAS_NODE_TYPES.upload, 'red');
    const textTarget = createNode(CANVAS_NODE_TYPES.textGeneration, 'text-target');
    textTarget.data = {
      ...textTarget.data,
      inputText: `文字${createImageReferencePromptToken('text-edge')}`,
    };
    const imageTarget = createNode(CANVAS_NODE_TYPES.imageEdit, 'image-target');
    imageTarget.data = {
      ...imageTarget.data,
      prompt: `图片${createImageReferencePromptToken('image-edge')}`,
    };
    useCanvasStore.getState().setCanvasData([red, textTarget, imageTarget], [
      imageInputEdge('text-edge', red.id, textTarget.id, 0),
      imageInputEdge('image-edge', red.id, imageTarget.id, 0),
    ]);

    useCanvasStore.getState().onEdgesChange([{ id: 'text-edge', type: 'remove' }]);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === textTarget.id)?.data)
      .toMatchObject({ inputText: '文字' });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === imageTarget.id)?.data)
      .toMatchObject({ prompt: `图片${createImageReferencePromptToken('image-edge')}` });

    useCanvasStore.getState().onNodesChange([{ id: red.id, type: 'remove' }]);
    expect(useCanvasStore.getState().edges).toEqual([]);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === imageTarget.id)?.data)
      .toMatchObject({ prompt: '图片' });
  });

  it('cleans tags when the canvas delete command removes an image source', () => {
    const source = createNode(CANVAS_NODE_TYPES.upload, 'source');
    const target = createNode(CANVAS_NODE_TYPES.imageEdit, 'target');
    target.data = {
      ...target.data,
      prompt: `外套参考${createImageReferencePromptToken('source-edge')}`,
    };
    useCanvasStore.getState().setCanvasData([source, target], [
      imageInputEdge('source-edge', source.id, target.id, 0),
    ]);

    useCanvasStore.getState().deleteNodes([source.id]);

    expect(useCanvasStore.getState().edges).toEqual([]);
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().nodes[0]?.data).toMatchObject({ prompt: '外套参考' });
  });
});

describe('canvas store typed input ordering', () => {
  afterEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('stores independent append order for text and image inputs', () => {
    const textA = createNode(CANVAS_NODE_TYPES.textGeneration, 'text-a');
    const imageA = createNode(CANVAS_NODE_TYPES.upload, 'image-a');
    const textB = createNode(CANVAS_NODE_TYPES.textGeneration, 'text-b');
    const target = createNode(CANVAS_NODE_TYPES.textGeneration, 'target');
    useCanvasStore.getState().setCanvasData([textA, imageA, textB, target], []);

    useCanvasStore.getState().onConnect({ source: textA.id, target: target.id, sourceHandle: null, targetHandle: null });
    useCanvasStore.getState().onConnect({ source: imageA.id, target: target.id, sourceHandle: null, targetHandle: null });
    useCanvasStore.getState().onConnect({ source: textB.id, target: target.id, sourceHandle: null, targetHandle: null });

    expect(useCanvasStore.getState().edges.map((edge) => edge.data)).toEqual([
      { valueType: 'text', inputOrder: 0 },
      { valueType: 'image', inputOrder: 0 },
      { valueType: 'text', inputOrder: 1 },
    ]);
  });

  it('reorders one input type as a single undoable step', () => {
    const first = createNode(CANVAS_NODE_TYPES.textGeneration, 'first');
    const second = createNode(CANVAS_NODE_TYPES.textGeneration, 'second');
    const target = createNode(CANVAS_NODE_TYPES.textGeneration, 'target');
    useCanvasStore.getState().setCanvasData([first, second, target], []);
    useCanvasStore.getState().onConnectBatch([
      { source: first.id, target: target.id, sourceHandle: null, targetHandle: null },
      { source: second.id, target: target.id, sourceHandle: null, targetHandle: null },
    ]);
    const historyBeforeReorder = useCanvasStore.getState().history.past.length;

    expect(useCanvasStore.getState().reorderNodeInput(
      target.id,
      'text',
      second.id,
      first.id
    )).toBe(true);

    const orderedSources = [...useCanvasStore.getState().edges]
      .sort((left, right) => Number(left.data?.inputOrder) - Number(right.data?.inputOrder))
      .map((edge) => edge.source);
    expect(orderedSources).toEqual([second.id, first.id]);
    expect(useCanvasStore.getState().history.past).toHaveLength(historyBeforeReorder + 1);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().edges.map((edge) => edge.source)).toEqual([first.id, second.id]);
    expect(useCanvasStore.getState().edges.map((edge) => edge.data?.inputOrder)).toEqual([0, 1]);
  });

  it('rejects incompatible and cyclic connections at the store boundary', () => {
    const textA = createNode(CANVAS_NODE_TYPES.textGeneration, 'text-a');
    const textB = createNode(CANVAS_NODE_TYPES.textGeneration, 'text-b');
    const video = createNode(CANVAS_NODE_TYPES.videoUpload, 'video');
    useCanvasStore.getState().setCanvasData([textA, textB, video], []);

    useCanvasStore.getState().onConnect({
      source: video.id,
      target: textA.id,
      sourceHandle: 'source',
      targetHandle: 'target',
    });
    expect(useCanvasStore.getState().edges).toHaveLength(0);

    useCanvasStore.getState().onConnect({
      source: textA.id,
      target: textB.id,
      sourceHandle: 'source',
      targetHandle: 'target',
    });
    useCanvasStore.getState().onConnect({
      source: textB.id,
      target: textA.id,
      sourceHandle: 'source',
      targetHandle: 'target',
    });
    expect(useCanvasStore.getState().edges).toHaveLength(1);
  });

  it('preserves stored edges that are temporarily incompatible with a mutable node mode', () => {
    const image = createNode(CANVAS_NODE_TYPES.upload, 'image');
    const sd2 = createNode(CANVAS_NODE_TYPES.sd2VideoGen, 'sd2');
    sd2.data = { ...sd2.data, generationMode: 'extend' };
    const storedEdge = {
      id: 'stored-image-edge',
      source: image.id,
      target: sd2.id,
      sourceHandle: 'source',
      targetHandle: 'target-images',
      data: { valueType: 'image' as const, inputOrder: 0 },
    };

    useCanvasStore.getState().setCanvasData([image, sd2], [storedEdge]);

    expect(useCanvasStore.getState().edges).toHaveLength(1);
  });
});

describe('canvas store legacy video compatibility', () => {
  afterEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('loads a persisted videoSingle node without changing its legacy data', () => {
    const legacyNode = createNode(CANVAS_NODE_TYPES.videoSingle, 'legacy-video-single');
    legacyNode.data = {
      ...legacyNode.data,
      displayName: '已保存的单图视频',
      prompt: '让人物缓慢转身',
      model: 'doubao-seedance-1-5-pro-251215',
      resolution: '1080p',
      duration: 8,
      referenceImagePrompt: true,
      referenceImages: ['/project/uploads/reference.png'],
      videoApiId: 'legacy-seedance-api',
      legacyCustomValue: 'preserve-me',
    };

    useCanvasStore.getState().setCanvasData([legacyNode], []);

    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().nodes[0]).toMatchObject({
      id: legacyNode.id,
      type: CANVAS_NODE_TYPES.videoSingle,
      data: {
        displayName: '已保存的单图视频',
        prompt: '让人物缓慢转身',
        model: 'doubao-seedance-1-5-pro-251215',
        resolution: '1080p',
        duration: 8,
        referenceImagePrompt: true,
        referenceImages: ['/project/uploads/reference.png'],
        videoApiId: 'legacy-seedance-api',
        legacyCustomValue: 'preserve-me',
      },
    });
  });
});

describe('canvas store text editing history', () => {
  afterEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('groups a continuous text edit burst into one undo step', () => {
    const node = createNode(CANVAS_NODE_TYPES.textGeneration, 'text-node');
    useCanvasStore.getState().setCanvasData([node], []);

    useCanvasStore.getState().updateNodeDataCoalesced(node.id, { inputText: '你' }, 'local-input');
    useCanvasStore.getState().updateNodeDataCoalesced(node.id, { inputText: '你好' }, 'local-input');
    useCanvasStore.getState().updateNodeDataCoalesced(node.id, { inputText: '你好世界' }, 'local-input');

    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect((useCanvasStore.getState().nodes[0].data as { inputText?: string }).inputText).toBe('');
  });

  it('ends a typing burst when another undoable edit occurs', () => {
    const node = createNode(CANVAS_NODE_TYPES.textGeneration, 'text-node');
    useCanvasStore.getState().setCanvasData([node], []);

    useCanvasStore.getState().updateNodeDataCoalesced(
      node.id,
      { inputText: 'first input' },
      'local-input'
    );
    useCanvasStore.getState().updateNodeDataCoalesced(
      node.id,
      { generatedText: 'edited result' },
      'result'
    );
    useCanvasStore.getState().updateNodeDataCoalesced(
      node.id,
      { inputText: 'second input' },
      'local-input'
    );

    expect(useCanvasStore.getState().history.past).toHaveLength(3);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data).toMatchObject({
      inputText: 'first input',
      generatedText: 'edited result',
    });
  });
});

describe('canvas store text generation sizing', () => {
  afterEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('locks context-driven dimensions after a user resize', () => {
    const node = createNode(CANVAS_NODE_TYPES.textGeneration, 'text-node');
    useCanvasStore.getState().setCanvasData([node], []);

    useCanvasStore.getState().onNodesChange([{
      id: node.id,
      type: 'dimensions',
      dimensions: { width: 760, height: 480 },
      resizing: false,
    }]);

    expect(useCanvasStore.getState().nodes.find((item) => item.id === node.id)?.data)
      .toMatchObject({ isSizeManuallyAdjusted: true });
  });

  it('does not treat a programmatic size sync as a manual text-node resize', () => {
    const node = createNode(CANVAS_NODE_TYPES.textGeneration, 'text-node');
    useCanvasStore.getState().setCanvasData([node], []);

    useCanvasStore.getState().onNodesChange([{
      id: node.id,
      type: 'dimensions',
      dimensions: { width: 760, height: 480 },
      resizing: false,
      setAttributes: true,
    }]);

    expect(useCanvasStore.getState().nodes.find((item) => item.id === node.id)?.data)
      .toMatchObject({ isSizeManuallyAdjusted: false });
  });
});

describe('new text generation node defaults', () => {
  afterEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
    useSettingsStore.setState({ lastTextGenerationModelSelection: null });
  });

  it('inherits the last text generation provider and model', () => {
    useSettingsStore.setState({
      textApis: [{
        id: 'provider-a',
        name: 'Provider A',
        apiKey: 'secret',
        baseUrl: 'https://gateway.example/v1',
        modelId: 'model-a',
        modelCatalog: null,
        selectedModelIds: ['model-a'],
        enabled: false,
      }],
      lastTextGenerationModelSelection: { apiId: 'provider-a', modelId: 'model-a' },
    });

    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.textGeneration,
      { x: 0, y: 0 }
    );
    const data = useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data;

    expect(data).toMatchObject({ textApiId: 'provider-a', textModelId: 'model-a' });
  });

  it('preserves an unavailable last selection instead of silently falling back', () => {
    useSettingsStore.setState({
      textApis: [{
        id: 'provider-a',
        name: 'Provider A',
        apiKey: 'secret',
        baseUrl: 'https://gateway.example/v1',
        modelId: 'available-model',
        modelCatalog: null,
        selectedModelIds: ['available-model'],
        enabled: false,
      }],
      lastTextGenerationModelSelection: {
        apiId: 'removed-provider',
        modelId: 'removed-model',
      },
    });

    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.textGeneration,
      { x: 0, y: 0 }
    );
    const data = useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data;

    expect(data).toMatchObject({
      textApiId: 'removed-provider',
      textModelId: 'removed-model',
    });
  });
});

describe('new image generation node defaults', () => {
  afterEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
    useSettingsStore.setState({
      openAiImageApi: createDefaultOpenAiImageApiConfig(),
      chaomoImageApi: createDefaultChaomoImageApiConfig(),
      customImageApis: [],
      lastImageModelSelection: null,
      lastImageGenerationOptions: {},
    });
  });

  it('assigns sequential short titles only when image nodes are unnamed', () => {
    const firstId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageEdit,
      { x: 0, y: 0 }
    );
    const secondId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageEdit,
      { x: 320, y: 0 }
    );
    const namedId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageEdit,
      { x: 640, y: 0 },
      { displayName: '毛衣细节' }
    );
    const nodes = useCanvasStore.getState().nodes;

    expect(nodes.find((node) => node.id === firstId)?.data.displayName).toBe('AI生图 1');
    expect(nodes.find((node) => node.id === secondId)?.data.displayName).toBe('AI生图 2');
    expect(nodes.find((node) => node.id === namedId)?.data.displayName).toBe('毛衣细节');
  });

  it('shares the last applicable generation parameters without copying creative content', () => {
    useSettingsStore.setState({
      openAiImageApi: {
        apiKey: 'secret',
        baseUrl: 'https://gateway.example/v1',
        modelCatalog: {
          models: [{ id: 'ai-media/gpt-image-2' }],
          refreshedAt: 1,
        },
        selectedModelIds: ['ai-media/gpt-image-2'],
      },
    });
    const settings = useSettingsStore.getState();
    settings.setLastImageModelSelection({
      providerId: 'ai-media',
      modelId: 'ai-media/gpt-image-2',
    });
    settings.updateLastImageGenerationOptions({
      size: '4K',
      requestAspectRatio: '3:4',
    });
    settings.updateLastImageGenerationOptions({
      outputCount: 2,
      extraParams: { thinking_level: 'high', enable_search: true },
    });
    settings.updateLastImageGenerationOptions({
      storyboardGridRows: 3,
      storyboardGridCols: 4,
      storyboardRatioControlMode: 'overall',
    });

    const imageNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageEdit,
      { x: 0, y: 0 }
    );
    const storyboardNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.storyboardGen,
      { x: 320, y: 0 }
    );
    const imageNode = useCanvasStore.getState().nodes.find((node) => node.id === imageNodeId);
    const storyboardNode = useCanvasStore.getState().nodes.find((node) => node.id === storyboardNodeId);

    expect(imageNode?.data).toMatchObject({
      model: 'ai-media/gpt-image-2',
      size: '4K',
      requestAspectRatio: '3:4',
      outputCount: 2,
      extraParams: { thinking_level: 'high', enable_search: true },
      prompt: '',
      imageUrl: null,
    });
    expect(storyboardNode?.data).toMatchObject({
      model: 'ai-media/gpt-image-2',
      size: '4K',
      requestAspectRatio: '3:4',
      extraParams: { thinking_level: 'high', enable_search: true },
      gridRows: 3,
      gridCols: 4,
      ratioControlMode: 'overall',
      globalPrompt: '',
      frames: [],
      imageUrl: null,
    });
    expect((imageNode?.data as { extraParams?: unknown }).extraParams)
      .not.toBe((storyboardNode?.data as { extraParams?: unknown }).extraParams);
  });

  it('does not override explicit image-generation data such as a copied node', () => {
    useSettingsStore.getState().updateLastImageGenerationOptions({
      size: '4K',
      requestAspectRatio: '3:4',
      outputCount: 2,
      extraParams: { thinking_level: 'high' },
    });

    const copiedNodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.imageEdit,
      { x: 0, y: 0 },
      {
        model: 'copied-model',
        size: '1K',
        requestAspectRatio: '16:9',
        outputCount: 4,
        extraParams: { thinking_level: 'low' },
        prompt: 'Keep this prompt local.',
      }
    );
    const copiedNode = useCanvasStore.getState().nodes.find((node) => node.id === copiedNodeId);

    expect(copiedNode?.data).toMatchObject({
      model: 'copied-model',
      size: '1K',
      requestAspectRatio: '16:9',
      outputCount: 4,
      extraParams: { thinking_level: 'low' },
      prompt: 'Keep this prompt local.',
    });
  });
});
