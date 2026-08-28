import { resolveMediaReferences } from '@/features/assets/application/mediaDisplayResolver';
import { createPreviewDataUrl } from '@/features/canvas/application/imageData';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { runtimeMediaDisplayResolver } from '@/runtime/mediaRuntime';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';

interface CanvasAgentVideoResultsInput {
  projectId: string;
  nodeIds: string[];
  maxDimension: number;
}

export async function buildCanvasAgentVideoResults({
  projectId,
  nodeIds,
  maxDimension,
}: CanvasAgentVideoResultsInput) {
  if (useProjectStore.getState().getCurrentProject()?.id !== projectId) {
    throw new Error('The active project changed before video results were read.');
  }
  const nodeById = new Map(useCanvasStore.getState().nodes.map((node) => [node.id, node]));
  const nodes = nodeIds.map((nodeId) => {
    const node = nodeById.get(nodeId);
    if (!node || node.type !== CANVAS_NODE_TYPES.exportVideo) {
      throw new Error(`Video result node not found: ${nodeId}`);
    }
    return node;
  });

  const videos = await Promise.all(nodes.map((node) => buildVideoResult(node, maxDimension)));
  if (useProjectStore.getState().getCurrentProject()?.id !== projectId) {
    throw new Error('The active project changed while video results were being read.');
  }
  return { projectId, videos };
}

async function buildVideoResult(node: CanvasNode, maxDimension: number) {
  const data = node.data as Record<string, unknown>;
  const resolved = await resolveMediaReferences(runtimeMediaDisplayResolver, [
    {
      kind: 'image',
      assetId: readString(data.previewAssetId),
      legacyUrl: readString(data.previewImageUrl),
    },
    {
      kind: 'image',
      assetId: readString(data.lastFrameAssetId),
      legacyUrl: readString(data.lastFrameImageUrl),
    },
  ]);
  try {
    const [posterPreview, lastFramePreview] = await Promise.all(
      resolved.urls.map((source) => buildCompressedPreview(source, maxDimension)),
    );
    return {
      nodeId: node.id,
      nodeType: node.type,
      displayName: resolveNodeDisplayName(node.type, node.data),
      status: resolveVideoStatus(data),
      aspectRatio: readString(data.aspectRatio),
      model: readString(data.model),
      duration: typeof data.duration === 'number' ? data.duration : null,
      assetId: readString(data.assetId),
      previewAssetId: readString(data.previewAssetId),
      lastFrameAssetId: readString(data.lastFrameAssetId),
      generationJobId: readString(data.generationJobId),
      generationProviderRequestId: readString(data.generationProviderRequestId),
      generationError: readString(data.generationError),
      generationRecoveryState: readString(data.generationRecoveryState),
      ...(posterPreview ? { posterPreview } : {}),
      ...(lastFramePreview ? { lastFramePreview } : {}),
    };
  } finally {
    resolved.release();
  }
}

async function buildCompressedPreview(source: string | null, maxDimension: number) {
  if (!source) return null;
  try {
    const dataUrl = await createPreviewDataUrl(source, maxDimension, true, 'image/webp');
    return {
      mimeType: dataUrl.match(/^data:([^;,]+)/)?.[1] ?? 'image/webp',
      dataUrl,
    };
  } catch (error) {
    return {
      previewError: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveVideoStatus(data: Record<string, unknown>): string {
  if (data.isGenerating === true) {
    return data.generationRecoveryState === 'attention_required'
      ? 'attention_required'
      : 'generating';
  }
  if (readString(data.generationError)) return 'failed';
  if (data.generationRecoveryState === 'attention_required') return 'attention_required';
  return readString(data.assetId) ? 'ready' : 'empty';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
