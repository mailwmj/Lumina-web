import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Viewport } from '@xyflow/react';

import { runImageGenerationNodes } from '@/features/canvas/application/imageGenerationRun';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { buildCanvasAgentNodeImages } from '@/features/canvas-agent/application/canvasAgentNodeImages';
import {
  invalidateCanvasGenerationMutationAuthorities,
  registerCanvasGenerationMutationAuthority,
} from '@/features/canvas-agent/application/canvasGenerationMutationAuthority';
import { buildCanvasAgentSnapshot } from '@/features/canvas-agent/application/canvasAgentSnapshot';
import { parsePendingCanvasAgentAction } from '@/features/canvas-agent/application/canvasAgentAction';
import { parsePendingCanvasChangeProposal } from '@/features/canvas-agent/application/canvasChangeSet';
import { importCanvasAgentImages } from '@/features/canvas-agent/application/importCanvasAgentImages';
import type { CanvasAgentSnapshot } from '@/features/canvas-agent/domain/types';
import {
  consumeWebCanvasEvents,
  connectWebCanvasBridge,
  disconnectWebCanvasBridge,
  enableWebCanvasCodexEditing,
  postWebCanvasActionResult,
  postWebCanvasProposalResult,
  requestWebCanvasDelegation,
  type WebCanvasEvent,
} from '@/features/canvas-agent/infrastructure/webCanvasBridge';
import {
  captureWebCanvasBootstrap,
  clearCapturedWebCanvasBootstrap,
  type WebCanvasBootstrap,
} from '@/features/canvas-agent/infrastructure/webCanvasBootstrap';
import { WebCanvasSnapshotPublisher } from '@/features/canvas-agent/infrastructure/webCanvasSnapshotPublisher';
import { logger } from '@/lib/logger';
import { runtimeProjectClient } from '@/runtime/runtimeProjectClient';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';

const SNAPSHOT_PUBLISH_DELAY_MS = 100;
const SNAPSHOT_HEARTBEAT_MS = 5_000;

interface UseCodexWebCanvasBridgeInput {
  projectId: string | null;
  projectName: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeIds: string[];
  viewport: Viewport;
}

export interface PendingCodexRunAuthorization {
  actionId: string;
  nodeIds: string[];
}

export interface CodexWebCanvasBridgeState {
  isWriteAuthorizationPending: boolean;
  pendingRunAuthorization: PendingCodexRunAuthorization | null;
  grantWriteAccess(): Promise<void>;
  keepProjectReadOnly(): void;
  grantRunAuthorization(): void;
  denyRunAuthorization(): void;
}

interface PendingRunAuthorization extends PendingCodexRunAuthorization {
  resolve: (allowed: boolean) => void;
}

