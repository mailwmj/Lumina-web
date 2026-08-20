import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getCanvasAgentRuntime,
  isCanvasAgentManagedByLumina,
  type CanvasAgentRuntimeInfo,
} from '@/commands/canvasAgent';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { logger } from '@/lib/logger';
import {
  buildCanvasAgentSnapshot,
} from '@/features/canvas-agent/application/canvasAgentSnapshot';
import {
  parsePendingCanvasChangeProposal,
} from '@/features/canvas-agent/application/canvasChangeSet';
import {
  parsePendingCanvasAgentAction,
} from '@/features/canvas-agent/application/canvasAgentAction';
import { importCanvasAgentImages } from '@/features/canvas-agent/application/importCanvasAgentImages';
import { buildCanvasAgentNodeImages } from '@/features/canvas-agent/application/canvasAgentNodeImages';
import { runImageGenerationNodes } from '@/features/canvas/application/imageGenerationRun';
import {
  buildSelectedImagePreviews,
  type SelectedImagePreviewSource,
} from '@/features/canvas-agent/application/selectedImagePreviews';
import { useStableSelectedImagePreviewSources } from '@/features/canvas-agent/hooks/useStableSelectedImagePreviewSources';
import {
  consumeCanvasAgentEvents,
  postCanvasActionResult,
  postCanvasProposalResult,
  resolveCanvasAgentEndpoint,
  type CanvasAgentEndpoint,
} from '@/features/canvas-agent/infrastructure/canvasAgentBridge';
import { CanvasAgentSnapshotPublisher } from '@/features/canvas-agent/infrastructure/canvasAgentSnapshotPublisher';
import type {
  CanvasAgentConnectionStatus,
  CanvasAgentImagePreview,
  CanvasAgentSnapshot,
} from '@/features/canvas-agent/domain/types';
import type { Viewport } from '@xyflow/react';

interface UseExternalAgentBridgeInput {
  projectId: string;
  projectName: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeIds: string[];
  viewport: Viewport;
}

const RECONNECT_DELAY_MS = 1_200;
const SNAPSHOT_PUBLISH_DELAY_MS = 100;
const SNAPSHOT_HEARTBEAT_MS = 5_000;
const EMPTY_IMAGE_PREVIEWS: CanvasAgentImagePreview[] = [];

