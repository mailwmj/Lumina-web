import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type SyntheticEvent,
} from 'react';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { Video } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import { type VideoUploadRefNodeData } from '@/features/canvas/domain/canvasNodes';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { resolveNodeSurfaceStateClass } from '@/features/canvas/ui/nodeSurfaceStyles';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { resolveVideoDisplayUrl } from '@/features/canvas/application/imageData';
import { useSettingsStore } from '@/stores/settingsStore';
import { convertVideoToMp4, persistMediaBytesToProject } from '@/commands/media';

type VideoUploadNodeProps = NodeProps & {
  id: string;
  data: VideoUploadRefNodeData;
  selected?: boolean;
  width?: number;
  height?: number;
};

const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 160;
const MIN_WIDTH = 180;
const MIN_HEIGHT = 120;
const MAX_WIDTH = 400;
const MAX_HEIGHT = 300;

function resolveDroppedVideoFile(event: DragEvent<HTMLElement>): File | null {
  const directFile = event.dataTransfer.files?.[0];
  if (directFile) {
    return directFile;
  }

  const item = Array.from(event.dataTransfer.items || []).find(
    (candidate) => candidate.kind === 'file' && candidate.type.startsWith('video/')
  );
  return item?.getAsFile() ?? null;
}

export const VideoUploadNode = memo(({ id, data, selected, width, height }: VideoUploadNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const useUploadFilenameAsNodeTitle = useSettingsStore((state) => state.useUploadFilenameAsNodeTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));

  const processFile = useCallback(
    async (file: File) => {
      const projectId = getCurrentProject()?.id;
      const filePath = (file as File & { path?: string }).path;
      const sourcePath = typeof filePath === 'string' && filePath.trim().length > 0
        ? filePath
        : URL.createObjectURL(file);
      const videoUrl = projectId && filePath
        ? await convertVideoToMp4(sourcePath, projectId)
        : projectId
          ? await persistMediaBytesToProject(new Uint8Array(await file.arrayBuffer()), file.name, projectId, 'videos')
          : sourcePath;
      const nextData: Partial<VideoUploadRefNodeData> = {
        videoUrl,
        sourceFileName: file.name,
      };
      if (useUploadFilenameAsNodeTitle) {
        nextData.displayName = file.name;
      }
      updateNodeData(id, nextData);
    },
    [getCurrentProject, id, updateNodeData, useUploadFilenameAsNodeTitle]
  );

  const handleVideoLoaded = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    // Generate thumbnail at first frame
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      setThumbnailUrl(canvas.toDataURL('image/jpeg', 0.8));
    }
  }, []);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragOver(false);
      const file = resolveDroppedVideoFile(event);
      if (!file || !file.type.startsWith('video/')) {
        return;
      }

      await processFile(file);
    },
    [processFile]
  );

  // Update node internals when dimensions change
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !file.type.startsWith('video/')) {
        return;
      }

      await processFile(file);
      event.target.value = '';
    },
    [processFile]
  );

  const handleNodeClick = useCallback(() => {
    setSelectedNode(id);
    if (!data.videoUrl) {
      inputRef.current?.click();
    }
  }, [data.videoUrl, id, setSelectedNode]);

  // Generate thumbnail when video URL changes
  useEffect(() => {
    if (data.videoUrl && !thumbnailUrl) {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.src = resolveVideoDisplayUrl(data.videoUrl);
      video.muted = true;
      video.onloadeddata = () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          setThumbnailUrl(canvas.toDataURL('image/jpeg', 0.8));
        }
      };
    }
  }, [data.videoUrl, thumbnailUrl]);

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/85 p-0 transition-colors duration-150
        ${resolveNodeSurfaceStateClass(selected)}
        ${isDragOver ? 'border-accent bg-accent/5' : ''}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={handleNodeClick}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {data.videoUrl ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-3 py-2">
          <div className="relative h-full w-full overflow-hidden rounded bg-bg-dark">
            <video
              src={resolveVideoDisplayUrl(data.videoUrl)}
              controls
              className="h-full w-full object-contain"
              playsInline
            />
            {/* 视频编号标签 */}
            <div className="absolute bottom-1 left-1 flex items-center justify-center">
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded bg-accent/90 px-1.5 text-xs font-medium text-[var(--accent-foreground)] shadow-sm">
                {t('node.videoUploadRef.videoIndex', { index: 1 })}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <label
          className="block h-full w-full overflow-hidden rounded-[var(--node-radius)] bg-bg-dark"
        >
          <div className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 text-text-muted/85">
            <Video className="h-7 w-7 opacity-60" />
            <span className="px-3 text-center text-[12px] leading-6">{t('node.videoUploadRef.hint')}</span>
          </div>
        </label>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={handleFileChange}
      />
      <video
        ref={videoRef}
        src={resolveVideoDisplayUrl(data.videoUrl || '')}
        className="hidden"
        onLoadedData={handleVideoLoaded}
        crossOrigin="anonymous"
      />

      <Handle
        type="source"
        id="source"
        position={Position.Right}
      />

      {/* 拖动改变大小 */}
      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
      />
    </div>
  );
});

VideoUploadNode.displayName = 'VideoUploadNode';
