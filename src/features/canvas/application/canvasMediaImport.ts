import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type CanvasNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import { prepareNodeImage } from '@/features/canvas/application/imageData';
import { resolveFittedImageNodeSize, type ImageNodeSize } from '@/features/canvas/application/imageNodeSizing';
import { convertAudioToMp3, convertVideoToMp4 } from '@/commands/media';

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mpeg', 'mpg'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac'];

const imageExtensionSet = new Set<string>(IMAGE_EXTENSIONS);
const videoExtensionSet = new Set<string>(VIDEO_EXTENSIONS);
const audioExtensionSet = new Set<string>(AUDIO_EXTENSIONS);

const IMAGE_IMPORT_TARGET_SIZE = {
  width: EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  height: EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
};
const IMAGE_IMPORT_MIN_SIZE = {
  minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
  minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
};
const AUDIO_IMPORT_SIZE = { width: 200, height: 120 };
const VIDEO_IMPORT_SIZE = { width: 200, height: 120 };

export const CANVAS_MEDIA_IMPORT_GAP = 40;
export const CANVAS_MEDIA_IMPORT_ROW_WIDTH = 1440;
const DEFAULT_IMPORT_CONCURRENCY = 2;

export type CanvasMediaType = 'image' | 'video' | 'audio';

export function createCanvasMediaImportDialogFilters(labels: {
  images: string;
  videos: string;
  audio: string;
}): Array<{ name: string; extensions: string[] }> {
  return [
    { name: labels.images, extensions: IMAGE_EXTENSIONS },
    { name: labels.videos, extensions: VIDEO_EXTENSIONS },
    { name: labels.audio, extensions: AUDIO_EXTENSIONS },
  ];
}

export interface PreparedCanvasMediaImport {
  path: string;
  fileName: string;
  type: CanvasNodeType;
  data: Partial<CanvasNodeData>;
  size: ImageNodeSize;
}

export interface CanvasMediaImportFailure {
  path: string;
  error: unknown;
}

export interface CanvasMediaImportBatchResult {
  items: PreparedCanvasMediaImport[];
  failures: CanvasMediaImportFailure[];
}

export interface CanvasMediaImportNodeInput {
  type: CanvasNodeType;
  position: { x: number; y: number };
  data: Partial<CanvasNodeData>;
  width: number;
  height: number;
}

export function getCanvasMediaFileName(path: string): string {
  const source = path.split(/[\\/]/).pop() || path;
  try {
    return decodeURIComponent(source);
  } catch {
    return source;
  }
}

export function classifyCanvasMediaPath(path: string): CanvasMediaType | null {
  const fileName = getCanvasMediaFileName(path);
  const extension = fileName.includes('.')
    ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
    : '';

  if (imageExtensionSet.has(extension)) return 'image';
  if (videoExtensionSet.has(extension)) return 'video';
  if (audioExtensionSet.has(extension)) return 'audio';
  return null;
}

async function prepareCanvasMediaImport(
  path: string,
  projectId: string | undefined,
  useFileNameAsNodeTitle: boolean,
): Promise<PreparedCanvasMediaImport> {
  const mediaType = classifyCanvasMediaPath(path);
  const fileName = getCanvasMediaFileName(path);
  if (!mediaType) {
    throw new Error(`Unsupported media file: ${fileName}`);
  }

  const displayName = useFileNameAsNodeTitle ? { displayName: fileName } : {};
  if (mediaType === 'image') {
    const prepared = await prepareNodeImage(path, 512, projectId);
    return {
      path,
      fileName,
      type: CANVAS_NODE_TYPES.upload,
      data: {
        imageUrl: prepared.imageUrl,
        previewImageUrl: prepared.previewImageUrl,
        aspectRatio: prepared.aspectRatio,
        sourceFileName: fileName,
        ...displayName,
      },
      size: resolveFittedImageNodeSize(
        prepared.aspectRatio,
        IMAGE_IMPORT_TARGET_SIZE,
        IMAGE_IMPORT_MIN_SIZE,
      ),
    };
  }

  if (mediaType === 'video') {
    const videoUrl = projectId ? await convertVideoToMp4(path, projectId) : path;
    return {
      path,
      fileName,
      type: CANVAS_NODE_TYPES.videoUpload,
      data: { videoUrl, sourceFileName: fileName, ...displayName },
      size: VIDEO_IMPORT_SIZE,
    };
  }

  const audioUrl = projectId ? await convertAudioToMp3(path, projectId) : path;
  return {
    path,
    fileName,
    type: CANVAS_NODE_TYPES.audioUpload,
    data: { audioUrl, sourceFileName: fileName, ...displayName },
    size: AUDIO_IMPORT_SIZE,
  };
}

export async function prepareCanvasMediaImportBatch(
  paths: readonly string[],
  projectId: string | undefined,
  useFileNameAsNodeTitle: boolean,
  concurrency = DEFAULT_IMPORT_CONCURRENCY,
): Promise<CanvasMediaImportBatchResult> {
  const results: Array<PreparedCanvasMediaImport | CanvasMediaImportFailure | undefined> = new Array(paths.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), paths.length);

  const worker = async () => {
    while (nextIndex < paths.length) {
      const index = nextIndex;
      nextIndex += 1;
      const path = paths[index];
      try {
        results[index] = await prepareCanvasMediaImport(path, projectId, useFileNameAsNodeTitle);
      } catch (error) {
        results[index] = { path, error };
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));

  const items: PreparedCanvasMediaImport[] = [];
  const failures: CanvasMediaImportFailure[] = [];
  for (const result of results) {
    if (!result) continue;
    if ('type' in result) {
      items.push(result);
    } else {
      failures.push(result);
    }
  }
  return { items, failures };
}

export function layoutCanvasMediaImportNodes(
  items: readonly PreparedCanvasMediaImport[],
  origin: { x: number; y: number },
): CanvasMediaImportNodeInput[] {
  let x = origin.x;
  let y = origin.y;
  let rowHeight = 0;

  return items.map((item) => {
    if (x > origin.x && x + item.size.width - origin.x > CANVAS_MEDIA_IMPORT_ROW_WIDTH) {
      x = origin.x;
      y += rowHeight + CANVAS_MEDIA_IMPORT_GAP;
      rowHeight = 0;
    }

    const position = { x, y };
    x += item.size.width + CANVAS_MEDIA_IMPORT_GAP;
    rowHeight = Math.max(rowHeight, item.size.height);
    return {
      type: item.type,
      position,
      data: item.data,
      width: item.size.width,
      height: item.size.height,
    };
  });
}
