import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { AlertTriangle, Copy, Video, Check, ChevronDown, ChevronUp, RefreshCw, X } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import {
  VIDEO_RESULT_NODE_MIN_HEIGHT,
  VIDEO_RESULT_NODE_MIN_WIDTH,
  type ExportVideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveResizeMinConstraintsByAspect,
} from '@/features/canvas/application/imageNodeSizing';
import {
  createVideoOutputNode,
  resolveVideoResultNodeSize,
} from '@/features/canvas/application/videoOutput';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { resolveNodeSurfaceStateClass } from '@/features/canvas/ui/nodeSurfaceStyles';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { submitGenerateImageJob } from '@/commands/ai';
import { resolveVideoDisplayUrl } from '@/features/canvas/application/imageData';
import { resolveVideoApiConfig } from '@/features/canvas/application/videoApiSelection';
import { logger } from '@/lib/logger';
import { UiButton, UiTooltip } from '@/components/ui';

type VideoResultNodeProps = NodeProps & {
  id: string;
  data: ExportVideoNodeData;
  selected?: boolean;
};

export const VideoResultNode = memo(({ id, data, selected, width, height }: VideoResultNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeDataWithoutHistory = useCanvasStore(
    (state) => state.updateNodeDataWithoutHistory
  );
  const addNodeBatch = useCanvasStore((state) => state.addNodeBatch);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const [now, setNow] = useState(() => Date.now());
  const [isCopySuccess, setIsCopySuccess] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const isGenerating = typeof data.isGenerating === 'boolean' ? data.isGenerating : false;
  const generationError =
    typeof data.generationError === 'string'
      ? (data.generationError ?? '').trim()
      : '';
  const hasGenerationError = isGenerating === false && !data.videoUrl && generationError.length > 0;
  const generationRecoveryState =
    data.generationRecoveryState === 'retrying'
    || data.generationRecoveryState === 'attention_required'
    || data.generationRecoveryState === 'retry_requested'
      ? data.generationRecoveryState
      : null;
  const generationRetryError =
    typeof data.generationRetryError === 'string' ? data.generationRetryError.trim() : '';
  const requiresManualRequery =
    isGenerating && generationRecoveryState === 'attention_required';

  const handleCopyError = useCallback(async () => {
    if (!generationError) return;
    setIsCopySuccess(true);
    try {
      await navigator.clipboard.writeText(generationError);
    } catch (error) {
      logger.error('Failed to copy error to clipboard', error);
    }
    setTimeout(() => setIsCopySuccess(false), 1100);
  }, [generationError]);

  const handleCopyVideoUrl = useCallback(async () => {
    if (!data.videoUrl) return;
    setIsCopySuccess(true);
    try {
      await navigator.clipboard.writeText(data.videoUrl);
    } catch (error) {
      logger.error('Failed to copy video URL to clipboard', error);
    }
    setTimeout(() => setIsCopySuccess(false), 1100);
  }, [data.videoUrl]);

  const handleCopyPrompt = useCallback(async () => {
    if (!data.prompt) return;
    setIsCopySuccess(true);
    try {
      await navigator.clipboard.writeText(data.prompt);
    } catch (error) {
      logger.error('Failed to copy prompt to clipboard', error);
    }
    setTimeout(() => setIsCopySuccess(false), 1100);
  }, [data.prompt]);

  // Handle "Generate Final" button for draft videos
  const handleGenerateFinal = useCallback(async () => {
    const log = (msg: string) => {
      logger.info('[VideoResult] ' + msg);
    };

    log('handleGenerateFinal called. draftTaskId=' + data.draftTaskId + ', model=' + data.model);

    if (!data.draftTaskId || !data.model) {
      log('ERROR: missing draftTaskId or model. draftTaskId=' + data.draftTaskId + ', model=' + data.model);
      return;
    }

    // Find API key for volcvideo
    const videoApis = useSettingsStore.getState().videoApis;
    log('videoApis.length=' + videoApis.length + ', resolving configuration for model=' + data.model);
    const apiConfig = resolveVideoApiConfig(videoApis, data.videoApiId, data.model);
    log('apiConfig found: ' + (apiConfig ? 'modelId=' + apiConfig.modelId + ', hasKey=' + !!apiConfig.apiKey : 'null'));
    if (!apiConfig) {
      log('ERROR: Selected video API configuration is unavailable');
      updateNodeData(id, { generationError: t('node.videoGen.apiRequired') });
      return;
    }
    if (!apiConfig.enabled) {
      log('ERROR: Selected video API configuration is disabled');
      updateNodeData(id, { generationError: t('node.videoGen.apiDisabled') });
      return;
    }
    const apiKey = apiConfig.apiKey.trim();
    if (!apiKey || !apiConfig.baseUrl.trim()) {
      log('ERROR: No API key found for final generation');
      updateNodeData(id, { generationError: t('node.videoGen.apiKeyRequired') });
      return;
    }

    const currentCanvas = useCanvasStore.getState();
    const newNodeId = createVideoOutputNode({
      sourceNodeId: id,
      existingNodes: currentCanvas.nodes,
      existingEdges: currentCanvas.edges,
      addNodeBatch,
      addEdge,
      data: {
        isGenerating: true,
        generationStartedAt: Date.now(),
        generationDurationMs: 120000,
        generationJobId: '',
        generationProviderId: 'volcvideo',
        videoApiId: apiConfig.id,
        displayName: t('node.videoGen.title'),
        aspectRatio: data.aspectRatio || '16:9',
        model: data.model,
        resolution: '720p',
        duration: data.duration || 5,
        hasAudio: data.hasAudio ?? true,
        seed: -1,
        prompt: '',
      },
    });
    if (!newNodeId) {
      log('ERROR: unable to create export video node');
      return;
    }
    log('Created exportVideo node, newNodeId=' + newNodeId);

    // Step 2: Submit API
    try {
      log('Submitting job with draftTaskId=' + data.draftTaskId);
      const jobId = await submitGenerateImageJob({
        prompt: '.',
        model: data.model,
        provider_id: 'volcvideo',
        size: data.resolution || '720p',
        aspect_ratio: data.aspectRatio || '16:9',
        reference_images: [],
        provider_config: {
          api_key: apiKey,
          base_url: apiConfig.baseUrl.trim(),
          config_id: apiConfig.id,
          protocol: apiConfig.protocol ?? 'volcengine-seedance',
        },
        draftTaskId: data.draftTaskId,
      });
      log('Job submitted successfully. jobId=' + jobId);

      // Step 3: Update node with jobId - Canvas polling will pick it up
      updateNodeData(newNodeId, {
        generationJobId: jobId,
      });
    } catch (err) {
      log('ERROR: Failed to submit final generation: ' + (err instanceof Error ? err.message : String(err)));
      const msg = err instanceof Error ? err.message : String(err);
      // 解析 API 错误信息，提取用户友好的消息
      let userMsg = msg;
      try {
        // 尝试从 "Provider error: VolcVideo submit failed [400 Bad Request]: {...}" 中提取 JSON
        const jsonMatch = msg.match(/\{[^{}]*"message"[^}]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.message) {
            // 将英文错误消息转换为中文
            const engMsg = parsed.message;
            if (engMsg.includes('ratio') && engMsg.includes('draft_task')) {
              userMsg = 'Draft 视频不支持自定义比例，请留空';
            } else if (engMsg.includes('resolution') && engMsg.includes('draft_task')) {
              userMsg = 'Draft 视频不支持自定义分辨率，请留空';
            } else if (engMsg.includes('text content must contain a prompt')) {
              userMsg = '请输入视频描述文字';
            } else {
              userMsg = engMsg;
            }
          }
        }
      } catch (e) {
        // 解析失败，使用原始消息
      }
      // Show error on the new node that was created
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationError: userMsg,
        generationJobId: null,
      });
    }
  }, [id, data.draftTaskId, data.model, data.aspectRatio, data.resolution, data.duration, data.hasAudio, addNodeBatch, addEdge, updateNodeData, t]);

  const generationStartedAt =
    typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const generationDurationMs =
    typeof data.generationDurationMs === 'number' ? data.generationDurationMs : 120000;

  const resizeConstraints = resolveResizeMinConstraintsByAspect(data.aspectRatio || '16:9', {
    minWidth: VIDEO_RESULT_NODE_MIN_WIDTH,
    minHeight: VIDEO_RESULT_NODE_MIN_HEIGHT,
  });
  const resizeMinWidth = resizeConstraints.minWidth;
  const resizeMinHeight = resizeConstraints.minHeight;
  const fittedSize = resolveVideoResultNodeSize(data.aspectRatio || '16:9');
  const resolvedWidth = typeof width === 'number' && Number.isFinite(width) && width > 1
    ? Math.round(width)
    : fittedSize.width;
  const resolvedHeight = typeof height === 'number' && Number.isFinite(height) && height > 1
    ? Math.round(height)
    : fittedSize.height;
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, updateNodeInternals, resolvedWidth, resolvedHeight]);

  useEffect(() => {
    if (!isGenerating) {
      return;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 120);

    return () => {
      window.clearInterval(timer);
    };
  }, [isGenerating]);

  const simulatedProgress = useMemo(() => {
    if (!isGenerating) {
      return 0;
    }

    const startedAt = generationStartedAt ?? Date.now();
    const duration = Math.max(1000, generationDurationMs);
    const elapsed = Math.max(0, now - startedAt);

    return Math.min(elapsed / duration, 0.96);
  }, [generationDurationMs, generationStartedAt, isGenerating, now]);

  const waitedMinutes = useMemo(() => {
    if (!isGenerating || generationStartedAt === null) {
      return 0;
    }

    const elapsed = Math.max(0, now - generationStartedAt);
    return Math.floor(elapsed / 60000);
  }, [generationStartedAt, isGenerating, now]);

  const waitingResultText = useMemo(() => {
    if (generationRecoveryState === 'retrying' || generationRecoveryState === 'retry_requested') {
      return t('node.videoGen.recoveringResult');
    }
    if (!isGenerating || waitedMinutes < 2) {
      return t('node.videoGen.generating');
    }
    return t('node.videoGen.generating') + ` (${waitedMinutes}m)`;
  }, [generationRecoveryState, isGenerating, waitedMinutes, t]);

  // Check if there's any generation info to show
  const hasGenerationInfo = !!(data.prompt || data.model || data.seed !== undefined || data.resolution || data.duration);

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-0 transition-colors duration-150
        ${hasGenerationError
          ? (selected
            ? 'border-red-400 shadow-[0_0_0_1px_rgba(248,113,113,0.42)]'
            : 'border-red-500/70 bg-[rgba(127,29,29,0.12)] hover:border-red-400/80 dark:border-red-500/70 dark:hover:border-red-400/80')
          : requiresManualRequery
            ? (selected
              ? 'border-amber-400 shadow-[0_0_0_1px_rgba(251,191,36,0.34)]'
              : 'border-amber-500/65 bg-[rgba(120,83,13,0.12)] hover:border-amber-400/80')
          : resolveNodeSurfaceStateClass(selected)}
      `}
      style={{ width: `${resolvedWidth}px`, height: `${resolvedHeight}px` }}
      onClick={() => setSelectedNode(id)}
    >
      {/* Details toggle button - positioned at top right of video area */}
      {hasGenerationInfo && data.videoUrl && !isGenerating && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowDetails(!showDetails);
          }}
          className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded bg-black/60 px-2 py-1 text-xs text-white/80 hover:bg-black/80"
        >
          {showDetails ? (
            <>
              <ChevronUp className="h-3 w-3" />
              <span>{t('common.hideDetails')}</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              <span>{t('common.details')}</span>
            </>
          )}
        </button>
      )}

      <div
        className={`group relative w-full overflow-hidden rounded-[var(--node-radius)] ${hasGenerationError ? 'bg-[rgba(127,29,29,0.2)]' : 'bg-bg-dark'}`}
        style={{ height: data.draftTaskId && data.videoUrl && !isGenerating ? 'calc(100% - 36px)' : '100%' }}
      >
        {data.videoUrl ? (
          <video
            src={resolveVideoDisplayUrl(data.videoUrl)}
            controls
            className="h-full w-full object-contain"
            playsInline
          />
        ) : hasGenerationError ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-red-300">
            <AlertTriangle className="h-7 w-7 opacity-90" />
            <span className="text-center text-[12px] font-medium leading-5 text-red-200">
              {t('node.videoGen.generationFailed')}
            </span>
            <div className="relative max-h-[68px] w-full overflow-y-auto">
              <span className="block break-words text-center text-[11px] leading-5 text-red-200/90">
                {generationError}
              </span>
              <UiTooltip content={isCopySuccess ? t('common.copied') : t('common.copy')}>
                <button
                  type="button"
                  aria-label={isCopySuccess ? t('common.copied') : t('common.copy')}
                  onClick={handleCopyError}
                  className="absolute right-1 top-1 rounded bg-red-900/50 p-1 opacity-0 transition-opacity hover:bg-red-900 group-hover:opacity-100"
                >
                  {isCopySuccess ? (
                    <Check className="h-3 w-3 text-green-400" />
                  ) : (
                    <Copy className="h-3 w-3 text-red-300" />
                  )}
                </button>
              </UiTooltip>
            </div>
          </div>
        ) : requiresManualRequery ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-amber-200">
            <AlertTriangle className="h-7 w-7 opacity-90" />
            <span className="text-center text-[12px] font-medium leading-5">
              {t('node.videoGen.requeryRequired')}
            </span>
            {generationRetryError && (
              <span className="max-h-[44px] overflow-y-auto break-words text-center text-[11px] leading-4 text-amber-100/80">
                {generationRetryError}
              </span>
            )}
            <UiButton
              type="button"
              size="sm"
              variant="muted"
              className="nodrag nowheel z-10 gap-1.5 border-amber-300/30 bg-amber-200/10 text-amber-100 hover:bg-amber-200/20"
              onClick={(event) => {
                event.stopPropagation();
                updateNodeDataWithoutHistory(id, {
                  generationRecoveryState: 'retry_requested',
                  generationNextRetryAt: null,
                  generationRetryError: null,
                });
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('node.videoGen.requeryTask')}
            </UiButton>
            <span className="text-center text-[10px] leading-4 text-amber-100/65">
              {t('node.videoGen.requeryTaskHint')}
            </span>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-muted/85">
            <Video className="h-7 w-7 opacity-60" />
            <span className="px-4 text-center text-[12px] leading-6">
              {waitingResultText}
            </span>
          </div>
        )}

        {isGenerating && !requiresManualRequery && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute inset-0 bg-bg-dark/55" />
            <div
              className="absolute left-0 top-0 h-full bg-gradient-to-r from-[rgba(255,255,255,0.4)] to-[rgba(255,255,255,0.06)] transition-[width] duration-100 ease-linear"
              style={{ width: `${simulatedProgress * 100}%` }}
            />
          </div>
        )}

        </div>

      {/* Generate Final button for draft videos - positioned at bottom right of node, outside video area */}
      {data.draftTaskId && data.videoUrl && !isGenerating && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleGenerateFinal();
          }}
          className="pointer-events-auto absolute right-2 bottom-2 z-30 flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs font-medium text-[var(--accent-foreground)] shadow hover:bg-accent/90"
        >
          <Video className="h-3 w-3" />
          <span>{t('node.videoGen.generateFinalVideo')}</span>
        </button>
      )}

      {/* Generation details panel - positioned below the node, outside video area */}
      {showDetails && hasGenerationInfo && data.videoUrl && !isGenerating && (
        <div
          className="absolute left-0 top-full z-30 max-h-[300px] w-full overflow-y-auto border border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)] p-3 shadow-[var(--ui-shadow-panel)]"
          style={{ borderRadius: '0 0 var(--node-radius) var(--node-radius)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-text-muted/80">{t('node.videoGen.detailsParams')}</span>
            <UiTooltip content={t('common.close')}>
              <button
                type="button"
                aria-label={t('common.close')}
                onClick={() => setShowDetails(false)}
                className="rounded p-1 text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark"
              >
                <X className="h-3 w-3" />
              </button>
            </UiTooltip>
          </div>
          <div className="space-y-2 text-xs">
            {/* Model info */}
            {data.model && (
              <div className="flex items-center gap-2">
                <span className="text-text-muted/60">{t('node.videoGen.detailsModel')}:</span>
                <span className="font-mono text-text-dark">{data.model}</span>
              </div>
            )}

            {/* Params */}
            <div className="flex flex-wrap items-center gap-2">
              {data.resolution && (
                <span className="rounded bg-[var(--ui-hover)] px-1.5 py-0.5 font-mono text-text-dark">
                  {data.resolution}
                </span>
              )}
              {data.duration && (
                <span className="rounded bg-[var(--ui-hover)] px-1.5 py-0.5 font-mono text-text-dark">
                  {data.duration}s
                </span>
              )}
              {data.seed !== undefined && (
                <span className="rounded bg-[var(--ui-hover)] px-1.5 py-0.5 font-mono text-text-dark">
                  {t('node.videoGen.seed')}: {data.seed === -1 ? t('node.videoGen.detailsSeedRandom') : data.seed}
                </span>
              )}
              {data.hasAudio !== undefined && (
                <span className="rounded bg-[var(--ui-hover)] px-1.5 py-0.5 text-text-dark">
                  {data.hasAudio ? t('node.videoGen.detailsAudioOn') : t('node.videoGen.detailsAudioOff')}
                </span>
              )}
            </div>

            {/* Prompt */}
            {data.prompt && (
              <div className="mt-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-text-muted/60">{t('node.videoGen.detailsPrompt')}:</span>
                  <UiTooltip content={isCopySuccess ? t('common.copied') : t('common.copy')}>
                    <button
                      type="button"
                      aria-label={isCopySuccess ? t('common.copied') : t('common.copy')}
                      onClick={handleCopyPrompt}
                      className="rounded p-1 text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark"
                    >
                      {isCopySuccess ? (
                        <Check className="h-3 w-3 text-green-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </UiTooltip>
                </div>
                <p className="whitespace-pre-wrap break-words leading-4 text-text-dark">
                  {data.prompt}
                </p>
              </div>
            )}

            {/* Video URL */}
            {data.videoUrl && (
              <div className="mt-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-text-muted/60">{t('node.videoGen.detailsVideoUrl')}:</span>
                  <div className="flex items-center gap-1">
                    <UiTooltip content={isCopySuccess ? t('common.copied') : t('common.copy')}>
                      <button
                        type="button"
                        aria-label={isCopySuccess ? t('common.copied') : t('common.copy')}
                        onClick={handleCopyVideoUrl}
                        className="rounded p-1 text-text-muted hover:bg-[var(--ui-hover)] hover:text-text-dark"
                      >
                        {isCopySuccess ? (
                          <Check className="h-3 w-3 text-green-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </UiTooltip>
                  </div>
                </div>
                <p className="truncate font-mono text-accent/80">{data.videoUrl}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <Handle
        type="target"
        id="target"
        position={Position.Left}
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
      />
      <NodeResizeHandle
        minWidth={resizeMinWidth}
        minHeight={resizeMinHeight}
        maxWidth={1600}
        maxHeight={1600}
      />
    </div>
  );
});

VideoResultNode.displayName = 'VideoResultNode';