export function useExternalAgentBridge({
  projectId,
  projectName,
  nodes,
  edges,
  selectedNodeIds,
  viewport,
}: UseExternalAgentBridgeInput) {
  const connectionConfig = useSettingsStore((state) => state.externalAgentConnection);
  const managedByLumina = isCanvasAgentManagedByLumina();
  const [managedRuntime, setManagedRuntime] = useState<CanvasAgentRuntimeInfo | null>(null);
  const manualEndpoint = useMemo(
    () => resolveCanvasAgentEndpoint(connectionConfig),
    [connectionConfig]
  );
  const endpoint = useMemo(
    () => {
      if (!connectionConfig.enabled) {
        return null;
      }
      if (!managedByLumina) {
        return manualEndpoint;
      }
      if (!managedRuntime?.running || !managedRuntime.url || !managedRuntime.token) {
        return null;
      }
      return { url: managedRuntime.url, token: managedRuntime.token };
    },
    [connectionConfig.enabled, managedByLumina, managedRuntime, manualEndpoint]
  );
  const clientIdRef = useRef(crypto.randomUUID());
  const [connectionStatus, setConnectionStatus] = useState<CanvasAgentConnectionStatus>(
    connectionConfig.enabled ? 'disconnected' : 'disabled'
  );
  const selectedImagePreviewSources = useStableSelectedImagePreviewSources(
    nodes,
    selectedNodeIds
  );
  const [imagePreviewState, setImagePreviewState] = useState<{
    sources: SelectedImagePreviewSource[];
    previews: CanvasAgentImagePreview[];
  }>(() => ({ sources: [], previews: [] }));
  const selectedImagePreviews = imagePreviewState.sources === selectedImagePreviewSources
    ? imagePreviewState.previews
    : EMPTY_IMAGE_PREVIEWS;
  const baseSnapshot = useMemo(
    () => buildCanvasAgentSnapshot({
      projectId,
      projectName,
      nodes,
      edges,
      selectedNodeIds,
      viewport,
      selectedImagePreviews,
    }),
    [edges, nodes, projectId, projectName, selectedImagePreviews, selectedNodeIds, viewport]
  );
  const snapshotRef = useRef<CanvasAgentSnapshot>(baseSnapshot);
  snapshotRef.current = baseSnapshot;
  const previewMarker = useMemo(() => ({
    selection: selectedImagePreviewSources,
    previews: selectedImagePreviews,
  }), [selectedImagePreviewSources, selectedImagePreviews]);
  const previewMarkerRef = useRef(previewMarker);
  previewMarkerRef.current = previewMarker;
  const snapshotPublisherRef = useRef<CanvasAgentSnapshotPublisher | null>(null);
  if (!snapshotPublisherRef.current) {
    snapshotPublisherRef.current = new CanvasAgentSnapshotPublisher((error) => {
      logger.debug('[ExternalAgent] Failed to publish canvas snapshot', error);
    });
  }

  const reportProposal = useCallback((
    activeEndpoint: CanvasAgentEndpoint,
    proposalId: string,
    status: 'applied' | 'stale' | 'failed',
    result?: unknown,
    error?: string
  ) => postCanvasProposalResult(activeEndpoint, clientIdRef.current, {
    proposalId,
    status,
    ...(result === undefined ? {} : { result }),
    ...(error ? { error } : {}),
  }).catch((requestError) => {
    logger.debug('[ExternalAgent] Failed to report proposal result', requestError);
  }), []);

  const reportAction = useCallback((
    activeEndpoint: CanvasAgentEndpoint,
    actionId: string,
    status: 'applied' | 'stale' | 'failed',
    result?: unknown,
    error?: string
  ) => postCanvasActionResult(activeEndpoint, clientIdRef.current, {
    actionId,
    status,
    ...(result === undefined ? {} : { result }),
    ...(error ? { error } : {}),
  }), []);

  useEffect(() => {
    if (!managedByLumina) {
      setManagedRuntime(null);
      return;
    }
    let cancelled = false;
    const refreshRuntime = async () => {
      try {
        const runtime = await getCanvasAgentRuntime();
        if (!cancelled) {
          setManagedRuntime((current) => (
            haveSameManagedRuntime(current, runtime) ? current : runtime
          ));
        }
      } catch (error) {
        logger.debug('[ExternalAgent] Failed to read managed Canvas Agent runtime', error);
        if (!cancelled) {
          setManagedRuntime(null);
        }
      }
    };
    void refreshRuntime();
    const timer = window.setInterval(() => {
      void refreshRuntime();
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [managedByLumina]);

  useEffect(() => {
    let cancelled = false;
    if (selectedImagePreviewSources.length === 0) {
      setImagePreviewState((current) => (
        current.sources === selectedImagePreviewSources && current.previews.length === 0
          ? current
          : { sources: selectedImagePreviewSources, previews: [] }
      ));
      return () => {
        cancelled = true;
      };
    }
    void buildSelectedImagePreviews(selectedImagePreviewSources).then((previews) => {
      if (cancelled) {
        return;
      }
      setImagePreviewState({ sources: selectedImagePreviewSources, previews });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedImagePreviewSources]);

  const queueSnapshotPublish = useCallback((
    activeEndpoint: CanvasAgentEndpoint,
    forcePreviews = false
  ) => {
    snapshotPublisherRef.current?.enqueue({
      endpoint: activeEndpoint,
      clientId: clientIdRef.current,
      snapshot: snapshotRef.current,
      previewMarker: previewMarkerRef.current,
      forcePreviews,
    });
  }, []);

  useEffect(() => {
    if (!connectionConfig.enabled) {
      setConnectionStatus('disabled');
      return;
    }
    if (!endpoint) {
      setConnectionStatus('disconnected');
      return;
    }

    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof window.setTimeout> | null = null;
    const connect = async () => {
      if (controller.signal.aborted) {
        return;
      }
      setConnectionStatus('connecting');
      try {
        await consumeCanvasAgentEvents(
          endpoint,
          clientIdRef.current,
          controller.signal,
          {
            onOpen: () => {
              setConnectionStatus('connected');
              queueSnapshotPublish(endpoint, true);
            },
            onEvent: (event) => {
              if (event.type === 'change_proposal') {
                handleProposalEvent(endpoint, event.payload);
                return;
              }
              if (event.type === 'action_request') {
                void handleActionEvent(endpoint, event.payload);
              }
            },
          }
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          logger.debug('[ExternalAgent] Canvas Agent connection unavailable', error);
        }
      }
      if (!controller.signal.aborted) {
        setConnectionStatus('disconnected');
        reconnectTimer = window.setTimeout(() => {
          void connect();
        }, RECONNECT_DELAY_MS);
      }
    };

    const handleProposalEvent = (activeEndpoint: CanvasAgentEndpoint, payload: unknown) => {
      try {
        const proposal = parsePendingCanvasChangeProposal(payload);
        const project = useProjectStore.getState().getCurrentProject();
        const canvas = useCanvasStore.getState();
        if (!project) {
          void reportProposal(activeEndpoint, proposal.proposalId, 'stale', undefined, 'project_closed');
          return;
        }
        const current = buildCanvasAgentSnapshot({
          projectId: project.id,
          projectName: project.name,
          nodes: canvas.nodes,
          edges: canvas.edges,
          selectedNodeIds: canvas.nodes.filter((node) => node.selected).map((node) => node.id),
          viewport: canvas.currentViewport,
        });
        if (
          proposal.changeSet.projectId !== current.projectId
          || proposal.changeSet.baseRevision !== current.revision
        ) {
          void reportProposal(activeEndpoint, proposal.proposalId, 'stale', undefined, 'canvas_changed');
          return;
        }
        try {
          const result = canvas.applyAgentChangeSet(proposal.changeSet);
          void reportProposal(activeEndpoint, proposal.proposalId, 'applied', result);
        } catch (error) {
          void reportProposal(
            activeEndpoint,
            proposal.proposalId,
            'failed',
            undefined,
            error instanceof Error ? error.message : String(error)
          );
        }
      } catch (error) {
        const proposalId = readProposalId(payload);
        if (proposalId) {
          void reportProposal(
            activeEndpoint,
            proposalId,
            'failed',
            undefined,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    };

    const handleActionEvent = async (
      activeEndpoint: CanvasAgentEndpoint,
      payload: unknown
    ) => {
      const actionId = readActionId(payload);
      try {
        const action = parsePendingCanvasAgentAction(payload);
        const current = readCurrentCanvasSnapshot();
        if (!current) {
          await reportAction(activeEndpoint, action.actionId, 'stale', undefined, 'project_closed');
          return;
        }
        if (action.request.projectId !== current.projectId) {
          await reportAction(activeEndpoint, action.actionId, 'stale', undefined, 'project_changed');
          return;
        }
        if (
          'baseRevision' in action.request
          && action.request.baseRevision !== current.revision
        ) {
          await reportAction(activeEndpoint, action.actionId, 'stale', undefined, 'canvas_changed');
          return;
        }

        let result: unknown;
        if (action.request.type === 'import_images') {
          const importRequest = action.request;
          result = await importCanvasAgentImages({
            projectId: importRequest.projectId,
            images: importRequest.images,
            ...(importRequest.position ? { position: importRequest.position } : {}),
            assertCurrent: () => {
              const latest = readCurrentCanvasSnapshot();
              if (
                !latest
                || latest.projectId !== importRequest.projectId
                || latest.revision !== importRequest.baseRevision
              ) {
                throw new CanvasActionStaleError();
              }
            },
          });
        } else if (action.request.type === 'run_nodes') {
          const runRequest = action.request;
          result = await runImageGenerationNodes(runRequest.nodeIds, {
            assertCurrent: createCanvasActionRevisionGuard(
              runRequest.projectId,
              runRequest.baseRevision
            ),
          });
        } else {
          result = await buildCanvasAgentNodeImages({
            projectId: action.request.projectId,
            nodeIds: action.request.nodeIds,
            maxDimension: action.request.maxDimension,
          });
        }
        await reportAction(activeEndpoint, action.actionId, 'applied', result);
      } catch (error) {
        if (!actionId) {
          return;
        }
        await reportAction(
          activeEndpoint,
          actionId,
          error instanceof CanvasActionStaleError ? 'stale' : 'failed',
          undefined,
          error instanceof Error ? error.message : String(error)
        ).catch((requestError) => {
          logger.debug('[ExternalAgent] Failed to report action result', requestError);
        });
      }
    };

    void connect();
    return () => {
      controller.abort();
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
    };
  }, [
    connectionConfig.enabled,
    endpoint,
    queueSnapshotPublish,
    reportAction,
    reportProposal,
  ]);

  useEffect(() => {
    if (!endpoint || connectionStatus !== 'connected') {
      return;
    }
    const timer = window.setTimeout(() => {
      queueSnapshotPublish(endpoint);
    }, SNAPSHOT_PUBLISH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [baseSnapshot, connectionStatus, endpoint, queueSnapshotPublish]);

  useEffect(() => {
    if (!endpoint || connectionStatus !== 'connected') {
      return;
    }
    const timer = window.setInterval(() => {
      queueSnapshotPublish(endpoint);
    }, SNAPSHOT_HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [connectionStatus, endpoint, queueSnapshotPublish]);

  return {
    connectionStatus,
  };
}

function readProposalId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  const proposalId = (value as Record<string, unknown>).proposalId;
  return typeof proposalId === 'string' ? proposalId : '';
}

function readActionId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  const actionId = (value as Record<string, unknown>).actionId;
  return typeof actionId === 'string' ? actionId : '';
}

function readCurrentCanvasSnapshot(
  excludedNodeIds: ReadonlySet<string> = new Set()
): CanvasAgentSnapshot | null {
  const project = useProjectStore.getState().getCurrentProject();
  if (!project) {
    return null;
  }
  const canvas = useCanvasStore.getState();
  const nodes = excludedNodeIds.size === 0
    ? canvas.nodes
    : canvas.nodes.filter((node) => !excludedNodeIds.has(node.id));
  const edges = excludedNodeIds.size === 0
    ? canvas.edges
    : canvas.edges.filter((edge) => (
      !excludedNodeIds.has(edge.source) && !excludedNodeIds.has(edge.target)
    ));
  return buildCanvasAgentSnapshot({
    projectId: project.id,
    projectName: project.name,
    nodes,
    edges,
    selectedNodeIds: nodes.filter((node) => node.selected).map((node) => node.id),
    viewport: canvas.currentViewport,
  });
}

function createCanvasActionRevisionGuard(projectId: string, baseRevision: string) {
  const ownedResultNodeIds = new Set<string>();
  return (newResultNodeIds: readonly string[] = []) => {
    newResultNodeIds.forEach((nodeId) => ownedResultNodeIds.add(nodeId));
    const latest = readCurrentCanvasSnapshot(ownedResultNodeIds);
    if (!latest || latest.projectId !== projectId) {
      throw new CanvasActionStaleError('project_changed');
    }
    if (latest.revision !== baseRevision) {
      throw new CanvasActionStaleError();
    }
  };
}

class CanvasActionStaleError extends Error {
  constructor(reason = 'canvas_changed') {
    super(reason);
    this.name = 'CanvasActionStaleError';
  }
}

function haveSameManagedRuntime(
  current: CanvasAgentRuntimeInfo | null,
  next: CanvasAgentRuntimeInfo | null
): boolean {
  return current?.available === next?.available
    && current?.running === next?.running
    && current?.url === next?.url
    && current?.token === next?.token
    && current?.error === next?.error;
}
