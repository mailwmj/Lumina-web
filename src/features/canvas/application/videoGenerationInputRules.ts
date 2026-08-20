import { CANVAS_NODE_TYPES, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';

export function isVideoGenerationImageCountValid(
  nodeType: CanvasNodeType | undefined,
  imageCount: number
): boolean {
  if (nodeType === CANVAS_NODE_TYPES.videoFrame) {
    return imageCount === 2;
  }

  return imageCount >= 0 && imageCount <= 1;
}
