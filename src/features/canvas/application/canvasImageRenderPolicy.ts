import type { Viewport } from '@xyflow/react';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

export const CANVAS_IMAGE_QUALITY_SETTLE_DELAY_MS = 180;
export const MIN_ORIGINAL_IMAGE_VISIBLE_RATIO = 0.25;
// Previews are currently capped at 512px. Start the original-image decode before
// the preview reaches a one-to-one physical-pixel display, so the transition is
// not perceived as a blurry intermediate state on high-density screens.
export const MIN_ORIGINAL_IMAGE_SCREEN_LONG_SIDE_PX = 360;

export interface CanvasImageRenderSourceInput {
  nodeId: string;
  imageUrl: string | null | undefined;
  previewImageUrl: string | null | undefined;
  focusedNodeId: string | null;
  retainedOriginalNodeIds?: readonly string[];
  requestedOriginalNodeIds?: readonly string[];
}

export interface CanvasImageFocusInput {
  nodes: readonly CanvasNode[];
  viewport: Viewport;
  viewportSize: { width: number; height: number };
  /**
   * A node directly resized by the user takes precedence after it settles,
   * provided its displayed image has reached the original-image threshold.
   */
  preferredNodeId?: string | null;
  /** Canvas-relative point where the user zoomed. */
  focusPoint?: { x: number; y: number } | null;
  /** Kept explicit so the policy is deterministic and testable. */
  devicePixelRatio?: number;
}

export interface CanvasOriginalImageRequestInput {
  nodes: readonly CanvasNode[];
  viewport: Viewport;
  viewportSize: { width: number; height: number };
  isOriginalImageMode: boolean;
  focusPoint?: { x: number; y: number } | null;
  devicePixelRatio?: number;
  minimumVisibleRatio?: number;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getNodeImageUrl(node: CanvasNode): string | null {
  return nonEmptyString((node.data as { imageUrl?: unknown }).imageUrl);
}

function getNodePreviewImageUrl(node: CanvasNode): string | null {
  return nonEmptyString((node.data as { previewImageUrl?: unknown }).previewImageUrl);
}

function isCanvasImageRenderNode(node: CanvasNode): boolean {
  return node.type === CANVAS_NODE_TYPES.upload
    || node.type === CANVAS_NODE_TYPES.imageEdit
    || node.type === CANVAS_NODE_TYPES.exportImage;
}

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  const declaredWidth = typeof node.width === 'number' ? node.width : null;
  const declaredHeight = typeof node.height === 'number' ? node.height : null;

  return {
    width: node.measured?.width ?? declaredWidth ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? declaredHeight ?? styleHeight ?? 200,
  };
}

function getNodeImageAspectRatio(node: CanvasNode): number {
  const value = (node.data as { aspectRatio?: unknown }).aspectRatio;
  if (typeof value !== 'string') {
    return 1;
  }

  const [width, height] = value.split(':').map((part) => Number(part));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }
  return width / height;
}

function getContainedImageSize(node: CanvasNode): { width: number; height: number } {
  const nodeSize = getNodeSize(node);
  const imageAspectRatio = getNodeImageAspectRatio(node);
  const nodeAspectRatio = nodeSize.width / Math.max(1, nodeSize.height);

  if (imageAspectRatio >= nodeAspectRatio) {
    return {
      width: nodeSize.width,
      height: nodeSize.width / imageAspectRatio,
    };
  }

  return {
    width: nodeSize.height * imageAspectRatio,
    height: nodeSize.height,
  };
}

function getNodeAbsolutePosition(
  node: CanvasNode,
  nodesById: ReadonlyMap<string, CanvasNode>
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const visited = new Set<string>();

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodesById.get(parentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }

  return { x, y };
}

function isVisibleInViewport(
  node: CanvasNode,
  viewport: Viewport,
  viewportSize: { width: number; height: number },
  nodesById: ReadonlyMap<string, CanvasNode>
): boolean {
  const zoom = Math.max(0.01, viewport.zoom);
  const minX = -viewport.x / zoom;
  const minY = -viewport.y / zoom;
  const maxX = minX + viewportSize.width / zoom;
  const maxY = minY + viewportSize.height / zoom;
  const size = getNodeSize(node);
  const position = getNodeAbsolutePosition(node, nodesById);

  return (
    position.x < maxX
    && position.x + size.width > minX
    && position.y < maxY
    && position.y + size.height > minY
  );
}

function hasInspectionScale(
  node: CanvasNode,
  viewport: Viewport,
  devicePixelRatio: number
): boolean {
  const containedImageSize = getContainedImageSize(node);
  const screenLongSide = Math.max(containedImageSize.width, containedImageSize.height)
    * Math.max(0.01, viewport.zoom)
    * devicePixelRatio;
  return screenLongSide >= MIN_ORIGINAL_IMAGE_SCREEN_LONG_SIDE_PX;
}

