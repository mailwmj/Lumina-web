import { useEffect, useRef } from 'react';

import {
  collectCanvasImagePreviewJobs,
  createCanvasImagePreviewPatch,
  getCanvasImagePreviewJobKey,
  type CanvasImagePreviewJob,
} from '@/features/canvas/application/canvasImagePreviewBackfill';
import { useCanvasImageQualityStore } from '@/features/canvas/application/canvasImageQualityStore';
import { createNodeImagePreview } from '@/features/canvas/application/imageData';
import type {
  CanvasNodeData,
  CanvasWorkflowNode,
} from '@/features/canvas/domain/canvasNodes';
import { logger } from '@/lib/logger';
import { useCanvasStore } from '@/stores/canvasStore';

const BACKFILL_IDLE_DELAY_MS = 700;

interface PendingPreviewResult {
  job: CanvasImagePreviewJob;
  previewImageUrl: string;
}

interface UseCanvasImagePreviewBackfillInput {
  projectId: string | null;
  workflowNodes: readonly CanvasWorkflowNode[];
  isInteractionActive: boolean;
  updateNodeDataWithoutHistory: (nodeId: string, data: Partial<CanvasNodeData>) => void;
}

export function useCanvasImagePreviewBackfill({
  projectId,
  workflowNodes,
  isInteractionActive,
  updateNodeDataWithoutHistory,
}: UseCanvasImagePreviewBackfillInput): void {
  const completedJobKeysRef = useRef(new Set<string>());
  const pendingResultsRef = useRef(new Map<string, PendingPreviewResult>());
  const runningRef = useRef(false);
  const projectRunTokenRef = useRef(0);

  useEffect(() => {
    completedJobKeysRef.current.clear();
    pendingResultsRef.current.clear();
    projectRunTokenRef.current += 1;
    // A previous project can still be decoding in Tauri. Its token prevents it
    // from changing the current project's queue after it completes.
    runningRef.current = false;
  }, [projectId]);

  useEffect(() => {
    if (!projectId || isInteractionActive) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const run = async () => {
        if (runningRef.current || cancelled) {
          return;
        }
        const runToken = projectRunTokenRef.current;
        runningRef.current = true;

        try {
          while (
            !cancelled
            && runToken === projectRunTokenRef.current
            && !useCanvasImageQualityStore.getState().isInteractionActive
          ) {
            for (const [key, pending] of pendingResultsRef.current) {
              const node = useCanvasStore.getState().nodes.find((item) => item.id === pending.job.nodeId);
              if (node) {
                const patch = createCanvasImagePreviewPatch(
                  node,
                  pending.job,
                  pending.previewImageUrl
                );
                if (patch) {
                  updateNodeDataWithoutHistory(pending.job.nodeId, patch);
                }
              }
              completedJobKeysRef.current.add(key);
              pendingResultsRef.current.delete(key);
            }

            const jobs = collectCanvasImagePreviewJobs(workflowNodes);
            const job = jobs.find((candidate) => !completedJobKeysRef.current.has(
              getCanvasImagePreviewJobKey(candidate)
            ));
            if (!job) {
              return;
            }

            const key = getCanvasImagePreviewJobKey(job);
            try {
              const prepared = await createNodeImagePreview(job.imageUrl, 512, projectId);
              if (cancelled || runToken !== projectRunTokenRef.current) {
                return;
              }
              if (useCanvasImageQualityStore.getState().isInteractionActive) {
                pendingResultsRef.current.set(key, {
                  job,
                  previewImageUrl: prepared.previewImageUrl,
                });
                return;
              }

              const node = useCanvasStore.getState().nodes.find((item) => item.id === job.nodeId);
              if (node) {
                const patch = createCanvasImagePreviewPatch(node, job, prepared.previewImageUrl);
                if (patch) {
                  updateNodeDataWithoutHistory(job.nodeId, patch);
                }
              }
              completedJobKeysRef.current.add(key);
            } catch (error) {
              if (cancelled || runToken !== projectRunTokenRef.current) {
                return;
              }
              completedJobKeysRef.current.add(key);
              logger.warn('[canvas-image-preview] unable to create preview', {
                nodeId: job.nodeId,
                error,
              });
            }
          }
        } finally {
          if (runToken === projectRunTokenRef.current) {
            runningRef.current = false;
          }
        }
      };

      void run();
    }, BACKFILL_IDLE_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isInteractionActive, projectId, updateNodeDataWithoutHistory, workflowNodes]);
}
