import { useEffect, useRef } from 'react';

import { writeBrowserGeneratedAsset } from '@/features/assets/application/browserGeneratedAsset';
import {
  canvasAiGateway,
  getCanvasAssetRepository,
} from '@/features/canvas/application/canvasServices';
import { CURRENT_RUNTIME_SESSION_ID } from '@/features/canvas/application/generationErrorReport';
import {
  resolveGenerationPollDelay,
  resolveImageGenerationRecoveryState,
  resolvePersistedImageGenerationRecovery,
} from '@/features/canvas/application/generationJobRecovery';
import { canApplyImageGenerationPollResult } from '@/features/canvas/application/generationJobLifecycle';
import { resolveVideoApiConfig } from '@/features/canvas/application/videoApiSelection';
import type {
  CanvasNode,
  CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import type { PersistedGenerationJobHandle } from '@/features/canvas/domain/generationJobHandle';
import { autoSaveVideoToProject } from '@/commands/image';
import type { VideoApiConfig } from '@/features/settings/domain/settingsSchema';
import { logger } from '@/lib/logger';
import { runtime } from '@/runtime/runtime';
import { useCanvasStore } from '@/stores/canvasStore';

const GENERATION_JOB_POLL_INTERVAL_MS = 1_400;
const MAX_POLL_FAILURES = 5;

type Translate = (key: string) => string;

interface UseVideoGenerationPollingOptions {
  nodes: CanvasNode[];
  videoApis: VideoApiConfig[];
  getCurrentProject: () => { id: string } | null;
  updateNodeData: (nodeId: string, data: Partial<CanvasNodeData>) => void;
  updateNodeDataWithoutHistory: (nodeId: string, data: Partial<CanvasNodeData>) => void;
  t: Translate;
}

function clearVideoJobData(error: string | null): Partial<CanvasNodeData> {
  return {
    isGenerating: false,
    generationStartedAt: null,
    generationJobId: null,
    generationTaskHandle: null,
    generationProviderRequestId: null,
    generationClientSessionId: null,
    generationProviderId: null,
    generationError: error,
    generationRecoveryState: null,
    generationRetryCount: 0,
    generationNextRetryAt: null,
    generationRetryError: null,
  } as Partial<CanvasNodeData>;
}

/** Polls generated-video result nodes and persists browser results as stable assets. */
export function useVideoGenerationPolling({
  nodes,
  videoApis,
  getCurrentProject,
  updateNodeData,
  updateNodeDataWithoutHistory,
  t,
}: UseVideoGenerationPollingOptions): void {
  const activeNodeIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const sleep = (delayMs: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, delayMs);
    });
    const pendingVideoNodes = nodes.filter((node) => {
      const data = node.data as Record<string, unknown>;
      return node.type === 'exportVideoNode'
        && data.isGenerating === true
        && typeof data.generationJobId === 'string'
        && data.generationJobId.length > 0;
    });

    for (const pendingNode of pendingVideoNodes) {
      const pendingData = pendingNode.data as Record<string, unknown>;
      const persistedRecovery = resolvePersistedImageGenerationRecovery({
        jobId: typeof pendingData.generationJobId === 'string' ? pendingData.generationJobId : null,
        taskHandle: pendingData.generationTaskHandle as PersistedGenerationJobHandle | null | undefined,
        isDesktop: runtime.isDesktop(),
        isCurrentRuntimeSession: pendingData.generationClientSessionId === CURRENT_RUNTIME_SESSION_ID,
      });
      if (persistedRecovery === 'interrupted') {
        updateNodeDataWithoutHistory(pendingNode.id, clearVideoJobData(t('node.imageNode.queryInterrupted')));
        continue;
      }
      if (activeNodeIdsRef.current.has(pendingNode.id)) {
        continue;
      }
      activeNodeIdsRef.current.add(pendingNode.id);
      const expectedProjectId = getCurrentProject()?.id ?? null;

      void (async () => {
        try {
          let pollFailureCount = 0;
          while (true) {
            const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
            if (!currentNode) break;

            const currentData = currentNode.data as Record<string, unknown>;
            const jobId = typeof currentData.generationJobId === 'string' ? currentData.generationJobId : '';
            if (!jobId || currentData.isGenerating !== true || currentData.generationRecoveryState === 'attention_required') {
              break;
            }
            const generationTaskHandle = currentData.generationTaskHandle as PersistedGenerationJobHandle | null | undefined;
            const isPollCurrent = () => canApplyImageGenerationPollResult({
              expectedProjectId,
              currentProjectId: getCurrentProject()?.id ?? null,
              nodeId: pendingNode.id,
              jobId,
              currentNode: useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id),
            });
            const generationProviderId = typeof currentData.generationProviderId === 'string'
              ? currentData.generationProviderId
              : '';
            const configuredVideoApi = generationProviderId === 'volcvideo'
              ? resolveVideoApiConfig(
                videoApis,
                typeof currentData.videoApiId === 'string' ? currentData.videoApiId : '',
                typeof currentData.model === 'string' ? currentData.model : undefined,
              )
              : undefined;
            const providerConfig = configuredVideoApi?.apiKey && configuredVideoApi.baseUrl
              ? {
                api_key: configuredVideoApi.apiKey.trim(),
                base_url: configuredVideoApi.baseUrl.trim(),
                config_id: configuredVideoApi.id,
                protocol: configuredVideoApi.protocol ?? 'volcengine-seedance',
              }
              : undefined;
            const status = await (
              currentData.generationRecoveryState === 'retry_requested'
                ? canvasAiGateway.retryGenerateImageJob(jobId, providerConfig, generationTaskHandle)
                : canvasAiGateway.getGenerateImageJob(jobId, providerConfig, generationTaskHandle)
            ).catch((error) => {
              logger.warn('[VideoJob] poll failed', { nodeId: pendingNode.id, jobId, error });
              return null;
            });
            if (!status) {
              pollFailureCount += 1;
              if (pollFailureCount >= MAX_POLL_FAILURES) {
                updateNodeData(pendingNode.id, clearVideoJobData(t('node.videoGen.pollingNetworkFailed')));
                break;
              }
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }
            pollFailureCount = 0;

            if (status.status === 'queued' || status.status === 'running') {
              if (status.error) {
                updateNodeData(pendingNode.id, clearVideoJobData(status.error));
                break;
              }
              const recoveryState = resolveImageGenerationRecoveryState(status.recovery);
              const recoveryRetryCount = status.recovery?.retry_count ?? 0;
              const recoveryNextRetryAt = status.recovery?.next_retry_at ?? null;
              const recoveryError = status.recovery?.last_error ?? null;
              if (currentData.generationRecoveryState !== recoveryState
                || currentData.generationRetryCount !== recoveryRetryCount
                || currentData.generationNextRetryAt !== recoveryNextRetryAt
                || currentData.generationRetryError !== recoveryError) {
                updateNodeDataWithoutHistory(pendingNode.id, {
                  generationRecoveryState: recoveryState,
                  generationRetryCount: recoveryRetryCount,
                  generationNextRetryAt: recoveryNextRetryAt,
                  generationRetryError: recoveryError,
                });
              }
              if (recoveryState === 'attention_required') break;
              await sleep(resolveGenerationPollDelay(
                status.recovery,
                Date.now(),
                GENERATION_JOB_POLL_INTERVAL_MS,
              ));
              continue;
            }

            if (status.status === 'cancelled') {
              updateNodeData(pendingNode.id, clearVideoJobData(
                typeof currentData.generationError === 'string' && currentData.generationError
                  ? currentData.generationError
                  : t('node.videoGen.generationCancelled'),
              ));
              break;
            }

            if (status.status === 'succeeded' && typeof status.result === 'string' && status.result.trim()) {
              let localVideoPath = status.result;
              let generatedAssetId: string | null = null;
              if (runtime.isDesktop() && expectedProjectId) {
                try {
                  localVideoPath = await autoSaveVideoToProject(status.result, expectedProjectId);
                } catch (error) {
                  logger.warn('[VideoJob] Failed to auto-save video to project directory', error);
                }
              } else if (!runtime.isDesktop()) {
                const repository = getCanvasAssetRepository();
                if (!repository || !expectedProjectId) {
                  const error = t('node.imageEdit.browserStorageUnavailable');
                  updateNodeData(pendingNode.id, {
                    generationError: error,
                    generationRecoveryState: 'attention_required',
                    generationRetryError: error,
                  });
                  break;
                }
                try {
                  generatedAssetId = (await writeBrowserGeneratedAsset({
                    source: status.result,
                    projectId: expectedProjectId,
                    providerId: generationProviderId,
                    model: typeof currentData.model === 'string' ? currentData.model : '',
                    kind: 'video',
                  }, repository)).assetId;
                  localVideoPath = '';
                } catch (error) {
                  if (!isPollCurrent()) break;
                  const message = error instanceof Error ? error.message : t('node.imageEdit.resultSaveFailed');
                  updateNodeData(pendingNode.id, {
                    generationError: message,
                    generationRecoveryState: 'attention_required',
                    generationRetryError: message,
                  });
                  break;
                }
              }
              if (!isPollCurrent()) break;
              updateNodeData(pendingNode.id, {
                ...clearVideoJobData(null),
                videoUrl: runtime.isDesktop() ? localVideoPath : null,
                assetId: generatedAssetId,
                ...(currentData.draft === true && status.external_task_id
                  ? { draftTaskId: status.external_task_id }
                  : {}),
                ...(status.seed !== undefined && status.seed !== null ? { seed: status.seed } : {}),
              });
              break;
            }

            updateNodeData(pendingNode.id, clearVideoJobData(
              status.error ?? (status.status === 'not_found'
                ? t('node.videoGen.generationJobNotFound')
                : t('node.videoGen.generationFailed')),
            ));
            break;
          }
        } finally {
          activeNodeIdsRef.current.delete(pendingNode.id);
        }
      })();
    }
  }, [getCurrentProject, nodes, t, updateNodeData, updateNodeDataWithoutHistory, videoApis]);
}
