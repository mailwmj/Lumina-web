import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { prepareNodeImage } from '@/features/canvas/application/imageData';
import { resolveFittedImageNodeSize } from '@/features/canvas/application/imageNodeSizing';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import type { CanvasAgentImportImageInput } from '@/features/canvas-agent/domain/types';
import { resolveCanvasAgentColumnLayout } from './canvasAgentLayout';

interface ImportCanvasAgentImagesInput {
  projectId: string;
  images: CanvasAgentImportImageInput[];
  position?: { x: number; y: number };
  assertCurrent: () => void;
}

export interface ImportCanvasAgentImagesResult {
  createdNodeIds: string[];
  nodeIdMap: Record<string, string>;
  placements: Array<{
    nodeId: string;
    position: { x: number; y: number };
  }>;
}

export async function importCanvasAgentImages({
  projectId,
  images,
  position,
  assertCurrent,
}: ImportCanvasAgentImagesInput): Promise<ImportCanvasAgentImagesResult> {
  const duplicateClientId = findDuplicate(images.map((image) => image.clientId));
  if (duplicateClientId) {
    throw new Error(`Duplicate imported image clientId: ${duplicateClientId}`);
  }

  const preparedImages = await Promise.all(images.map(async (image) => ({
    input: image,
    prepared: await prepareNodeImage(image.source, 512, projectId),
  })));
  assertCurrent();
  if (useProjectStore.getState().getCurrentProject()?.id !== projectId) {
    throw new Error('The active project changed while images were being prepared.');
  }

  const canvas = useCanvasStore.getState();
  const sizedImages = preparedImages.map(({ input, prepared }) => ({
    input,
    prepared,
    size: resolveFittedImageNodeSize(
      prepared.aspectRatio,
      { width: 280, height: 240 },
      { minWidth: EXPORT_RESULT_NODE_MIN_WIDTH, minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT }
    ),
  }));
  const layout = resolveCanvasAgentColumnLayout(
    canvas.nodes,
    sizedImages.map(({ input, size }) => ({
      key: input.clientId,
      width: size.width,
      height: size.height,
      nodeType: CANVAS_NODE_TYPES.upload,
    })),
    position
  );
  const placementByClientId = new Map(layout.map((placement) => [placement.key, placement]));
  const nodeIds = canvas.addNodeBatch(sizedImages.map(({ input, prepared, size }) => {
    const placement = placementByClientId.get(input.clientId);
    if (!placement) {
      throw new Error(`Unable to place imported image ${input.clientId}.`);
    }
    const fileName = normalizeFileName(input.fileName, input.source);
    const data: Partial<CanvasNodeData> = {
      imageUrl: prepared.imageUrl,
      previewImageUrl: prepared.previewImageUrl,
      aspectRatio: prepared.aspectRatio || '1:1',
      sourceFileName: fileName,
      ...(input.displayName ? { displayName: input.displayName } : {}),
    };
    return {
      type: CANVAS_NODE_TYPES.upload,
      position: placement.position,
      width: size.width,
      height: size.height,
      data,
    };
  }));
  const nodeIdMap = Object.fromEntries(images.map((image, index) => [image.clientId, nodeIds[index]]));

  return {
    createdNodeIds: nodeIds,
    nodeIdMap,
    placements: nodeIds.map((nodeId, index) => ({
      nodeId,
      position: layout[index].position,
    })),
  };
}

function normalizeFileName(explicitName: string | undefined, source: string): string {
  if (explicitName?.trim()) {
    return readSourceFileName(explicitName.trim());
  }
  if (source.startsWith('data:')) {
    return 'agent-image';
  }
  const withoutQuery = source.split(/[?#]/, 1)[0];
  const segments = withoutQuery.split(/[\\/]/);
  return safeDecodeFileName(segments[segments.length - 1] || 'agent-image');
}

function readSourceFileName(value: string): string {
  const segments = value.split(/[\\/]/);
  return safeDecodeFileName(segments[segments.length - 1] || 'agent-image');
}

function safeDecodeFileName(candidate: string): string {
  try {
    return decodeURIComponent(candidate);
  } catch {
    return candidate;
  }
}

function findDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return null;
}
