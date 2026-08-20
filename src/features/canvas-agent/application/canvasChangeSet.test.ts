import { afterEach, describe, expect, it } from 'vitest';

import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  CanvasChangeSetError,
  applyCanvasChangeSet,
  parsePendingCanvasChangeProposal,
} from './canvasChangeSet';

function node(type: CanvasNode['type'], id: string): CanvasNode {
  return {
    ...canvasNodeFactory.createNode(type, { x: 0, y: 0 }),
    id,
  };
}

describe('external Agent CanvasChangeSet', () => {
  afterEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('creates, updates, positions, and connects typed nodes as one planned graph', () => {
    const source = node(CANVAS_NODE_TYPES.textGeneration, 'source');
    const applied = applyCanvasChangeSet({ nodes: [source], edges: [] }, {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Add a text step',
      operations: [
        {
          type: 'create_node',
          clientId: 'draft-target',
          nodeType: CANVAS_NODE_TYPES.textGeneration,
          position: { x: 320, y: 40 },
          data: { inputText: 'Describe the scene' },
        },
        {
          type: 'update_node',
          nodeId: 'draft-target',
          data: { displayName: 'Scene brief' },
        },
        {
          type: 'connect_nodes',
          sourceNodeId: source.id,
          targetNodeId: 'draft-target',
        },
      ],
    });

    const targetId = applied.result.nodeIdMap['draft-target'];
    expect(applied.nodes.find((item) => item.id === targetId)).toMatchObject({
      position: { x: 320, y: 40 },
      data: { inputText: 'Describe the scene', displayName: 'Scene brief' },
    });
    expect(applied.edges).toHaveLength(1);
    expect(applied.edges[0]).toMatchObject({
      source: source.id,
      target: targetId,
      data: { valueType: 'text', inputOrder: 0 },
    });
  });

  it('rejects result-node creation and media field writes', () => {
    const upload = node(CANVAS_NODE_TYPES.upload, 'upload');
    expect(() => applyCanvasChangeSet({ nodes: [], edges: [] }, {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Create a result',
      operations: [{
        type: 'create_node',
        clientId: 'result',
        nodeType: CANVAS_NODE_TYPES.exportImage,
        position: { x: 0, y: 0 },
      }],
    })).toThrowError(CanvasChangeSetError);

    expect(() => applyCanvasChangeSet({ nodes: [upload], edges: [] }, {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Replace an image',
      operations: [{
        type: 'update_node',
        nodeId: upload.id,
        data: { imageUrl: 'data:image/png;base64,unsafe' },
      }],
    })).toThrowError(/not writable/);
  });

  it('assigns a short default image title and rejects Agent prompt-sized titles', () => {
    const applied = applyCanvasChangeSet({ nodes: [], edges: [] }, {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Create an image node without a title',
      operations: [{
        type: 'create_node',
        clientId: 'image',
        nodeType: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 0, y: 0 },
        data: { prompt: 'Keep the prompt separate from the title.' },
      }],
    });
    const created = applied.nodes.find((node) => node.id === applied.result.nodeIdMap.image);
    expect(created?.data.displayName).toBe('AI生图 1');

    expect(() => applyCanvasChangeSet({ nodes: [], edges: [] }, {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Create an image node with a prompt as its title',
      operations: [{
        type: 'create_node',
        clientId: 'image',
        nodeType: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 0, y: 0 },
        data: { displayName: 'x'.repeat(81) },
      }],
    })).toThrowError(/no longer than 80 characters/);
  });

  it('rejects operation types outside the P0 protocol', () => {
    expect(() => parsePendingCanvasChangeProposal({
      proposalId: 'proposal-1',
      createdAt: Date.now(),
      changeSet: {
        projectId: 'project-1',
        baseRevision: 'revision-1',
        summary: 'Delete a node',
        operations: [{ type: 'delete_node', nodeId: 'node-1' }],
      },
    })).toThrowError(/not allowed/);
  });

  it('rejects unknown handles and occupied first/last-frame inputs', () => {
    const first = node(CANVAS_NODE_TYPES.upload, 'first');
    const second = node(CANVAS_NODE_TYPES.upload, 'second');
    const video = node(CANVAS_NODE_TYPES.videoFrame, 'video');
    const existingEdge = {
      id: 'edge-first',
      source: first.id,
      target: video.id,
      sourceHandle: 'source',
      targetHandle: 'target-first',
      data: { valueType: 'image' as const, inputOrder: 0 },
    };

    expect(() => applyCanvasChangeSet({ nodes: [first, video], edges: [] }, {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Use an unknown handle',
      operations: [{
        type: 'connect_nodes',
        sourceNodeId: first.id,
        targetNodeId: video.id,
        targetHandle: 'target-unknown',
      }],
    })).toThrowError(/not a valid target handle/);

    expect(() => applyCanvasChangeSet({
      nodes: [first, second, video],
      edges: [existingEdge],
    }, {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Replace the first frame implicitly',
      operations: [{
        type: 'connect_nodes',
        sourceNodeId: second.id,
        targetNodeId: video.id,
        targetHandle: 'target-first',
      }],
    })).toThrowError(/already has an input/);
  });

  it('normalizes storyboard frames inside the atomic batch', () => {
    const applied = applyCanvasChangeSet({ nodes: [], edges: [] }, {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Create a six-frame storyboard',
      operations: [{
        type: 'create_node',
        clientId: 'storyboard',
        nodeType: CANVAS_NODE_TYPES.storyboardGen,
        position: { x: 0, y: 0 },
        data: {
          gridRows: 2,
          gridCols: 3,
          frames: [{ id: 'frame-1', description: 'Opening', referenceIndex: null }],
        },
      }],
    });
    const storyboard = applied.nodes.find(
      (item) => item.id === applied.result.nodeIdMap.storyboard
    );

    expect((storyboard?.data as { frames?: unknown[] }).frames).toHaveLength(6);
    expect((storyboard?.data as { frames?: unknown[] }).frames?.[0]).toEqual({
      id: 'frame-1',
      description: 'Opening',
      referenceIndex: null,
    });
  });

  it('rejects media fields hidden inside storyboard frame data', () => {
    expect(() => applyCanvasChangeSet({ nodes: [], edges: [] }, {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Embed a frame image',
      operations: [{
        type: 'create_node',
        clientId: 'storyboard',
        nodeType: CANVAS_NODE_TYPES.storyboardGen,
        position: { x: 0, y: 0 },
        data: {
          frames: [{
            id: 'frame-1',
            description: 'Opening',
            referenceIndex: null,
            imageUrl: 'data:image/png;base64,unsafe',
          }],
        },
      }],
    })).toThrowError(/unsupported fields/);
  });

  it('appends typed input order after the highest existing order', () => {
    const first = node(CANVAS_NODE_TYPES.textGeneration, 'first');
    const second = node(CANVAS_NODE_TYPES.textGeneration, 'second');
    const target = node(CANVAS_NODE_TYPES.imageEdit, 'target');
    const applied = applyCanvasChangeSet({
      nodes: [first, second, target],
      edges: [{
        id: 'edge-first',
        source: first.id,
        target: target.id,
        sourceHandle: 'source',
        targetHandle: 'target',
        data: { valueType: 'text', inputOrder: 4 },
      }],
    }, {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Append a text input',
      operations: [{
        type: 'connect_nodes',
        sourceNodeId: second.id,
        targetNodeId: target.id,
      }],
    });

    expect(applied.edges[applied.edges.length - 1]?.data).toMatchObject({
      valueType: 'text',
      inputOrder: 5,
    });
  });

  it('commits a directly applied batch as exactly one undo step', () => {
    const source = node(CANVAS_NODE_TYPES.textGeneration, 'source');
    useCanvasStore.getState().setCanvasData([source], []);

    const result = useCanvasStore.getState().applyAgentChangeSet({
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Create and connect a text node',
      operations: [
        {
          type: 'create_node',
          clientId: 'target',
          nodeType: CANVAS_NODE_TYPES.textGeneration,
          position: { x: 300, y: 0 },
          data: { inputText: 'Next step' },
        },
        {
          type: 'connect_nodes',
          sourceNodeId: source.id,
          targetNodeId: 'target',
        },
      ],
    });

    expect(result.createdNodeIds).toHaveLength(1);
    expect(useCanvasStore.getState().nodes).toHaveLength(2);
    expect(useCanvasStore.getState().edges).toHaveLength(1);
    expect(useCanvasStore.getState().history.past).toHaveLength(1);

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes.map((item) => item.id)).toEqual([source.id]);
    expect(useCanvasStore.getState().edges).toEqual([]);
  });

  it('places positionless generation nodes in one readable non-overlapping column', () => {
    const reference = {
      ...node(CANVAS_NODE_TYPES.upload, 'reference'),
      position: { x: 40, y: 80 },
      width: 280,
      height: 240,
    };
    const applied = applyCanvasChangeSet({ nodes: [reference], edges: [] }, {
      projectId: 'project-1',
      baseRevision: 'revision-1',
      summary: 'Create four product shots',
      operations: Array.from({ length: 4 }, (_, index) => ({
        type: 'create_node' as const,
        clientId: `shot-${index + 1}`,
        nodeType: CANVAS_NODE_TYPES.imageEdit,
        data: { prompt: `Shot ${index + 1}` },
      })),
    });
    const created = applied.result.createdNodeIds.map(
      (nodeId) => applied.nodes.find((item) => item.id === nodeId)
    );

    expect(created.every((item) => item?.position.x === 480)).toBe(true);
    expect(created.map((item) => item?.position.y)).toEqual([80, 532, 984, 1436]);
    expect(created.every((item, index) => (
      index === 0 || (item?.position.y ?? 0) >= (created[index - 1]?.position.y ?? 0) + 380
    ))).toBe(true);
  });
});
