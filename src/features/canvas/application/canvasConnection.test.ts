import { describe, expect, it } from 'vitest';

import { canvasNodeFactory } from './canvasServices';
import {
  buildBatchConnectionPlan,
  getBatchConnectMenuNodeTypes,
  isCanvasConnectionValid,
} from './canvasConnection';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '../domain/canvasNodes';

function createNode(type: CanvasNode['type'], id: string): CanvasNode {
  return {
    ...canvasNodeFactory.createNode(type, { x: 0, y: 0 }),
    id,
  };
}

describe('batch canvas connections', () => {
  it('plans one input edge for each selected image node', () => {
    const nodes = [
      createNode(CANVAS_NODE_TYPES.upload, 'source-a'),
      createNode(CANVAS_NODE_TYPES.upload, 'source-b'),
      createNode(CANVAS_NODE_TYPES.imageEdit, 'target'),
    ];

    const plan = buildBatchConnectionPlan(
      ['source-a', 'source-b'],
      'target',
      nodes,
      []
    );

    expect(plan.invalidSourceIds).toEqual([]);
    expect(plan.connections).toEqual([
      {
        source: 'source-a',
        target: 'target',
        sourceHandle: 'source',
        targetHandle: 'target',
      },
      {
        source: 'source-b',
        target: 'target',
        sourceHandle: 'source',
        targetHandle: 'target',
      },
    ]);
  });

  it('skips existing edges without failing the rest of the batch', () => {
    const nodes = [
      createNode(CANVAS_NODE_TYPES.upload, 'source-a'),
      createNode(CANVAS_NODE_TYPES.upload, 'source-b'),
      createNode(CANVAS_NODE_TYPES.imageEdit, 'target'),
    ];
    const edges: CanvasEdge[] = [
      {
        id: 'existing',
        source: 'source-a',
        target: 'target',
        sourceHandle: 'source',
        targetHandle: 'target',
      },
    ];

    const plan = buildBatchConnectionPlan(
      ['source-a', 'source-b'],
      'target',
      nodes,
      edges
    );

    expect(plan.skippedDuplicateCount).toBe(1);
    expect(plan.invalidSourceIds).toEqual([]);
    expect(plan.connections.map((connection) => connection.source)).toEqual(['source-b']);
  });

  it('applies SD2 input capacity to the whole simulated batch', () => {
    const sources = Array.from({ length: 10 }, (_, index) =>
      createNode(CANVAS_NODE_TYPES.upload, `source-${index}`)
    );
    const target = createNode(CANVAS_NODE_TYPES.sd2VideoGen, 'target');

    const plan = buildBatchConnectionPlan(
      sources.map((source) => source.id),
      target.id,
      [...sources, target],
      []
    );

    expect(plan.connections).toHaveLength(9);
    expect(plan.invalidSourceIds).toEqual(['source-9']);
  });

  it('offers the unified Seedance video target that can accept every selected image source', () => {
    const sourceA = createNode(CANVAS_NODE_TYPES.upload, 'source-a');
    const sourceB = createNode(CANVAS_NODE_TYPES.upload, 'source-b');

    const targetTypes = getBatchConnectMenuNodeTypes(
      [sourceA.id, sourceB.id],
      [sourceA, sourceB]
    );

    expect(targetTypes).toContain(CANVAS_NODE_TYPES.imageEdit);
    expect(targetTypes).toContain(CANVAS_NODE_TYPES.seedanceAutoVideo);
    expect(targetTypes).not.toContain(CANVAS_NODE_TYPES.videoFrame);
  });

  it('assigns one or two strict-frame inputs to their visible semantic ports', () => {
    const first = createNode(CANVAS_NODE_TYPES.upload, 'first');
    const last = createNode(CANVAS_NODE_TYPES.upload, 'last');
    const strictFrame = createNode(CANVAS_NODE_TYPES.videoFrame, 'strict-frame');

    const plan = buildBatchConnectionPlan(
      [first.id, last.id],
      strictFrame.id,
      [first, last, strictFrame],
      []
    );

    expect(plan.invalidSourceIds).toEqual([]);
    expect(plan.connections).toEqual([
      {
        source: first.id,
        target: strictFrame.id,
        sourceHandle: 'source',
        targetHandle: 'target-first',
      },
      {
        source: last.id,
        target: strictFrame.id,
        sourceHandle: 'source',
        targetHandle: 'target-last',
      },
    ]);
  });

  it('does not offer the unfinished SD2 advanced node as a new target', () => {
    const source = createNode(CANVAS_NODE_TYPES.upload, 'source');

    const targetTypes = getBatchConnectMenuNodeTypes([source.id], [source]);

    expect(targetTypes).toContain(CANVAS_NODE_TYPES.seedanceAutoVideo);
    expect(targetTypes).not.toContain(CANVAS_NODE_TYPES.videoSingle);
    expect(targetTypes).not.toContain(CANVAS_NODE_TYPES.sd2VideoGen);
  });

  it('omits a new SD2 target when the whole selection exceeds its input capacity', () => {
    const sources = Array.from({ length: 10 }, (_, index) =>
      createNode(CANVAS_NODE_TYPES.upload, `source-${index}`)
    );

    const targetTypes = getBatchConnectMenuNodeTypes(
      sources.map((source) => source.id),
      sources
    );

    expect(targetTypes).toContain(CANVAS_NODE_TYPES.imageEdit);
    expect(targetTypes).not.toContain(CANVAS_NODE_TYPES.seedanceAutoVideo);
  });
});