function getNodeCenter(
  node: CanvasNode,
  nodesById: ReadonlyMap<string, CanvasNode>
): { x: number; y: number } {
  const size = getNodeSize(node);
  const position = getNodeAbsolutePosition(node, nodesById);
  return {
    x: position.x + size.width / 2,
    y: position.y + size.height / 2,
  };
}

function isPointWithinNode(
  node: CanvasNode,
  point: { x: number; y: number },
  nodesById: ReadonlyMap<string, CanvasNode>
): boolean {
  const size = getNodeSize(node);
  const position = getNodeAbsolutePosition(node, nodesById);
  return point.x >= position.x
    && point.x <= position.x + size.width
    && point.y >= position.y
    && point.y <= position.y + size.height;
}

function getNodeZIndex(node: CanvasNode): number {
  if (typeof node.zIndex === 'number') {
    return node.zIndex;
  }
  return typeof node.style?.zIndex === 'number' ? node.style.zIndex : 0;
}

function getViewportFlowBounds(
  viewport: Viewport,
  viewportSize: { width: number; height: number }
): { minX: number; minY: number; maxX: number; maxY: number } {
  const zoom = Math.max(0.01, viewport.zoom);
  const minX = -viewport.x / zoom;
  const minY = -viewport.y / zoom;
  return {
    minX,
    minY,
    maxX: minX + viewportSize.width / zoom,
    maxY: minY + viewportSize.height / zoom,
  };
}

