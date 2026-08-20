import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import {
  CANVAS_MEDIA_IMPORT_GAP,
  CANVAS_MEDIA_IMPORT_ROW_WIDTH,
  classifyCanvasMediaPath,
  getCanvasMediaFileName,
  layoutCanvasMediaImportNodes,
  type PreparedCanvasMediaImport,
} from './canvasMediaImport';

function item(
  path: string,
  type: PreparedCanvasMediaImport['type'],
  width: number,
  height: number,
): PreparedCanvasMediaImport {
  return {
    path,
    fileName: getCanvasMediaFileName(path),
    type,
    data: {} as Partial<CanvasNodeData>,
    size: { width, height },
  };
}

describe('canvas media import', () => {
  it('classifies supported local paths by extension regardless of case', () => {
    expect(classifyCanvasMediaPath('/tmp/photo.PNG')).toBe('image');
    expect(classifyCanvasMediaPath('/tmp/clip.MOV')).toBe('video');
    expect(classifyCanvasMediaPath('/tmp/voice.m4a')).toBe('audio');
    expect(classifyCanvasMediaPath('/tmp/archive.zip')).toBeNull();
  });

  it('derives display file names from native paths and file URLs', () => {
    expect(getCanvasMediaFileName('/Users/example/my%20photo.png')).toBe('my photo.png');
    expect(getCanvasMediaFileName('C:\\media\\clip.mp4')).toBe('clip.mp4');
  });

  it('lays mixed media out in rows using actual dimensions without overlap', () => {
    const origin = { x: 100, y: 200 };
    const nodes = layoutCanvasMediaImportNodes([
      item('/tmp/photo.png', CANVAS_NODE_TYPES.upload, 384, 288),
      item('/tmp/voice.mp3', CANVAS_NODE_TYPES.audioUpload, 200, 120),
      item('/tmp/clip.mp4', CANVAS_NODE_TYPES.videoUpload, 200, 120),
      item('/tmp/panorama.png', CANVAS_NODE_TYPES.upload, 700, 180),
    ], origin);

    expect(nodes.map(({ position }) => position)).toEqual([
      { x: 100, y: 200 },
      { x: 524, y: 200 },
      { x: 764, y: 200 },
      { x: 100, y: 528 },
    ]);
    expect(nodes[3].position.y).toBe(origin.y + 288 + CANVAS_MEDIA_IMPORT_GAP);
    expect(nodes[3].position.x).toBe(origin.x);
    expect(nodes[2].position.x + nodes[2].width + CANVAS_MEDIA_IMPORT_GAP - origin.x)
      .toBeLessThanOrEqual(CANVAS_MEDIA_IMPORT_ROW_WIDTH);
  });
});
