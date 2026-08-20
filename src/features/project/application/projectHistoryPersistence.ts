import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type {
  CanvasHistoryState,
  CanvasNode,
  CanvasNodeData,
} from '@/stores/canvasStore';

const MAX_PERSISTED_HISTORY_STEPS = 12;

export interface PersistedProjectHistory {
  past: CanvasHistoryState['past'];
  future: CanvasHistoryState['future'];
}

export function sanitizeProjectNodesForPersistence(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((node) => {
    if (node.type !== CANVAS_NODE_TYPES.textGeneration) {
      return node;
    }
    const data = { ...node.data } as Record<string, unknown>;
    delete data.isGenerating;
    delete data.generationError;
    delete data.generationErrorDetails;
    return { ...node, data: data as CanvasNodeData };
  });
}

function sanitizeProjectHistoryForPersistence(history: CanvasHistoryState): CanvasHistoryState {
  return {
    past: history.past.map((snapshot) => ({
      ...snapshot,
      nodes: sanitizeProjectNodesForPersistence(snapshot.nodes),
    })),
    future: history.future.map((snapshot) => ({
      ...snapshot,
      nodes: sanitizeProjectNodesForPersistence(snapshot.nodes),
    })),
  };
}

export function trimHistoryForPersistence(history: CanvasHistoryState): CanvasHistoryState {
  return {
    past: history.past.slice(-MAX_PERSISTED_HISTORY_STEPS),
    future: history.future.slice(-MAX_PERSISTED_HISTORY_STEPS),
  };
}

export function stripAssetBackedDisplayUrls(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((node) => {
    const data = { ...(node.data as Record<string, unknown>) };
    const hasAsset = typeof data.assetId === 'string' && data.assetId.length > 0;
    const hasPreviewAsset = typeof data.previewAssetId === 'string' && data.previewAssetId.length > 0;
    if (hasAsset) {
      delete data.imageUrl;
      delete data.videoUrl;
      delete data.audioUrl;
    }
    if (hasAsset || hasPreviewAsset) {
      delete data.previewImageUrl;
      delete data.previewVideoUrl;
    }
    if (Array.isArray(data.frames)) {
      data.frames = data.frames.map((frame) => {
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
          return frame;
        }
        const nextFrame = { ...(frame as Record<string, unknown>) };
        const frameHasAsset = typeof nextFrame.assetId === 'string' && nextFrame.assetId.length > 0;
        const frameHasPreviewAsset = typeof nextFrame.previewAssetId === 'string'
          && nextFrame.previewAssetId.length > 0;
        if (frameHasAsset) {
          delete nextFrame.imageUrl;
        }
        if (frameHasAsset || frameHasPreviewAsset) {
          delete nextFrame.previewImageUrl;
        }
        return nextFrame;
      });
    }
    return { ...node, data: data as CanvasNodeData };
  });
}

function stripHistoryDisplayUrls(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((node) => {
    const data = { ...(node.data as Record<string, unknown>) };
    delete data.imageUrl;
    delete data.videoUrl;
    delete data.audioUrl;
    delete data.previewImageUrl;
    delete data.previewVideoUrl;
    if (Array.isArray(data.frames)) {
      data.frames = data.frames.map((frame) => {
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
          return frame;
        }
        const nextFrame = { ...(frame as Record<string, unknown>) };
        delete nextFrame.imageUrl;
        delete nextFrame.previewImageUrl;
        return nextFrame;
      });
    }
    return { ...node, data: data as CanvasNodeData };
  });
}

export function serializeProjectHistory(history: CanvasHistoryState): PersistedProjectHistory {
  const trimmed = trimHistoryForPersistence(sanitizeProjectHistoryForPersistence(history));
  return {
    past: trimmed.past.map((snapshot) => ({
      ...snapshot,
      nodes: stripHistoryDisplayUrls(snapshot.nodes),
    })),
    future: trimmed.future.map((snapshot) => ({
      ...snapshot,
      nodes: stripHistoryDisplayUrls(snapshot.nodes),
    })),
  };
}

export function deserializeProjectHistory(historyJson: string): CanvasHistoryState {
  const parsed = safeParseJson<Partial<PersistedProjectHistory>>(historyJson, {});
  return {
    past: Array.isArray(parsed.past) ? parsed.past : [],
    future: Array.isArray(parsed.future) ? parsed.future : [],
  };
}

function safeParseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