function getNodeVisibleMetrics(
  node: CanvasNode,
  viewport: Viewport,
  viewportSize: { width: number; height: number },
  nodesById: ReadonlyMap<string, CanvasNode>,
  focusPoint: { x: number; y: number } | null
): { visibleRatio: number; screenArea: number; distanceFromFocus: number } | null {
  const bounds = getViewportFlowBounds(viewport, viewportSize);
  const position = getNodeAbsolutePosition(node, nodesById);
  const size = getNodeSize(node);
  const visibleWidth = Math.max(0, Math.min(position.x + size.width, bounds.maxX) - Math.max(position.x, bounds.minX));
  const visibleHeight = Math.max(0, Math.min(position.y + size.height, bounds.maxY) - Math.max(position.y, bounds.minY));
  const visibleArea = visibleWidth * visibleHeight;
  if (visibleArea <= 0) {
    return null;
  }

  const zoom = Math.max(0.01, viewport.zoom);
  const flowFocus = focusPoint
    ? {
      x: (focusPoint.x - viewport.x) / zoom,
      y: (focusPoint.y - viewport.y) / zoom,
    }
    : {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
  const center = {
    x: position.x + size.width / 2,
    y: position.y + size.height / 2,
  };

  return {
    visibleRatio: visibleArea / Math.max(1, size.width * size.height),
    screenArea: visibleArea * zoom * zoom,
    distanceFromFocus: Math.hypot(center.x - flowFocus.x, center.y - flowFocus.y),
  };
}

function findPointFocusCandidate(
  candidates: readonly CanvasNode[],
  focusPoint: { x: number; y: number },
  viewport: Viewport,
  nodesById: ReadonlyMap<string, CanvasNode>
): CanvasNode | null {
  const zoom = Math.max(0.01, viewport.zoom);
  const flowPoint = {
    x: (focusPoint.x - viewport.x) / zoom,
    y: (focusPoint.y - viewport.y) / zoom,
  };
  const pointCandidates = candidates.filter((node) => (
    isPointWithinNode(node, flowPoint, nodesById)
  ));
  if (pointCandidates.length === 0) {
    return null;
  }

  return pointCandidates.reduce((topmost, node) => {
    const topmostZIndex = getNodeZIndex(topmost);
    const nodeZIndex = getNodeZIndex(node);
    if (nodeZIndex !== topmostZIndex) {
      return nodeZIndex > topmostZIndex ? node : topmost;
    }

    const topmostCenter = getNodeCenter(topmost, nodesById);
    const nodeCenter = getNodeCenter(node, nodesById);
    const topmostDistance = Math.hypot(
      topmostCenter.x - flowPoint.x,
      topmostCenter.y - flowPoint.y
    );
    const nodeDistance = Math.hypot(nodeCenter.x - flowPoint.x, nodeCenter.y - flowPoint.y);
    return nodeDistance < topmostDistance ? node : topmost;
  });
}

export function hasDistinctCanvasImagePreview(
  imageUrl: string | null | undefined,
  previewImageUrl: string | null | undefined
): boolean {
  const original = nonEmptyString(imageUrl);
  const preview = nonEmptyString(previewImageUrl);
  return Boolean(original && preview && original !== preview);
}

export function resolveCanvasImageRenderSource({
  nodeId,
  imageUrl,
  previewImageUrl,
  focusedNodeId,
  retainedOriginalNodeIds = [],
  requestedOriginalNodeIds = [],
}: CanvasImageRenderSourceInput): string | null {
  const original = nonEmptyString(imageUrl);
  const preview = nonEmptyString(previewImageUrl);
  if (!original) {
    return preview;
  }
  if (!preview || preview === original) {
    return original;
  }

  if (
    focusedNodeId !== nodeId
    && !retainedOriginalNodeIds.includes(nodeId)
    && !requestedOriginalNodeIds.includes(nodeId)
  ) {
    return preview;
  }

  return original;
}

export function getVisibleCanvasImageNodeIds({
  nodes,
  viewport,
  viewportSize,
}: Pick<CanvasImageFocusInput, 'nodes' | 'viewport' | 'viewportSize'>): string[] {
  if (viewportSize.width <= 0 || viewportSize.height <= 0) {
    return [];
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  return nodes
    .filter((node) => isCanvasImageRenderNode(node) && isVisibleInViewport(
      node,
      viewport,
      viewportSize,
      nodesById
    ))
    .map((node) => node.id);
}

export function getRequestedCanvasOriginalNodeIds({
  nodes,
  viewport,
  viewportSize,
  isOriginalImageMode,
  focusPoint = null,
  devicePixelRatio = 1,
  minimumVisibleRatio = MIN_ORIGINAL_IMAGE_VISIBLE_RATIO,
}: CanvasOriginalImageRequestInput): string[] {
  if (!isOriginalImageMode || viewportSize.width <= 0 || viewportSize.height <= 0) {
    return [];
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const normalizedDevicePixelRatio = Number.isFinite(devicePixelRatio)
    ? Math.max(1, devicePixelRatio)
    : 1;
  return nodes
    .flatMap((node) => {
      if (
        !isCanvasImageRenderNode(node)
        || !getNodeImageUrl(node)
        || !hasDistinctCanvasImagePreview(
          getNodeImageUrl(node),
          getNodePreviewImageUrl(node)
        )
        || !hasInspectionScale(node, viewport, normalizedDevicePixelRatio)
      ) {
        return [];
      }
      const metrics = getNodeVisibleMetrics(
        node,
        viewport,
        viewportSize,
        nodesById,
        focusPoint
      );
      return metrics && metrics.visibleRatio >= minimumVisibleRatio
        ? [{ nodeId: node.id, ...metrics }]
        : [];
    })
    .sort((left, right) => (
      left.distanceFromFocus - right.distanceFromFocus
      || right.screenArea - left.screenArea
    ))
    .map((item) => item.nodeId);
}

export function findCanvasImageFocusCandidate({
  nodes,
  viewport,
  viewportSize,
  preferredNodeId = null,
  focusPoint = null,
  devicePixelRatio = 1,
}: CanvasImageFocusInput): string | null {
  if (viewportSize.width <= 0 || viewportSize.height <= 0) {
    return null;
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const normalizedDevicePixelRatio = Number.isFinite(devicePixelRatio)
    ? Math.max(1, devicePixelRatio)
    : 1;
  const candidates = nodes.filter((node) => (
    isCanvasImageRenderNode(node)
    && getNodeImageUrl(node)
    && hasDistinctCanvasImagePreview(
      getNodeImageUrl(node),
      getNodePreviewImageUrl(node)
    )
    && isVisibleInViewport(node, viewport, viewportSize, nodesById)
    && hasInspectionScale(node, viewport, normalizedDevicePixelRatio)
  ));
  if (candidates.length === 0) {
    return null;
  }

  const preferredCandidate = preferredNodeId
    ? candidates.find((node) => node.id === preferredNodeId)
    : undefined;
  if (preferredCandidate) {
    return preferredCandidate.id;
  }

  if (focusPoint) {
    const pointCandidate = findPointFocusCandidate(
      candidates,
      focusPoint,
      viewport,
      nodesById
    );
    if (pointCandidate) {
      return pointCandidate.id;
    }
  }

  const zoom = Math.max(0.01, viewport.zoom);
  const viewportCenterX = (-viewport.x + viewportSize.width / 2) / zoom;
  const viewportCenterY = (-viewport.y + viewportSize.height / 2) / zoom;

  return candidates.reduce((closest, node) => {
    const closestCenter = getNodeCenter(closest, nodesById);
    const nodeCenter = getNodeCenter(node, nodesById);
    const closestDistance = Math.hypot(
      closestCenter.x - viewportCenterX,
      closestCenter.y - viewportCenterY
    );
    const nodeDistance = Math.hypot(
      nodeCenter.x - viewportCenterX,
      nodeCenter.y - viewportCenterY
    );
    return nodeDistance < closestDistance ? node : closest;
  }).id;
}
