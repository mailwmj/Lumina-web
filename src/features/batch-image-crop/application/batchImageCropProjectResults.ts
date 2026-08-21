import type { Viewport } from '@xyflow/react';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import type { CanvasHistoryState } from '@/stores/canvasStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore, type ProjectSaveOptions } from '@/stores/projectStore';
import type { BatchCropTarget } from '../domain';

export interface BatchCropProjectResult {
  assetId: string;
  fileName: string;
  target: BatchCropTarget;
}

export interface BatchCropResultSink {
  record(result: BatchCropProjectResult): Promise<void>;
}

interface BatchCropProjectState {
  currentProjectId: string | null;
  saveCurrentProject(
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    viewport: Viewport,
    history: CanvasHistoryState,
    options?: ProjectSaveOptions,
  ): Promise<void> | void;
}

interface BatchCropCanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  history: CanvasHistoryState;
  currentViewport: Viewport;
  setCanvasData(nodes: CanvasNode[], edges: CanvasEdge[], history: CanvasHistoryState): void;
  addNode(
    type: typeof CANVAS_NODE_TYPES.exportImage,
    position: { x: number; y: number },
    data: Partial<CanvasNodeData>,
  ): string;
}

export interface BatchCropResultSinkDependencies {
  projectState?: () => BatchCropProjectState;
  canvasState?: () => BatchCropCanvasState;
}

function aspectRatio(width: number, height: number): string {
  let left = Math.max(1, Math.round(width));
  let right = Math.max(1, Math.round(height));
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return `${Math.round(width) / left}:${Math.round(height) / left}`;
}

function resultPosition(nodes: readonly CanvasNode[]): { x: number; y: number } {
  const index = nodes.filter((node) => node.type === CANVAS_NODE_TYPES.exportImage).length;
  return {
    x: 64 + (index % 4) * 420,
    y: 64 + Math.floor(index / 4) * 320,
  };
}

export function createBatchImageCropResultSink(
  projectId: string,
  dependencies: BatchCropResultSinkDependencies = {},
): BatchCropResultSink {
  const projectState = dependencies.projectState ?? useProjectStore.getState;
  const canvasState = dependencies.canvasState ?? useCanvasStore.getState;

  return {
    async record(result) {
      const project = projectState();
      if (project.currentProjectId !== projectId) {
        throw new Error('BATCH_CROP_PROJECT_NOT_ACTIVE');
      }
      const before = canvasState();
      before.addNode(CANVAS_NODE_TYPES.exportImage, resultPosition(before.nodes), {
        displayName: result.fileName,
        imageUrl: null,
        previewImageUrl: null,
        assetId: result.assetId,
        aspectRatio: aspectRatio(result.target.width, result.target.height),
        resultKind: 'generic',
      });
      const after = canvasState();
      try {
        await project.saveCurrentProject(
          after.nodes,
          after.edges,
          after.currentViewport,
          after.history,
          { immediate: true },
        );
      } catch (error) {
        after.setCanvasData(before.nodes, before.edges, before.history);
        throw error;
      }
    },
  };
}