describe('typed canvas connections', () => {
  it('routes text, image, video, and audio sources through the visible Seedance automatic node', () => {
    const text = createNode(CANVAS_NODE_TYPES.textGeneration, 'text');
    const image = createNode(CANVAS_NODE_TYPES.upload, 'image');
    const video = createNode(CANVAS_NODE_TYPES.videoUpload, 'video');
    const audio = createNode(CANVAS_NODE_TYPES.audioUpload, 'audio');
    const automatic = createNode(CANVAS_NODE_TYPES.seedanceAutoVideo, 'automatic');
    const nodes = [text, image, video, audio, automatic];

    expect(isCanvasConnectionValid({ source: text.id, target: automatic.id }, nodes, [])).toBe(true);
    expect(isCanvasConnectionValid({ source: image.id, target: automatic.id }, nodes, [])).toBe(true);
    expect(isCanvasConnectionValid({ source: video.id, target: automatic.id }, nodes, [])).toBe(true);
    expect(isCanvasConnectionValid({ source: audio.id, target: automatic.id }, nodes, [])).toBe(true);
  });

  it('uses registry input limits for automatic Seedance media references', () => {
    const images = Array.from({ length: 10 }, (_, index) =>
      createNode(CANVAS_NODE_TYPES.upload, `image-${index}`)
    );
    const automatic = createNode(CANVAS_NODE_TYPES.seedanceAutoVideo, 'automatic');
    const edges: CanvasEdge[] = images.slice(0, 9).map((image, index) => ({
      id: `edge-${index}`,
      source: image.id,
      target: automatic.id,
      sourceHandle: 'source',
      targetHandle: 'target',
      data: { valueType: 'image', inputOrder: index },
    }));

    expect(isCanvasConnectionValid(
      { source: images[9].id, target: automatic.id, targetHandle: 'target' },
      [...images, automatic],
      edges
    )).toBe(false);
  });

  it('limits the unified Seedance node to one or two image inputs in first-last mode', () => {
    const images = Array.from({ length: 3 }, (_, index) =>
      createNode(CANVAS_NODE_TYPES.upload, `image-${index}`)
    );
    const firstLast = createNode(CANVAS_NODE_TYPES.seedanceAutoVideo, 'first-last');
    firstLast.data = { ...firstLast.data, inputMode: 'first-last' };
    const edges: CanvasEdge[] = images.slice(0, 2).map((image, index) => ({
      id: `image-edge-${index}`,
      source: image.id,
      target: firstLast.id,
      sourceHandle: 'source',
      targetHandle: 'target',
      data: { valueType: 'image', inputOrder: index },
    }));

    expect(isCanvasConnectionValid(
      { source: images[2].id, target: firstLast.id, targetHandle: 'target' },
      [...images, firstLast],
      edges
    )).toBe(false);
  });

  it('rejects video and audio inputs for the unified Seedance node in first-last mode', () => {
    const image = createNode(CANVAS_NODE_TYPES.upload, 'image');
    const video = createNode(CANVAS_NODE_TYPES.videoUpload, 'video');
    const audio = createNode(CANVAS_NODE_TYPES.audioUpload, 'audio');
    const firstLast = createNode(CANVAS_NODE_TYPES.seedanceAutoVideo, 'first-last');
    firstLast.data = { ...firstLast.data, inputMode: 'first-last' };
    const nodes = [image, video, audio, firstLast];

    expect(isCanvasConnectionValid({ source: image.id, target: firstLast.id }, nodes, [])).toBe(true);
    expect(isCanvasConnectionValid({ source: video.id, target: firstLast.id }, nodes, [])).toBe(false);
    expect(isCanvasConnectionValid({ source: audio.id, target: firstLast.id }, nodes, [])).toBe(false);
  });

  it('accepts text and image inputs for a text generation node and rejects video', () => {
    const text = createNode(CANVAS_NODE_TYPES.textGeneration, 'text');
    const image = createNode(CANVAS_NODE_TYPES.upload, 'image');
    const video = createNode(CANVAS_NODE_TYPES.videoUpload, 'video');
    const target = createNode(CANVAS_NODE_TYPES.textGeneration, 'target');
    const nodes = [text, image, video, target];

    expect(isCanvasConnectionValid({ source: text.id, target: target.id }, nodes, [])).toBe(true);
    expect(isCanvasConnectionValid({ source: image.id, target: target.id }, nodes, [])).toBe(true);
    expect(isCanvasConnectionValid({ source: video.id, target: target.id }, nodes, [])).toBe(false);
  });

  it('prevents directed cycles across text generation nodes', () => {
    const first = createNode(CANVAS_NODE_TYPES.textGeneration, 'first');
    const second = createNode(CANVAS_NODE_TYPES.textGeneration, 'second');
    const edges: CanvasEdge[] = [{
      id: 'first-to-second',
      source: first.id,
      target: second.id,
      data: { valueType: 'text', inputOrder: 0 },
    }];

    expect(isCanvasConnectionValid(
      { source: second.id, target: first.id },
      [first, second],
      edges
    )).toBe(false);
  });

  it('caps text generation image inputs at ten without limiting text inputs', () => {
    const images = Array.from({ length: 11 }, (_, index) =>
      createNode(CANVAS_NODE_TYPES.upload, `image-${index}`)
    );
    const target = createNode(CANVAS_NODE_TYPES.textGeneration, 'target');
    const edges: CanvasEdge[] = images.slice(0, 10).map((image, index) => ({
      id: `edge-${index}`,
      source: image.id,
      target: target.id,
      data: { valueType: 'image', inputOrder: index },
    }));

    expect(isCanvasConnectionValid(
      { source: images[10].id, target: target.id },
      [...images, target],
      edges
    )).toBe(false);
  });
});
