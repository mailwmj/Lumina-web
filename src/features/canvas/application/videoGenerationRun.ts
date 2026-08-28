import { resolveMediaReferences } from '@/features/assets/application/mediaDisplayResolver';
import {
  CANVAS_NODE_TYPES,
  isVideoGenNode,
  type CanvasNodeData,
  type VideoGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { CURRENT_RUNTIME_SESSION_ID } from '@/features/canvas/application/generationErrorReport';
import {
  assertGenerationSubmissionAllowed,
  estimateGenerationOutputBytes,
} from '@/features/canvas/application/generationSubmissionGuard';
import { selectWorkflowNodes } from '@/features/canvas/application/canvasNodeSelectors';
import { canvasAiGateway } from '@/features/canvas/application/canvasServices';
import {
  buildSeedanceVideoRequestPlan,
  type SeedanceVideoContent,
} from '@/features/canvas/application/seedanceVideoRequestPlan';
import {
  resolveSeedanceVideoGraphInputs,
  resolveSeedanceVideoGraphInputsWithText,
} from '@/features/canvas/application/seedanceVideoGraphInputs';
import { resolveVideoApiConfig } from '@/features/canvas/application/videoApiSelection';
import { createVideoOutputNode } from '@/features/canvas/application/videoOutput';
import { runtimeMediaDisplayResolver } from '@/runtime/mediaRuntime';
import { NetworkUnavailableError } from '@/runtime/networkAvailability';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';

export interface VideoGenerationNodeRunResult {
  sourceNodeId: string;
  resultNodeId: string;
  submissionStatus: 'submitted' | 'failed';
  jobId?: string;
  providerRequestId?: string;
  error?: string;
}

export interface VideoGenerationBatchRunResult {
  runs: Array<
    | ({ status: 'started' } & VideoGenerationNodeRunResult)
    | { status: 'failed'; sourceNodeId: string; error: string }
  >;
}

export type VideoGenerationRunErrorCode =
  | 'ALREADY_RUNNING'
  | 'NODE_NOT_FOUND'
  | 'API_CONFIG_REQUIRED'
  | 'API_DISABLED'
  | 'API_KEY_REQUIRED'
  | 'API_BASE_URL_REQUIRED'
  | 'INVALID_REQUEST'
  | 'MEDIA_UNAVAILABLE'
  | 'NETWORK_UNAVAILABLE'
  | 'CAPACITY_UNAVAILABLE'
  | 'RESULT_NODE_CREATION_FAILED';

export class VideoGenerationRunError extends Error {
  constructor(
    readonly code: VideoGenerationRunErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VideoGenerationRunError';
  }
}

interface RunVideoGenerationNodeOptions {
  assertCurrent?: (ownedResultNodeIds?: readonly string[]) => void;
  onSubmissionStarting?: () => void;
  fallbackResultTitle?: string;
}

class VideoGenerationAuthorizationError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'VideoGenerationAuthorizationError';
  }
}

const inFlightSourceNodeIds = new Set<string>();

function assertAuthorized(
  assertCurrent: RunVideoGenerationNodeOptions['assertCurrent'],
  ownedResultNodeIds?: readonly string[],
): void {
  try {
    assertCurrent?.(ownedResultNodeIds);
  } catch (error) {
    throw new VideoGenerationAuthorizationError(error);
  }
}

