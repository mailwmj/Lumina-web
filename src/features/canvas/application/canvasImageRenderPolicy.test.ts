import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  findCanvasImageFocusCandidate,
  getRequestedCanvasOriginalNodeIds,
  getVisibleCanvasImageNodeIds,
  hasDistinctCanvasImagePreview,
  resolveCanvasImageRenderSource,
} from './canvasImageRenderPolicy';

function createImageNode(
  id: string,
  position: { x: number; y: number },
  size: { width: number; height: number },
  previewImageUrl = `file:///preview-${id}.jpg`,
  aspectRatio = '1:1'
): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.exportImage,
    position,
    width: size.width,
    height: size.height,
    data: {
      imageUrl: `file:///original-${id}.jpg`,
      previewImageUrl,
      aspectRatio,
    },
  };
}

describe('canvas image render policy', () => {
  it('uses the thumbnail while the image is not focused', () => {
    expect(resolveCanvasImageRenderSource({
      nodeId: 'image-1',
      imageUrl: 'file:///original.jpg',
      previewImageUrl: 'file:///preview.jpg',
      focusedNodeId: null,
    })).toBe('file:///preview.jpg');
  });

  it('does not keep a focused, zoomed image on its thumbnail during wheel interaction', () => {
    expect(resolveCanvasImageRenderSource({
      nodeId: 'image-1',
      imageUrl: 'file:///original.jpg',
      previewImageUrl: 'file:///preview.jpg',
      focusedNodeId: 'image-1',
    })).toBe('file:///original.jpg');
  });

  it('keeps a recently inspected image on its original while it remains retained', () => {
    expect(resolveCanvasImageRenderSource({
      nodeId: 'image-1',
      imageUrl: 'file:///original.jpg',
      previewImageUrl: 'file:///preview.jpg',
      focusedNodeId: 'image-2',
      retainedOriginalNodeIds: ['image-1'],
    })).toBe('file:///original.jpg');
  });

  it('identifies image nodes that remain visible after a viewport move', () => {
    const visible = createImageNode('visible', { x: 0, y: 0 }, { width: 400, height: 400 });
    const offscreen = createImageNode('offscreen', { x: 1600, y: 0 }, { width: 400, height: 400 });

    expect(getVisibleCanvasImageNodeIds({
      nodes: [visible, offscreen],
      viewport: { x: 0, y: 0, zoom: 2 },
      viewportSize: { width: 1000, height: 800 },
    })).toEqual([visible.id]);
  });

  it('requests originals for sufficiently visible images in inspection mode', () => {
    const visible = createImageNode('visible', { x: 0, y: 0 }, { width: 200, height: 200 });
    const secondVisible = createImageNode('second-visible', { x: 220, y: 0 }, { width: 200, height: 200 });
    const offscreen = createImageNode('offscreen', { x: 1000, y: 0 }, { width: 200, height: 200 });

    expect(getRequestedCanvasOriginalNodeIds({
      nodes: [visible, secondVisible, offscreen],
      viewport: { x: 0, y: 0, zoom: 2 },
      viewportSize: { width: 1000, height: 800 },
      isOriginalImageMode: true,
      focusPoint: { x: 160, y: 160 },
    })).toEqual([visible.id, secondVisible.id]);

    expect(getRequestedCanvasOriginalNodeIds({
      nodes: [visible, secondVisible, offscreen],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1000, height: 800 },
      isOriginalImageMode: false,
    })).toEqual([]);
  });

  it('does not request an image whose visible area is below the threshold', () => {
    const mostlyHidden = createImageNode('mostly-hidden', { x: 480, y: 0 }, { width: 400, height: 400 });

    expect(getRequestedCanvasOriginalNodeIds({
      nodes: [mostlyHidden],
      viewport: { x: 0, y: 0, zoom: 2 },
      viewportSize: { width: 1000, height: 800 },
      isOriginalImageMode: true,
    })).toEqual([]);
  });

  it('keeps small overview images on their previews even in inspection mode', () => {
    const small = createImageNode('small', { x: 0, y: 0 }, { width: 100, height: 100 });

    expect(getRequestedCanvasOriginalNodeIds({
      nodes: [small],
      viewport: { x: 0, y: 0, zoom: 2.25 },
      viewportSize: { width: 1000, height: 800 },
      isOriginalImageMode: true,
    })).toEqual([]);
  });

  it('requests an original for a manually enlarged image even at canvas zoom 1', () => {
    const enlarged = createImageNode('enlarged', { x: 0, y: 0 }, { width: 800, height: 800 });

    expect(getRequestedCanvasOriginalNodeIds({
      nodes: [enlarged],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1000, height: 800 },
      isOriginalImageMode: true,
    })).toEqual([enlarged.id]);
  });

  it('uses the original after a visible image finishes loading it', () => {
    expect(resolveCanvasImageRenderSource({
      nodeId: 'image-1',
      imageUrl: 'file:///original.jpg',
      previewImageUrl: 'file:///preview.jpg',
      focusedNodeId: null,
      requestedOriginalNodeIds: ['image-1'],
    })).toBe('file:///original.jpg');
  });

  it('falls back to the original when no distinct preview exists', () => {
    expect(hasDistinctCanvasImagePreview('file:///original.jpg', 'file:///original.jpg')).toBe(false);
    expect(resolveCanvasImageRenderSource({
      nodeId: 'image-1',
      imageUrl: 'file:///original.jpg',
      previewImageUrl: 'file:///original.jpg',
      focusedNodeId: null,
    })).toBe('file:///original.jpg');
  });

  it('prefers the image under the zoom point over the center candidate', () => {
    const centered = createImageNode('centered', { x: 250, y: 150 }, { width: 500, height: 500 });
    const pointed = createImageNode('pointed', { x: 20, y: 80 }, { width: 500, height: 500 });

    expect(findCanvasImageFocusCandidate({
      nodes: [centered, pointed],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1000, height: 800 },
      focusPoint: { x: 120, y: 180 },
    })).toBe(pointed.id);
  });

  it('renders the just-resized image only after its displayed content reaches the threshold', () => {
    const belowThreshold = createImageNode(
      'below-threshold',
      { x: 300, y: 250 },
      { width: 179, height: 179 }
    );
    const resized = createImageNode(
      'resized',
      { x: 300, y: 250 },
      { width: 180, height: 180 }
    );

    expect(findCanvasImageFocusCandidate({
      nodes: [belowThreshold],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1000, height: 800 },
      preferredNodeId: belowThreshold.id,
      devicePixelRatio: 2,
    })).toBeNull();

    expect(findCanvasImageFocusCandidate({
      nodes: [resized],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1000, height: 800 },
      preferredNodeId: resized.id,
      devicePixelRatio: 2,
    })).toBe(resized.id);
  });

  it('uses the closest sufficiently large visible image to the canvas center by default', () => {
    const centered = createImageNode('centered', { x: 250, y: 150 }, { width: 500, height: 500 });
    const distant = createImageNode('distant', { x: -320, y: 80 }, { width: 500, height: 500 });

    expect(findCanvasImageFocusCandidate({
      nodes: [distant, centered],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1000, height: 800 },
    })).toBe(centered.id);
  });

  it('uses actual physical pixels so high-density displays do not need oversized nodes', () => {
    const image = createImageNode('image', { x: 300, y: 250 }, { width: 180, height: 180 });

    expect(findCanvasImageFocusCandidate({
      nodes: [image],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1000, height: 800 },
      devicePixelRatio: 2,
    })).toBe(image.id);

    expect(findCanvasImageFocusCandidate({
      nodes: [image],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1000, height: 800 },
      devicePixelRatio: 1,
    })).toBeNull();
  });

  it('measures the contained image instead of blank space in a stretched node', () => {
    const letterboxed = createImageNode(
      'letterboxed',
      { x: 300, y: 250 },
      { width: 600, height: 200 },
      undefined,
      '1:1'
    );

    expect(findCanvasImageFocusCandidate({
      nodes: [letterboxed],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1000, height: 800 },
      devicePixelRatio: 1,
    })).toBeNull();
  });

  it('uses absolute positions for image nodes nested in a group', () => {
    const group: CanvasNode = {
      id: 'group-1',
      type: CANVAS_NODE_TYPES.group,
      position: { x: 250, y: 150 },
      width: 700,
      height: 600,
      data: { label: 'Group' },
    };
    const child = {
      ...createImageNode('child', { x: 0, y: 0 }, { width: 500, height: 500 }),
      parentId: group.id,
    };

    expect(findCanvasImageFocusCandidate({
      nodes: [group, child],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1000, height: 800 },
      preferredNodeId: child.id,
    })).toBe(child.id);
  });
});
