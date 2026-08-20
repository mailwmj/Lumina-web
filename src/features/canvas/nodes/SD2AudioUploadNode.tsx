import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { Music, Play, Pause, Volume2 } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import { type AudioUploadRefNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveAudioDisplayUrl } from '@/features/canvas/application/imageData';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { resolveNodeSurfaceStateClass } from '@/features/canvas/ui/nodeSurfaceStyles';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { convertAudioToMp3, persistMediaBytesToProject } from '@/commands/media';

type AudioUploadNodeProps = NodeProps & {
  id: string;
  data: AudioUploadRefNodeData;
  selected?: boolean;
  width?: number;
  height?: number;
};

const DEFAULT_WIDTH = 200;
const DEFAULT_HEIGHT = 120;
const MIN_WIDTH = 160;
const MIN_HEIGHT = 100;
const MAX_WIDTH = 360;
const MAX_HEIGHT = 200;

function resolveDroppedAudioFile(event: DragEvent<HTMLElement>): File | null {
  const directFile = event.dataTransfer.files?.[0];
  if (directFile) {
    return directFile;
  }

  const item = Array.from(event.dataTransfer.items || []).find(
    (candidate) => candidate.kind === 'file' && candidate.type.startsWith('audio/')
  );
  return item?.getAsFile() ?? null;
}

export const AudioUploadNode = memo(({ id, data, selected, width, height }: AudioUploadNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const useUploadFilenameAsNodeTitle = useSettingsStore((state) => state.useUploadFilenameAsNodeTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));

  const processFile = useCallback(
    async (file: File) => {
      const projectId = getCurrentProject()?.id;
      const filePath = (file as File & { path?: string }).path;
      const sourcePath = typeof filePath === 'string' && filePath.trim().length > 0
        ? filePath
        : URL.createObjectURL(file);
      const audioUrl = projectId && filePath
        ? await convertAudioToMp3(sourcePath, projectId)
        : projectId
          ? await persistMediaBytesToProject(new Uint8Array(await file.arrayBuffer()), file.name, projectId, 'audios')
          : sourcePath;
      const nextData: Partial<AudioUploadRefNodeData> = {
        audioUrl,
        sourceFileName: file.name,
      };
      if (useUploadFilenameAsNodeTitle) {
        nextData.displayName = file.name;
      }
      updateNodeData(id, nextData);
    },
    [getCurrentProject, id, updateNodeData, useUploadFilenameAsNodeTitle]
  );

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragOver(false);
      const file = resolveDroppedAudioFile(event);
      if (!file || !file.type.startsWith('audio/')) {
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
      if (!file || !file.type.startsWith('audio/')) {
        return;
      }

      await processFile(file);
      event.target.value = '';
    },
    [processFile]
  );

  const handleNodeClick = useCallback(() => {
    setSelectedNode(id);
    if (!data.audioUrl) {
      inputRef.current?.click();
    }
  }, [data.audioUrl, id, setSelectedNode]);

  const togglePlayPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
    setIsPlaying(!isPlaying);
  }, [isPlaying]);

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      setCurrentTime(audio.currentTime);
    }
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      setDuration(audio.duration);
    }
  }, []);

  const handleAudioEnded = useCallback(() => {
    setIsPlaying(false);
    setCurrentTime(0);
  }, []);

  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    audio.currentTime = percent * duration;
    setCurrentTime(percent * duration);
  }, [duration]);

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
      {data.audioUrl ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-3 py-2">
          {/* Hidden native audio for playback */}
          <audio
            ref={audioRef}
            src={resolveAudioDisplayUrl(data.audioUrl)}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={handleAudioEnded}
            className="hidden"
          />
          {/* Custom dark-themed audio player */}
          <div className="flex w-full max-w-[180px] items-center gap-2 rounded-lg bg-bg-dark/80 px-2 py-1.5">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); togglePlayPause(); }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/80 text-[var(--accent-foreground)] transition-colors hover:bg-accent"
            >
              {isPlaying ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5 ml-0.5" />
              )}
            </button>
            <div className="flex flex-1 flex-col gap-0.5">
              {/* Progress bar */}
              <div
                className="h-1 w-full cursor-pointer rounded-full bg-text-muted/30"
                onClick={handleProgressClick}
              >
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }}
                />
              </div>
              {/* Time display */}
              <div className="flex justify-between text-[10px] text-text-muted">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>
            <Volume2 className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          </div>
          <span className="max-w-full truncate text-xs text-text-muted" title={data.sourceFileName}>
            {data.sourceFileName}
          </span>
          {/* 音频编号标签 */}
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded bg-accent/90 px-1.5 text-xs font-medium text-[var(--accent-foreground)] shadow-sm">
            {t('node.audioUploadRef.audioIndex', { index: 1 })}
          </span>
        </div>
      ) : (
        <label
          className="block h-full w-full overflow-hidden rounded-[var(--node-radius)] bg-bg-dark"
        >
          <div className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 text-text-muted/85">
            <Music className="h-7 w-7 opacity-60" />
            <span className="px-3 text-center text-[12px] leading-6">{t('node.audioUploadRef.hint')}</span>
          </div>
        </label>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleFileChange}
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

AudioUploadNode.displayName = 'AudioUploadNode';
