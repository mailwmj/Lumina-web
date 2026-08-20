import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { createPreviewDataUrl } from '@/features/canvas/application/imageData';
import { getNodeSourceDataTypes } from '@/features/canvas/domain/nodeRegistry';
import type { CanvasAgentImagePreview } from '@/features/canvas-agent/domain/types';

const MAX_SELECTED_PREVIEWS = 6;
const PREVIEW_MAX_DIMENSION = 320;
const MAX_PREVIEW_DATA_URL_LENGTH = 1_500_000;

export interface SelectedImagePreviewSource {
  nodeId: string;
  source: string;
}

export function collectSelectedImagePreviewSources(
  nodes: CanvasNode[],
  selectedNodeIds: string[]
): SelectedImagePreviewSource[] {
  const selectedIds = new Set(selectedNodeIds);
  return nodes.flatMap((node) => {
    if (
      !selectedIds.has(node.id)
      || !getNodeSourceDataTypes(node.type).includes('image')
    ) {
      return [];
    }
    const data = node.data as Record<string, unknown>;
    const source = normalizeImageSource(data.previewImageUrl)
      || normalizeImageSource(data.imageUrl);
    return source ? [{ nodeId: node.id, source }] : [];
  }).slice(0, MAX_SELECTED_PREVIEWS);
}

export async function buildSelectedImagePreviews(
  sources: SelectedImagePreviewSource[]
): Promise<CanvasAgentImagePreview[]> {
  const previews: CanvasAgentImagePreview[] = [];
  for (const item of sources) {
    try {
      const dataUrl = await createPreviewDataUrl(item.source, PREVIEW_MAX_DIMENSION, true);
      if (!dataUrl.startsWith('data:image/') || dataUrl.length > MAX_PREVIEW_DATA_URL_LENGTH) {
        continue;
      }
      const mimeType = dataUrl.match(/^data:([^;,]+)/)?.[1] ?? 'image/jpeg';
      previews.push({ nodeId: item.nodeId, mimeType, dataUrl });
    } catch {
      // A missing preview must not block publishing the rest of the live canvas state.
    }
  }
  return previews;
}

function normalizeImageSource(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  return value.startsWith('data:image/') ? value : value.trim();
}
