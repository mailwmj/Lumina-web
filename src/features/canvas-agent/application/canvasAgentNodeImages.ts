import { createPreviewDataUrl } from '@/features/canvas/application/imageData';
import { getNodeSourceDataTypes } from '@/features/canvas/domain/nodeRegistry';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';

interface CanvasAgentNodeImagesInput {
  projectId: string;
  nodeIds: string[];
  maxDimension: number;
}

export async function buildCanvasAgentNodeImages({
  projectId,
  nodeIds,
  maxDimension,
}: CanvasAgentNodeImagesInput) {
  if (useProjectStore.getState().getCurrentProject()?.id !== projectId) {
    throw new Error('The active project changed before node images were read.');
  }
  const nodeById = new Map(useCanvasStore.getState().nodes.map((node) => [node.id, node]));
  const requestedNodes = nodeIds.map((nodeId) => {
    const node = nodeById.get(nodeId);
    if (!node) {
      throw new Error(`Image node not found: ${nodeId}`);
    }
    if (!getNodeSourceDataTypes(node.type).includes('image')) {
      throw new Error(`Node ${nodeId} does not expose image data.`);
    }
    return node;
  });

  const images = await Promise.all(requestedNodes.map(async (node) => {
    const metadata = buildNodeImageMetadata(node);
    const source = readImageSource(node);
    if (!source) {
      return metadata;
    }
    try {
      const dataUrl = await createPreviewDataUrl(source, maxDimension, true, 'image/webp');
      return {
        ...metadata,
        mimeType: dataUrl.match(/^data:([^;,]+)/)?.[1] ?? 'image/jpeg',
        dataUrl,
      };
    } catch (error) {
      return {
        ...metadata,
        previewError: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  if (useProjectStore.getState().getCurrentProject()?.id !== projectId) {
    throw new Error('The active project changed while node images were being read.');
  }

  return { projectId, images };
}

function buildNodeImageMetadata(node: CanvasNode) {
  const data = node.data as Record<string, unknown>;
  const generationError = typeof data.generationError === 'string'
    ? data.generationError
    : null;
  return {
    nodeId: node.id,
    nodeType: node.type,
    displayName: resolveNodeDisplayName(node.type, node.data),
    status: resolveNodeImageStatus(data),
    aspectRatio: typeof data.aspectRatio === 'string' ? data.aspectRatio : null,
    generationError,
    generationRecoveryState: typeof data.generationRecoveryState === 'string'
      ? data.generationRecoveryState
      : null,
  };
}

function resolveNodeImageStatus(data: Record<string, unknown>): string {
  if (typeof data.imageUrl === 'string' && data.imageUrl.trim()) {
    return 'ready';
  }
  if (data.isGenerating === true) {
    return data.generationRecoveryState === 'attention_required'
      ? 'attention_required'
      : 'generating';
  }
  if (typeof data.generationError === 'string' && data.generationError.trim()) {
    return 'failed';
  }
  return 'empty';
}

function readImageSource(node: CanvasNode): string {
  const data = node.data as Record<string, unknown>;
  if (typeof data.previewImageUrl === 'string' && data.previewImageUrl.trim()) {
    return data.previewImageUrl;
  }
  return typeof data.imageUrl === 'string' ? data.imageUrl.trim() : '';
}