export function useCodexWebCanvasBridge({
  projectId,
  projectName,
  nodes,
  edges,
  selectedNodeIds,
  viewport,
}: UseCodexWebCanvasBridgeInput): CodexWebCanvasBridgeState {
  const bootstrapRef = useRef<WebCanvasBootstrap | null>(null);
  if (!bootstrapRef.current && typeof window !== 'undefined') {
    bootstrapRef.current = captureWebCanvasBootstrap(window.location, window.history);
  }
  const [writeAccess, setWriteAccess] = useState(false);
  const writeAccessRef = useRef(false);
  const [writeAuthorizationResolved, setWriteAuthorizationResolved] = useState(false);
  const pendingRunRef = useRef<PendingRunAuthorization | null>(null);
  const [pendingRunAuthorization, setPendingRunAuthorization] = useState<PendingCodexRunAuthorization | null>(null);
  const snapshot = useMemo(() => projectId ? buildCanvasAgentSnapshot({
    projectId,
    projectName,
    nodes,
    edges,
    selectedNodeIds,
    viewport,
    writeAccess,
  }) : null, [edges, nodes, projectId, projectName, selectedNodeIds, viewport, writeAccess]);
  const snapshotRef = useRef<CanvasAgentSnapshot | null>(snapshot);
  snapshotRef.current = snapshot;
  const connectedRef = useRef(false);
  const bridgeConnectRef = useRef<{
    bootstrap: WebCanvasBootstrap;
    promise: Promise<void>;
  } | null>(null);
  const boundProjectIdRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const disconnectTimerRef = useRef<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const snapshotPublisherRef = useRef<WebCanvasSnapshotPublisher | null>(null);
  if (!snapshotPublisherRef.current) {
    snapshotPublisherRef.current = new WebCanvasSnapshotPublisher((error) => {
      logger.debug('[CodexCanvas] Failed to publish Web canvas snapshot', error);
    });
  }

  const resolveRunAuthorization = useCallback((allowed: boolean) => {
    const pending = pendingRunRef.current;
    if (!pending) {
      return;
    }
    pendingRunRef.current = null;
    setPendingRunAuthorization(null);
    pending.resolve(allowed);
  }, []);

  const requestRunAuthorization = useCallback((
    actionId: string,
    nodeIds: string[],
  ): Promise<boolean> => new Promise((resolve) => {
    if (pendingRunRef.current) {
      resolve(false);
      return;
    }
    pendingRunRef.current = { actionId, nodeIds, resolve };
    setPendingRunAuthorization({ actionId, nodeIds });
  }), []);

  const reportProposal = useCallback((
    bootstrap: WebCanvasBootstrap,
    proposalId: string,
    status: 'applied' | 'stale' | 'failed',
    result?: unknown,
    error?: string,
  ) => postWebCanvasProposalResult(bootstrap, {
    proposalId,
    status,
    ...(result === undefined ? {} : { result }),
    ...(error ? { error } : {}),
  }).catch((requestError) => {
    logger.debug('[CodexCanvas] Failed to report Web canvas proposal result', requestError);
  }), []);

  const reportAction = useCallback((
    bootstrap: WebCanvasBootstrap,
    actionId: string,
    status: 'applied' | 'stale' | 'failed',
    result?: unknown,
    error?: string,
  ) => postWebCanvasActionResult(bootstrap, {
    actionId,
    status,
    ...(result === undefined ? {} : { result }),
    ...(error ? { error } : {}),
  }).catch((requestError) => {
    logger.debug('[CodexCanvas] Failed to report Web canvas action result', requestError);
  }), []);

  const isActiveBootstrap = useCallback((bootstrap: WebCanvasBootstrap, generation?: number) => (
    bootstrapRef.current === bootstrap
      && (generation === undefined || sessionGenerationRef.current === generation)
  ), []);

  const handleProposalEvent = useCallback(async (
    bootstrap: WebCanvasBootstrap,
    payload: unknown,
    isSessionActive: () => boolean,
  ) => {
    if (!isSessionActive()) {
      return;
    }
    const proposalId = readProposalId(payload);
    try {
      const proposal = parsePendingCanvasChangeProposal(payload);
      const projectState = useProjectStore.getState();
      const project = projectState.getCurrentProject();
      if (!project) {
        void reportProposal(bootstrap, proposal.proposalId, 'stale', undefined, 'project_closed');
        return;
      }
      if (projectState.editorState.mode !== 'codex' || !writeAccessRef.current) {
        void reportProposal(
          bootstrap,
          proposal.proposalId,
          'stale',
          undefined,
          'project_write_not_authorized',
        );
        return;
      }
      if (proposal.changeSet.projectId !== project.id) {
        void reportProposal(bootstrap, proposal.proposalId, 'stale', undefined, 'project_changed');
        return;
      }
      const result = await runDelegatedCanvasMutation(
        bootstrap,
        proposal.proposalId,
        isSessionActive,
        () => useCanvasStore.getState().applyAgentChangeSet(proposal.changeSet),
      );
      if (isSessionActive()) {
        void reportProposal(bootstrap, proposal.proposalId, 'applied', result);
      }
    } catch (error) {
      if (proposalId && isSessionActive()) {
        void reportProposal(
          bootstrap,
          proposalId,
          'failed',
          undefined,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }, [reportProposal]);

  const handleActionEvent = useCallback(async (
    bootstrap: WebCanvasBootstrap,
    payload: unknown,
    isSessionActive: () => boolean,
  ) => {
    const actionId = readActionId(payload);
    try {
      const action = parsePendingCanvasAgentAction(payload);
      const requiresWrite = action.request.type !== 'get_node_images';
      assertCanvasActionCurrent(
        action.request.projectId,
        requiresWrite,
        writeAccessRef.current,
        isSessionActive,
      );

      let result: unknown;
      if (action.request.type === 'get_node_images') {
        result = await buildCanvasAgentNodeImages({
          projectId: action.request.projectId,
          nodeIds: action.request.nodeIds,
          maxDimension: action.request.maxDimension,
        });
      } else {
        result = await runDelegatedCanvasMutation(
          bootstrap,
          action.actionId,
          isSessionActive,
          async () => {
            if (action.request.type === 'import_images') {
              const request = action.request;
              return importCanvasAgentImages({
                projectId: request.projectId,
                images: request.images,
                ...(request.position ? { position: request.position } : {}),
                assertCurrent: () => assertCanvasActionCurrent(
                  request.projectId,
                  true,
                  writeAccessRef.current,
                  isSessionActive,
                ),
              });
            }

            const request = action.request;
            const allowed = await requestRunAuthorization(action.actionId, request.nodeIds);
            if (!allowed) {
              throw new CanvasActionAuthorizationError('run_not_authorized');
            }
            assertCanvasActionCurrent(
              request.projectId,
              true,
              writeAccessRef.current,
              isSessionActive,
            );
            const generationResult = await runImageGenerationNodes(request.nodeIds, {
              assertCurrent: createCanvasActionGuard(
                request.projectId,
                () => writeAccessRef.current,
                isSessionActive,
              ),
            });
            const resultNodeIds = readSubmittedGenerationNodeIds(generationResult);
            if (resultNodeIds.length > 0) {
              registerCanvasGenerationMutationAuthority({
                sessionId: bootstrap.sessionId,
                nodeIds: resultNodeIds,
                run: (operation) => runDelegatedCanvasMutation(
                  bootstrap,
                  action.actionId,
                  isSessionActive,
                  operation,
                ),
              });
            }
            return generationResult;
          },
        );
      }
      if (isSessionActive()) {
        await reportAction(bootstrap, action.actionId, 'applied', result);
      }
    } catch (error) {
      if (!actionId || !isSessionActive()) {
        return;
      }
      await reportAction(
        bootstrap,
        actionId,
        error instanceof CanvasActionStaleError ? 'stale' : 'failed',
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [reportAction, requestRunAuthorization]);

  useEffect(() => {
    if (
      disconnectTimerRef.current !== null
      && (boundProjectIdRef.current === null || boundProjectIdRef.current === projectId)
    ) {
      window.clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    const bootstrap = bootstrapRef.current;
    if (
      !bootstrap
      || (bridgeConnectRef.current === null && bootstrap.expiresAt <= Date.now())
      || disconnectTimerRef.current !== null
    ) {
      return;
    }
    boundProjectIdRef.current = projectId;
    const controller = new AbortController();
    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    let active = true;
    const isSessionActive = () => active && isActiveBootstrap(bootstrap, generation);
    const clearSession = () => {
      invalidateCanvasGenerationMutationAuthorities(bootstrap.sessionId);
      connectedRef.current = false;
      setIsConnected(false);
      snapshotPublisherRef.current?.clear();
      resolveRunAuthorization(false);
      if (bootstrapRef.current === bootstrap) {
        bootstrapRef.current = null;
        clearCapturedWebCanvasBootstrap(bootstrap);
      }
      if (bridgeConnectRef.current?.bootstrap === bootstrap) {
        bridgeConnectRef.current = null;
      }
      if (boundProjectIdRef.current === projectId) {
        boundProjectIdRef.current = null;
      }
    };
    const connect = async () => {
      try {
        if (bridgeConnectRef.current?.bootstrap !== bootstrap) {
          bridgeConnectRef.current = {
            bootstrap,
            promise: connectWebCanvasBridge(bootstrap),
          };
        }
        await bridgeConnectRef.current.promise;
        if (!isSessionActive()) {
          return;
        }
        await consumeWebCanvasEvents(bootstrap, controller.signal, {
          onOpen: () => {
            if (!isSessionActive()) {
              return;
            }
            connectedRef.current = true;
            setIsConnected(true);
            const currentSnapshot = snapshotRef.current;
            if (currentSnapshot) {
              snapshotPublisherRef.current?.enqueue(bootstrap, currentSnapshot, true);
            }
          },
          onEvent: (event: WebCanvasEvent) => {
            if (!isSessionActive()) {
              return;
            }
            if (event.type === 'change_proposal') {
              void handleProposalEvent(bootstrap, event.payload, isSessionActive);
            } else if (event.type === 'action_request') {
              void handleActionEvent(bootstrap, event.payload, isSessionActive);
            }
          },
        });
      } catch (error) {
        if (active && !controller.signal.aborted) {
          logger.debug('[CodexCanvas] Web canvas bridge disconnected', error);
        }
      } finally {
        if (active) {
          clearSession();
        }
      }
    };
    void connect();
    return () => {
      active = false;
      invalidateCanvasGenerationMutationAuthorities(bootstrap.sessionId);
      if (sessionGenerationRef.current === generation) {
        sessionGenerationRef.current += 1;
      }
      controller.abort();
      connectedRef.current = false;
      setIsConnected(false);
      resolveRunAuthorization(false);
      const disconnectTimer = window.setTimeout(() => {
        if (disconnectTimerRef.current !== disconnectTimer) {
          return;
        }
        disconnectTimerRef.current = null;
        clearSession();
        void disconnectWebCanvasBridge(bootstrap).catch((error) => {
          logger.debug('[CodexCanvas] Failed to disconnect Web canvas bridge', error);
        });
      }, 0);
      disconnectTimerRef.current = disconnectTimer;
    };
  }, [
    handleActionEvent,
    handleProposalEvent,
    isActiveBootstrap,
    projectId,
    resolveRunAuthorization,
  ]);

  useEffect(() => {
    if (!isConnected || !bootstrapRef.current || !snapshot) {
      return;
    }
    const bootstrap = bootstrapRef.current;
    const timer = window.setTimeout(() => {
      if (
        connectedRef.current
        && isActiveBootstrap(bootstrap)
        && boundProjectIdRef.current === snapshot.projectId
      ) {
        snapshotPublisherRef.current?.enqueue(bootstrap, snapshot);
      }
    }, SNAPSHOT_PUBLISH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isActiveBootstrap, isConnected, snapshot]);

  useEffect(() => {
    if (!isConnected || !bootstrapRef.current || !snapshot) {
      return;
    }
    const bootstrap = bootstrapRef.current;
    const timer = window.setInterval(() => {
      if (
        connectedRef.current
        && isActiveBootstrap(bootstrap)
        && boundProjectIdRef.current === snapshot.projectId
      ) {
        snapshotPublisherRef.current?.enqueue(bootstrap, snapshot);
      }
    }, SNAPSHOT_HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [isActiveBootstrap, isConnected, snapshot]);

  useEffect(() => {
    writeAccessRef.current = false;
    setWriteAccess(false);
    setWriteAuthorizationResolved(false);
  }, [projectId]);

  const grantWriteAccess = useCallback(async () => {
    const bootstrap = bootstrapRef.current;
    const project = useProjectStore.getState().getCurrentProject();
    if (!bootstrap || !project) {
      return;
    }
    const canvas = useCanvasStore.getState();
    let handedOff = false;
    try {
      await useProjectStore.getState().saveCurrentProject(
        canvas.nodes,
        canvas.edges,
        canvas.currentViewport,
        canvas.history,
        { immediate: true },
      );
      await runtimeProjectClient.handoffToCodex(bootstrap.sessionId);
      handedOff = true;
      await enableWebCanvasCodexEditing(bootstrap);
      writeAccessRef.current = true;
      setWriteAccess(true);
      setWriteAuthorizationResolved(true);
    } catch (error) {
      if (handedOff) {
        await runtimeProjectClient.abortCodexHandoff(bootstrap.sessionId).catch((abortError) => {
          logger.warn('[CodexCanvas] Failed to abort partial Runtime handoff', abortError);
        });
      }
      logger.error('[CodexCanvas] Failed to hand off the Runtime editor lease', error);
      writeAccessRef.current = false;
      setWriteAccess(false);
    }
  }, []);

  const keepProjectReadOnly = useCallback(() => {
    writeAccessRef.current = false;
    setWriteAccess(false);
    setWriteAuthorizationResolved(true);
  }, []);

  return {
    isWriteAuthorizationPending: Boolean(
      bootstrapRef.current
      && projectId
      && !useProjectStore.getState().isCurrentProjectReadOnly
      && !writeAuthorizationResolved,
    ),
    pendingRunAuthorization,
    grantWriteAccess,
    keepProjectReadOnly,
    grantRunAuthorization: () => resolveRunAuthorization(true),
    denyRunAuthorization: () => resolveRunAuthorization(false),
  };
}

async function runDelegatedCanvasMutation<T>(
  bootstrap: WebCanvasBootstrap,
  actionId: string,
  isSessionActive: () => boolean,
  operation: () => T | Promise<T>,
): Promise<T> {
  return runtimeProjectClient.withCodexDelegation({
    actionId,
    createToken: async () => (
      await requestWebCanvasDelegation(bootstrap, actionId)
    ).token,
  }, async () => {
    const result = await operation();
    if (!isSessionActive()) {
      throw new CanvasActionStaleError('canvas_disconnected');
    }
    const project = useProjectStore.getState().getCurrentProject();
    if (!project) {
      throw new CanvasActionStaleError('project_changed');
    }
    const canvas = useCanvasStore.getState();
    await useProjectStore.getState().saveCurrentProject(
      canvas.nodes,
      canvas.edges,
      canvas.currentViewport,
      canvas.history,
      { immediate: true },
    );
    return result;
  });
}

function readCurrentCanvasSnapshot(
  excludedNodeIds: ReadonlySet<string> = new Set(),
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

function assertCanvasActionCurrent(
  projectId: string,
  requiresWrite: boolean,
  hasWriteAccess: boolean,
  isSessionActive: () => boolean,
): void {
  if (!isSessionActive()) {
    throw new CanvasActionStaleError('canvas_disconnected');
  }
  const projectState = useProjectStore.getState();
  const latest = readCurrentCanvasSnapshot();
  if (!latest || latest.projectId !== projectId) {
    throw new CanvasActionStaleError('project_changed');
  }
  if (requiresWrite && !hasWriteAccess) {
    throw new CanvasActionStaleError('project_write_not_authorized');
  }
  if (requiresWrite && projectState.editorState.mode !== 'codex') {
    throw new CanvasActionStaleError('editor_lease_lost');
  }
}

function createCanvasActionGuard(
  projectId: string,
  hasWriteAccess: () => boolean,
  isSessionActive: () => boolean,
) {
  return (_newResultNodeIds: readonly string[] = []) => {
    if (!isSessionActive()) {
      throw new CanvasActionStaleError('canvas_disconnected');
    }
    const latest = readCurrentCanvasSnapshot();
    if (!latest || latest.projectId !== projectId) {
      throw new CanvasActionStaleError('project_changed');
    }
    if (
      useProjectStore.getState().editorState.mode !== 'codex'
      || !hasWriteAccess()
    ) {
      throw new CanvasActionStaleError('project_write_not_authorized');
    }
  };
}

class CanvasActionAuthorizationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CanvasActionAuthorizationError';
  }
}

class CanvasActionStaleError extends Error {
  constructor(reason = 'canvas_changed') {
    super(reason);
    this.name = 'CanvasActionStaleError';
  }
}

function readSubmittedGenerationNodeIds(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { runs?: unknown }).runs)) {
    return [];
  }
  return (value as { runs: unknown[] }).runs.flatMap((run) => {
    if (!run || typeof run !== 'object' || (run as { status?: unknown }).status !== 'started') {
      return [];
    }
    const submissions = (run as { submissions?: unknown }).submissions;
    if (!Array.isArray(submissions)) {
      return [];
    }
    return submissions.flatMap((submission) => {
      if (
        !submission
        || typeof submission !== 'object'
        || (submission as { status?: unknown }).status !== 'submitted'
      ) {
        return [];
      }
      const resultNodeId = (submission as { resultNodeId?: unknown }).resultNodeId;
      return typeof resultNodeId === 'string' && resultNodeId.length > 0 ? [resultNodeId] : [];
    });
  });
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