export async function runVideoGenerationNodes(
  nodeIds: string[],
  options: Pick<RunVideoGenerationNodeOptions, 'assertCurrent' | 'fallbackResultTitle'> = {},
): Promise<VideoGenerationBatchRunResult> {
  options.assertCurrent?.();
  let submissionStarted = false;
  const runs = await Promise.all([...new Set(nodeIds)].map(async (sourceNodeId) => {
    try {
      return {
        status: 'started' as const,
        ...await runVideoGenerationNode(sourceNodeId, {
          assertCurrent: options.assertCurrent,
          fallbackResultTitle: options.fallbackResultTitle,
          onSubmissionStarting: () => {
            submissionStarted = true;
          },
        }),
      };
    } catch (error) {
      if (error instanceof VideoGenerationAuthorizationError && !submissionStarted) {
        throw error.cause;
      }
      return {
        status: 'failed' as const,
        sourceNodeId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  return { runs };
}

export async function runVideoGenerationNode(
  sourceNodeId: string,
  options: RunVideoGenerationNodeOptions = {},
): Promise<VideoGenerationNodeRunResult> {
  if (inFlightSourceNodeIds.has(sourceNodeId)) {
    throw new VideoGenerationRunError(
      'ALREADY_RUNNING',
      `Video generation node ${sourceNodeId} is already being submitted.`,
    );
  }
  inFlightSourceNodeIds.add(sourceNodeId);
  let releaseMedia: () => void = () => undefined;

  try {
    assertAuthorized(options.assertCurrent);
    const canvas = useCanvasStore.getState();
    const sourceNode = canvas.nodes.find((node) => node.id === sourceNodeId);
    if (!sourceNode || !isVideoGenNode(sourceNode)) {
      throw new VideoGenerationRunError(
        'NODE_NOT_FOUND',
        `Video generation node not found: ${sourceNodeId}`,
      );
    }

    const data = sourceNode.data as VideoGenNodeData;
    const videoApi = resolveVideoApiConfig(
      useSettingsStore.getState().videoApis,
      data.videoApiId,
      data.model,
    );
    if (!videoApi) {
      throw new VideoGenerationRunError('API_CONFIG_REQUIRED', 'No configured video API is available.');
    }
    if (!videoApi.enabled) {
      throw new VideoGenerationRunError('API_DISABLED', 'The selected video API is disabled.');
    }
    const apiKey = videoApi.apiKey.trim();
    if (!apiKey) {
      throw new VideoGenerationRunError('API_KEY_REQUIRED', 'The selected video API has no API key.');
    }
    const baseUrl = videoApi.baseUrl.trim();
    if (!baseUrl) {
      throw new VideoGenerationRunError('API_BASE_URL_REQUIRED', 'The selected video API has no base URL.');
    }

    const workflowNodes = selectWorkflowNodes(canvas);
    const graphInputs = resolveSeedanceVideoGraphInputs(sourceNodeId, workflowNodes, canvas.edges);
    const orderedInputs = resolveSeedanceVideoGraphInputsWithText(
      sourceNodeId,
      workflowNodes,
      canvas.edges,
    );
    const resolvedMedia = await resolveMediaReferences(
      runtimeMediaDisplayResolver,
      graphInputs.map((input) => ({
        kind: input.type,
        assetId: input.assetId,
        legacyUrl: input.url,
      })),
    );
    releaseMedia = resolvedMedia.release;
    if (resolvedMedia.urls.some((url) => !url)) {
      throw new VideoGenerationRunError(
        'MEDIA_UNAVAILABLE',
        'One or more video references could not be resolved.',
      );
    }

    const selectedModel = videoApi.modelId.trim() || data.model.trim();
    const selectedResolution = data.resolution ?? '720p';
    const selectedDuration = data.duration ?? 5;
    let orderedMediaIndex = 0;
    const requestPlan = buildSeedanceVideoRequestPlan({
      kind: sourceNode.type === CANVAS_NODE_TYPES.videoFrame || data.inputMode === 'first-last'
        ? 'strict-frame'
        : 'automatic',
      model: selectedModel,
      prompt: data.prompt ?? '',
      localPrompt: data.prompt ?? '',
      resolution: selectedResolution,
      duration: selectedDuration,
      media: graphInputs.map((input, index) => ({
        ...input,
        url: resolvedMedia.urls[index],
      })),
      inputs: orderedInputs.map((input) => input.type === 'text'
        ? input
        : { ...input, url: resolvedMedia.urls[orderedMediaIndex++] }),
    });
    if (!requestPlan.ok) {
      throw new VideoGenerationRunError(
        'INVALID_REQUEST',
        requestPlan.error.code,
      );
    }
    const prompt = requestPlan.plan.content
      .filter((content): content is Extract<SeedanceVideoContent, { type: 'text' }> => (
        content.type === 'text'
      ))
      .map((content) => content.text)
      .join('\n\n');

    try {
      await assertGenerationSubmissionAllowed({
        estimatedOutputBytes: estimateGenerationOutputBytes(selectedResolution),
      });
    } catch (error) {
      if (error instanceof NetworkUnavailableError) {
        throw new VideoGenerationRunError('NETWORK_UNAVAILABLE', error.message);
      }
      throw new VideoGenerationRunError(
        'CAPACITY_UNAVAILABLE',
        error instanceof Error ? error.message : 'Browser storage capacity is unavailable.',
      );
    }

    assertAuthorized(options.assertCurrent);
    if (data.videoApiId !== videoApi.id || data.model !== selectedModel) {
      useCanvasStore.getState().updateNodeData(sourceNodeId, {
        videoApiId: videoApi.id,
        model: selectedModel,
      });
    }

    const generationStartedAt = Date.now();
    const generateAudio = data.generateAudio ?? data.hasAudio ?? true;
    const watermark = data.watermark ?? false;
    const latestCanvas = useCanvasStore.getState();
    const resultNodeId = createVideoOutputNode({
      sourceNodeId,
      existingNodes: latestCanvas.nodes,
      existingEdges: latestCanvas.edges,
      addNodeBatch: latestCanvas.addNodeBatch,
      addEdge: latestCanvas.addEdge,
      data: {
        isGenerating: true,
        generationStartedAt,
        generationDurationMs: 120_000,
        displayName: options.fallbackResultTitle ?? (data.displayName || 'AI video result'),
        aspectRatio: data.aspectRatio || '16:9',
        model: selectedModel,
        videoApiId: videoApi.id,
        resolution: selectedResolution,
        duration: selectedDuration,
        hasAudio: generateAudio,
        generateAudio,
        ...(typeof data.returnLastFrame === 'boolean'
          ? { returnLastFrame: data.returnLastFrame }
          : {}),
        ...(typeof data.draft === 'boolean' ? { draft: data.draft } : {}),
        ...(typeof data.enableWebSearch === 'boolean'
          ? { enableWebSearch: data.enableWebSearch }
          : {}),
        watermark,
        ...(typeof data.camerafixed === 'boolean' ? { camerafixed: data.camerafixed } : {}),
        seed: data.seed,
        generationProviderCancellationConfirmed: null,
        prompt,
      },
    });
    if (!resultNodeId) {
      throw new VideoGenerationRunError(
        'RESULT_NODE_CREATION_FAILED',
        'The video result node could not be created.',
      );
    }
    assertAuthorized(options.assertCurrent, [resultNodeId]);

    const extraParams = {
      ...(data.extraParams ?? {}),
      duration: selectedDuration,
      hasaudio: generateAudio,
      generateAudio,
      watermark,
      ...(typeof data.returnLastFrame === 'boolean'
        ? { returnLastFrame: data.returnLastFrame }
        : {}),
      ...(typeof data.draft === 'boolean' ? { draft: data.draft } : {}),
      ...(typeof data.enableWebSearch === 'boolean'
        ? { enableWebSearch: data.enableWebSearch }
        : {}),
      ...(typeof data.seed === 'number' ? { seed: data.seed } : {}),
      ...(typeof data.camerafixed === 'boolean'
        ? { camerafixed: data.camerafixed, cameraFixed: data.camerafixed }
        : {}),
    };

    assertAuthorized(options.assertCurrent, [resultNodeId]);
    options.onSubmissionStarting?.();
    try {
      const project = useProjectStore.getState().getCurrentProject();
      const receipt = await canvasAiGateway.submitGenerateVideoJob({
        prompt,
        model: selectedModel,
        providerId: 'volcvideo',
        size: selectedResolution,
        aspectRatio: data.aspectRatio || '16:9',
        videoContent: requestPlan.plan.content,
        extraParams,
        providerConfig: {
          api_key: apiKey,
          base_url: baseUrl,
          config_id: videoApi.id,
          protocol: videoApi.protocol ?? 'volcengine-seedance',
        },
        projectId: project?.id,
        projectRevision: project ? String(project.updatedAt) : undefined,
      });
      assertAuthorized(options.assertCurrent, [resultNodeId]);
      useCanvasStore.getState().updateNodeData(resultNodeId, {
        generationJobId: receipt.jobId,
        generationProviderId: 'volcvideo',
        generationTaskHandle: receipt.taskHandle ?? null,
        generationProviderRequestId: receipt.requestId ?? null,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
      });
      return {
        sourceNodeId,
        resultNodeId,
        submissionStatus: 'submitted',
        jobId: receipt.jobId,
        ...(receipt.requestId ? { providerRequestId: receipt.requestId } : {}),
      };
    } catch (error) {
      if (error instanceof VideoGenerationAuthorizationError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      useCanvasStore.getState().updateNodeData(resultNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationJobId: null,
        generationTaskHandle: null,
        generationProviderRequestId: null,
        generationError: message,
      } as Partial<CanvasNodeData>);
      return {
        sourceNodeId,
        resultNodeId,
        submissionStatus: 'failed',
        error: message,
      };
    }
  } finally {
    releaseMedia();
    inFlightSourceNodeIds.delete(sourceNodeId);
  }
}
