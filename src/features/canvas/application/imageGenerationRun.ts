import {
  AUTO_REQUEST_ASPECT_RATIO,
  DEFAULT_IMAGE_OUTPUT_COUNT,
  isImageEditNode,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  buildImageReferenceModelPrompt,
  materializeImageReferencePrompt,
} from '@/features/canvas/application/imageReferencePrompt';
import {
  resolveEffectivePromptForNode,
  resolveTextGenerationInputs,
} from '@/features/canvas/application/textGenerationInputs';
import { detectAspectRatio, parseAspectRatio } from '@/features/canvas/application/imageData';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
  createReferenceImagePlaceholders,
  getRuntimeDiagnostics,
  type GenerationDebugContext,
} from '@/features/canvas/application/generationErrorReport';
import {
  createImageOutputBatchNodes,
  markImageOutputNodeFailed,
} from '@/features/canvas/application/imageOutputBatch';
import {
  getModelProvider,
  pickClosestImageGenerationAspectRatio,
  resolveConfiguredImageModel,
  resolveImageGenerationResolution,
} from '@/features/canvas/models';
import { resolveImageProviderRuntime } from '@/features/canvas/application/imageProviderRuntime';
import { canvasAiGateway } from '@/features/canvas/application/canvasServices';
import { selectWorkflowNodes } from '@/features/canvas/application/canvasNodeSelectors';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';

export interface ImageGenerationSubmissionResult {
  resultNodeId: string;
  outputIndex: number;
  status: 'submitted' | 'failed';
  jobId?: string;
  errorMessage?: string;
  errorDetails?: string;
  errorReport?: string;
}

export interface ImageGenerationNodeRunResult {
  sourceNodeId: string;
  resultNodeIds: string[];
  submissions: ImageGenerationSubmissionResult[];
}

export interface ImageGenerationBatchRunResult {
  runs: Array<
    | ({ status: 'started' } & ImageGenerationNodeRunResult)
    | { status: 'failed'; sourceNodeId: string; error: string }
  >;
}

export type ImageGenerationRunErrorCode =
  | 'ALREADY_RUNNING'
  | 'NODE_NOT_FOUND'
  | 'MODEL_REQUIRED'
  | 'REFERENCE_IMAGES_UNAVAILABLE'
  | 'PROMPT_REQUIRED'
  | 'API_KEY_REQUIRED';

export class ImageGenerationRunError extends Error {
  constructor(
    readonly code: ImageGenerationRunErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ImageGenerationRunError';
  }
}

interface RunImageGenerationNodeOptions {
  fallbackResultTitle?: string;
  fallbackErrorMessage?: string;
  diagnostics?: ReturnType<typeof getRuntimeDiagnostics>;
  providerSetup?: Map<string, Promise<void>>;
  assertCurrent?: (ownedResultNodeIds?: readonly string[]) => void;
  onSubmissionStarting?: () => void;
}

const inFlightSourceNodeIds = new Set<string>();

class ImageGenerationAuthorizationError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ImageGenerationAuthorizationError';
  }
}

function assertAuthorized(
  assertCurrent: RunImageGenerationNodeOptions['assertCurrent'],
  ownedResultNodeIds?: readonly string[]
): void {
  try {
    assertCurrent?.(ownedResultNodeIds);
  } catch (error) {
    throw new ImageGenerationAuthorizationError(error);
  }
}

