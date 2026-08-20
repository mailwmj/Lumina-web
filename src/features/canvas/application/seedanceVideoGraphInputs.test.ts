import { describe, expect, it } from 'vitest';

import { canvasNodeFactory } from './canvasServices';
import { resolveSeedanceVideoGraphInputs } from './seedanceVideoGraphInputs';
import { resolveEffectivePromptForNode } from './textGenerationInputs';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '../domain/canvasNodes';

function createNode(type: CanvasNode['type'], id: string): CanvasNode {
  return {
    ...canvasNodeFactory.createNode(type, { x: 0, y: 0 }),
    id,
  };
}

describe('Seedance video graph inputs', () => {
  it('preserves connected media order and source/handle provenance for an automatic node', () => {
    const automatic = createNode(CANVAS_NODE_TYPES.seedanceAutoVideo, 'automatic');
    const image = createNode(CANVAS_NODE_TYPES.upload, 'image');
    image.data = { ...image.data, imageUrl: 'https://media.example/image.png' };
    const video = createNode(CANVAS_NODE_TYPES.videoUpload, 'video');
    video.data = { ...video.data, videoUrl: 'https://media.example/video.mp4' };
    const audio = createNode(CANVAS_NODE_TYPES.audioUpload, 'audio');
    audio.data = { ...audio.data, audioUrl: 'https://media.example/audio.mp3' };
    const edges: CanvasEdge[] = [
      {
        id: 'video-edge', source: video.id, target: automatic.id,
        sourceHandle: 'source', targetHandle: 'target',
        data: { valueType: 'video', inputOrder: 0 },
      },
      {
        id: 'image-edge', source: image.id, target: automatic.id,
        sourceHandle: 'source', targetHandle: 'target',
        data: { valueType: 'image', inputOrder: 0 },
      },
      {
        id: 'audio-edge', source: audio.id, target: automatic.id,
        sourceHandle: 'source', targetHandle: 'target',
        data: { valueType: 'audio', inputOrder: 0 },
      },
    ];

    expect(resolveSeedanceVideoGraphInputs(automatic.id, [automatic, image, video, audio], edges))
      .toEqual([
        {
          sourceNodeId: 'video', sourceNodeType: CANVAS_NODE_TYPES.videoUpload,
          targetHandle: 'target', type: 'video', url: 'https://media.example/video.mp4',
        },
        {
          sourceNodeId: 'image', sourceNodeType: CANVAS_NODE_TYPES.upload,
          targetHandle: 'target', type: 'image', url: 'https://media.example/image.png',
        },
        {
          sourceNodeId: 'audio', sourceNodeType: CANVAS_NODE_TYPES.audioUpload,
          targetHandle: 'target', type: 'audio', url: 'https://media.example/audio.mp3',
        },
      ]);
  });

  it('retains first and last target handles for strict-frame planning', () => {
    const strict = createNode(CANVAS_NODE_TYPES.videoFrame, 'strict');
    const first = createNode(CANVAS_NODE_TYPES.upload, 'first');
    first.data = { ...first.data, imageUrl: 'https://media.example/first.png' };
    const last = createNode(CANVAS_NODE_TYPES.upload, 'last');
    last.data = { ...last.data, imageUrl: 'https://media.example/last.png' };
    const edges: CanvasEdge[] = [
      {
        id: 'last-edge', source: last.id, target: strict.id,
        sourceHandle: 'source', targetHandle: 'target-last',
        data: { valueType: 'image', inputOrder: 0 },
      },
      {
        id: 'first-edge', source: first.id, target: strict.id,
        sourceHandle: 'source', targetHandle: 'target-first',
        data: { valueType: 'image', inputOrder: 1 },
      },
    ];

    expect(resolveSeedanceVideoGraphInputs(strict.id, [strict, first, last], edges))
      .toMatchObject([
        { sourceNodeId: 'last', targetHandle: 'target-last', type: 'image' },
        { sourceNodeId: 'first', targetHandle: 'target-first', type: 'image' },
      ]);
  });

  it('composes connected text into the automatic node text content separately from typed media', () => {
    const automatic = createNode(CANVAS_NODE_TYPES.seedanceAutoVideo, 'automatic');
    const text = createNode(CANVAS_NODE_TYPES.textGeneration, 'text');
    text.data = {
      ...text.data,
      inputText: '上游文字',
      generatedText: '上游生成的 Seedance 指令',
    };
    const image = createNode(CANVAS_NODE_TYPES.upload, 'image');
    image.data = { ...image.data, imageUrl: 'https://media.example/reference.png' };
    const edges: CanvasEdge[] = [
      {
        id: 'text-edge', source: text.id, target: automatic.id,
        sourceHandle: 'source', targetHandle: 'target',
        data: { valueType: 'text', inputOrder: 0 },
      },
      {
        id: 'image-edge', source: image.id, target: automatic.id,
        sourceHandle: 'source', targetHandle: 'target',
        data: { valueType: 'image', inputOrder: 0 },
      },
    ];

    expect(resolveEffectivePromptForNode(
      automatic.id,
      '本地补充指令',
      [automatic, text, image],
      edges
    )).toBe('上游生成的 Seedance 指令\n\n本地补充指令');
    expect(resolveSeedanceVideoGraphInputs(automatic.id, [automatic, text, image], edges))
      .toMatchObject([
        { sourceNodeId: image.id, type: 'image', url: 'https://media.example/reference.png' },
      ]);
  });
});