export async function runImageGenerationNodes(
  nodeIds: string[],
  options: Pick<RunImageGenerationNodeOptions, 'assertCurrent'> = {}
): Promise<ImageGenerationBatchRunResult> {
  options.assertCurrent?.();
  const uniqueNodeIds = [...new Set(nodeIds)];
  const diagnostics = getRuntimeDiagnostics();
  const providerSetup = new Map<string, Promise<void>>();
  let submissionStarted = false;
  const runs = await Promise.all(uniqueNodeIds.map(async (sourceNodeId) => {
    try {
      return {
        status: 'started' as const,
        ...await runImageGenerationNode(sourceNodeId, {
          diagnostics,
          providerSetup,
          assertCurrent: options.assertCurrent,
          onSubmissionStarting: () => {
            submissionStarted = true;
          },
        }),
      };
    } catch (error) {
      if (error instanceof ImageGenerationAuthorizationError) {
        if (!submissionStarted) {
          throw error.cause;
        }
        return {
          status: 'failed' as const,
          sourceNodeId,
          error: error.message,
        };
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

export async function runImageGenerationNode(
  sourceNodeId: string,
  options: RunImageGenerationNodeOptions = {}
): Promise<ImageGenerationNodeRunResult> {
  if (inFlightSourceNodeIds.has(sourceNodeId)) {
    throw new ImageGenerationRunError(
      'ALREADY_RUNNING',
      `Image generation node ${sourceNodeId} is already being submitted.`
    );
  }
  inFlightSourceNodeIds.add(sourceNodeId);

  try {
    assertAuthorized(options.assertCurrent);
    const canvas = useCanvasStore.getState();
    const sourceNode = canvas.nodes.find((node) => node.id === sourceNodeId);
    if (!sourceNode || !isImageEditNode(sourceNode)) {
      throw new ImageGenerationRunError(
        'NODE_NOT_FOUND',
        `Image generation node not found: ${sourceNodeId}`
      );
    }

    const settings = useSettingsStore.getState();
    const configuredModel = resolveConfiguredImageModel({
      openAiImageApi: settings.openAiImageApi,
      chaomoImageApi: settings.chaomoImageApi,
      customImageApis: settings.customImageApis,
      lastImageModelSelection: settings.lastImageModelSelection,
    }, sourceNode.data.model);
    if (!configuredModel) {
      throw new ImageGenerationRunError(
        'MODEL_REQUIRED',
        'No configured image model is available.'
      );
    }

    const workflowNodes = selectWorkflowNodes(canvas);
    const workflowInputs = resolveTextGenerationInputs(sourceNodeId, workflowNodes, canvas.edges);
    if (workflowInputs.blockingImageNodeIds.length > 0) {
      throw new ImageGenerationRunError(
        'REFERENCE_IMAGES_UNAVAILABLE',
        `Reference images are unavailable: ${workflowInputs.blockingImageNodeIds.join(', ')}`
      );
    }
    const referenceImageSnapshot = workflowInputs.imageInputs.flatMap((input) => input.imageUrl
      ? [{ edgeId: input.edgeId, imageUrl: input.imageUrl, previewImageUrl: input.previewImageUrl }]
      : []
    );
    const referenceImages = referenceImageSnapshot.map((input) => input.imageUrl);
    const localPrompt = materializeImageReferencePrompt(
      sourceNode.data.prompt ?? '',
      referenceImageSnapshot
    ).trim();
    const userPrompt = resolveEffectivePromptForNode(
      sourceNodeId,
      localPrompt,
      workflowNodes,
      canvas.edges
    );
    if (!userPrompt.trim()) {
      throw new ImageGenerationRunError('PROMPT_REQUIRED', 'The image generation prompt is empty.');
    }
    const prompt = buildImageReferenceModelPrompt(userPrompt, referenceImageSnapshot);

    const providerRuntime = resolveImageProviderRuntime(configuredModel.providerId, {
      openAiImageApi: settings.openAiImageApi,
      chaomoImageApi: settings.chaomoImageApi,
      customImageApis: settings.customImageApis,
    });
    if (!providerRuntime.apiKey) {
      throw new ImageGenerationRunError(
        'API_KEY_REQUIRED',
        `The image provider ${configuredModel.providerId} has no API key.`
      );
    }

    const selectedResolution = resolveImageGenerationResolution(sourceNode.data.size);
    const requestResolution = configuredModel.resolveRequest({
      referenceImageCount: referenceImages.length,
    });
    const outputCount = sourceNode.data.outputCount ?? DEFAULT_IMAGE_OUTPUT_COUNT;
    const effectiveExtraParams = { ...(sourceNode.data.extraParams ?? {}) };
    const resolvedRequestAspectRatio = await resolveRequestAspectRatio(
      sourceNode.data.requestAspectRatio,
      referenceImages
    );
    const generationStartedAt = Date.now();
    const generationDurationMs = configuredModel.expectedDurationMs ?? 60_000;
    const diagnostics = await (options.diagnostics ?? getRuntimeDiagnostics());
    assertAuthorized(options.assertCurrent);

    const buildDebugContext = (outputIndex: number): GenerationDebugContext => ({
      sourceType: 'imageEdit',
      providerId: configuredModel.providerId,
      requestModel: requestResolution.requestModel,
      requestSize: selectedResolution.value,
      requestAspectRatio: resolvedRequestAspectRatio,
      prompt,
      extraParams: effectiveExtraParams,
      referenceImageCount: referenceImages.length,
      referenceImagePlaceholders: createReferenceImagePlaceholders(referenceImages.length),
      outputCount,
      outputIndex: outputIndex + 1,
      appVersion: diagnostics.appVersion,
      osName: diagnostics.osName,
      osVersion: diagnostics.osVersion,
      osBuild: diagnostics.osBuild,
      userAgent: diagnostics.userAgent,
    });
    const submissions: ImageGenerationSubmissionResult[] = [];
    let resultNodes: ReturnType<typeof createImageOutputBatchNodes> = [];
    const ensureResultNodes = () => {
      if (resultNodes.length > 0) {
        return;
      }
      assertAuthorized(options.assertCurrent);
      const latestCanvas = useCanvasStore.getState();
      resultNodes = createImageOutputBatchNodes({
        sourceNodeId,
        outputCount,
        aspectRatio: resolvedRequestAspectRatio,
        resultNodeTitle: buildAiResultNodeTitle(
          resolveNodeDisplayName(sourceNode.type, sourceNode.data),
          options.fallbackResultTitle ?? 'AI image result'
        ),
        generationStartedAt,
        generationDurationMs,
        existingNodes: latestCanvas.nodes,
        existingEdges: latestCanvas.edges,
        addNodeBatch: latestCanvas.addNodeBatch,
        addEdge: latestCanvas.addEdge,
      });
      assertAuthorized(
        options.assertCurrent,
        resultNodes.map((resultNode) => resultNode.nodeId)
      );
    };
    const prepareProviderSubmission = () => {
      ensureResultNodes();
      options.onSubmissionStarting?.();
    };
    const markPendingSubmissionsFailed = (error: unknown) => {
      resultNodes.forEach(({ nodeId, outputIndex }) => {
        if (submissions.some((submission) => submission.resultNodeId === nodeId)) {
          return;
        }
        submissions.push(markFailedSubmission(
          nodeId,
          outputIndex,
          error,
          buildDebugContext(outputIndex),
          options.fallbackErrorMessage
        ));
      });
    };
    const setupKey = configuredModel.providerId;
    let setup = options.providerSetup?.get(setupKey);
    if (!setup) {
      setup = canvasAiGateway.setApiKey(
        providerRuntime.backendProviderId,
        providerRuntime.apiKey
      );
      options.providerSetup?.set(setupKey, setup);
    }

    try {
      await setup;
    } catch (error) {
      ensureResultNodes();
      markPendingSubmissionsFailed(error);
      return {
        sourceNodeId,
        resultNodeIds: resultNodes.map((resultNode) => resultNode.nodeId),
        submissions,
      };
    }

    try {
      const projectId = useProjectStore.getState().getCurrentProject()?.id;
      await canvasAiGateway.submitGenerateImageJobs({
        prompt,
        model: requestResolution.requestModel,
        size: selectedResolution.value,
        aspectRatio: resolvedRequestAspectRatio,
        referenceImages,
        extraParams: effectiveExtraParams,
        providerConfig: providerRuntime.providerConfig,
        projectId,
      }, outputCount, (submission, submissionIndex) => {
        const resultNode = resultNodes[submissionIndex];
        if (!resultNode) {
          return;
        }
        const { nodeId, outputIndex } = resultNode;
        if (submission.status === 'fulfilled') {
          useCanvasStore.getState().updateNodeData(nodeId, {
            generationJobId: submission.jobId,
            generationSourceType: 'imageEdit',
            generationProviderId: configuredModel.providerId,
            generationProviderName: getModelProvider(
              configuredModel.providerId,
              configuredModel.providerName
            ).name,
            generationModelName: configuredModel.displayName,
            generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
            generationDebugContext: buildDebugContext(outputIndex),
          });
          submissions.push({
            resultNodeId: nodeId,
            outputIndex,
            status: 'submitted',
            jobId: submission.jobId,
          });
          return;
        }
        submissions.push(markFailedSubmission(
          nodeId,
          outputIndex,
          submission.error,
          buildDebugContext(outputIndex),
          options.fallbackErrorMessage
        ));
      }, prepareProviderSubmission);
    } catch (error) {
      if (error instanceof ImageGenerationAuthorizationError) {
        throw error;
      }
      ensureResultNodes();
      markPendingSubmissionsFailed(error);
    }

    return {
      sourceNodeId,
      resultNodeIds: resultNodes.map((resultNode) => resultNode.nodeId),
      submissions: submissions.sort((left, right) => left.outputIndex - right.outputIndex),
    };
  } finally {
    inFlightSourceNodeIds.delete(sourceNodeId);
  }
}

export function buildAiResultNodeTitle(sourceTitle: string, fallbackTitle: string): string {
  const normalizedTitle = sourceTitle.trim();
  return `${normalizedTitle || fallbackTitle} · 结果`;
}

async function resolveRequestAspectRatio(
  requestedAspectRatio: string | undefined,
  referenceImages: string[]
): Promise<string> {
  if (requestedAspectRatio && requestedAspectRatio !== AUTO_REQUEST_ASPECT_RATIO) {
    return requestedAspectRatio;
  }
  if (referenceImages.length === 0) {
    return pickClosestImageGenerationAspectRatio(1);
  }
  try {
    const sourceAspectRatio = await detectAspectRatio(referenceImages[0]);
    return pickClosestImageGenerationAspectRatio(parseAspectRatio(sourceAspectRatio));
  } catch {
    return pickClosestImageGenerationAspectRatio(1);
  }
}

function markFailedSubmission(
  nodeId: string,
  outputIndex: number,
  error: unknown,
  debugContext: GenerationDebugContext,
  fallbackErrorMessage = 'Image generation failed.'
): ImageGenerationSubmissionResult {
  const failure = markImageOutputNodeFailed({
    nodeId,
    generationError: error,
    fallbackMessage: fallbackErrorMessage,
    generationDebugContext: debugContext,
    updateNodeData: useCanvasStore.getState().updateNodeData,
  });
  return {
    resultNodeId: nodeId,
    outputIndex,
    status: 'failed',
    errorMessage: failure.resolvedError.message,
    errorDetails: failure.resolvedError.details,
    errorReport: buildGenerationErrorReport({
      errorMessage: failure.resolvedError.message,
      errorDetails: failure.resolvedError.details,
      context: debugContext,
    }),
  };
}
