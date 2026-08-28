import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Viewport } from '@xyflow/react';

import { runImageGenerationNodes } from '@/features/canvas/application/imageGenerationRun';
import { runVideoGenerationNodes } from '@/features/canvas/application/videoGenerationRun';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { buildCanvasAgentNodeImages } from '@/features/canvas-agent/application/canvasAgentNodeImages';
import { buildCanvasAgentVideoResults } from '@/features/canvas-agent/application/canvasAgentVideoResults';
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
  kind: 'image' | 'video';
  nodeIds: string[];
}

export type PendingCodexProjectAuthorization = {
  actionId: string;
  type: 'create_project';
  name: string;
} | {
  actionId: string;
  type: 'open_project';
  projectId: string;
};

export interface CodexWebCanvasBridgeState {
  isWriteAuthorizationPending: boolean;
  pendingProjectAuthorization: PendingCodexProjectAuthorization | null;
  pendingRunAuthorization: PendingCodexRunAuthorization | null;
  grantWriteAccess(): Promise<void>;
  keepProjectReadOnly(): void;
  grantProjectAuthorization(): void;
  denyProjectAuthorization(): void;
  grantRunAuthorization(): void;
  denyRunAuthorization(): void;
}

interface PendingRunAuthorization extends PendingCodexRunAuthorization {
  resolve: (allowed: boolean) => void;
}

type PendingProjectAuthorization = PendingCodexProjectAuthorization & {
  resolve: (allowed: boolean) => void;
};

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
  const pendingProjectRef = useRef<PendingProjectAuthorization | null>(null);
  const [pendingProjectAuthorization, setPendingProjectAuthorization] = useState<PendingCodexProjectAuthorization | null>(null);
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
  const expectedProjectRebindRef = useRef<{ actionId: string; projectId: string | null } | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const sessionGenerationRef = useRef(0);
  const stopActiveSessionRef = useRef<(() => void) | null>(null);
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
    kind: 'image' | 'video',
  ): Promise<boolean> => new Promise((resolve) => {
    if (pendingRunRef.current) {
      resolve(false);
      return;
    }
    pendingRunRef.current = { actionId, nodeIds, kind, resolve };
    setPendingRunAuthorization({ actionId, nodeIds, kind });
  }), []);

  const resolveProjectAuthorization = useCallback((allowed: boolean) => {
    const pending = pendingProjectRef.current;
    if (!pending) {
      return;
    }
    pendingProjectRef.current = null;
    setPendingProjectAuthorization(null);
    pending.resolve(allowed);
  }, []);

  const requestProjectAuthorization = useCallback((
    authorization: PendingCodexProjectAuthorization,
  ): Promise<boolean> => new Promise((resolve) => {
    if (pendingProjectRef.current) {
      resolve(false);
      return;
    }
    pendingProjectRef.current = { ...authorization, resolve };
    setPendingProjectAuthorization(authorization);
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
      const request = action.request;
      if (request.type === 'list_projects') {
        await reportAction(bootstrap, action.actionId, 'applied', {
          projects: useProjectStore.getState().projects.map(toSafeProjectSummary),
        });
        return;
      }
      if (request.type === 'create_project' || request.type === 'open_project') {
        const authorization: PendingCodexProjectAuthorization = request.type === 'create_project'
          ? { actionId: action.actionId, type: 'create_project', name: request.name }
          : { actionId: action.actionId, type: 'open_project', projectId: request.projectId };
        const allowed = await requestProjectAuthorization(authorization);
        if (!allowed) {
          throw new CanvasActionAuthorizationError('project_action_not_authorized');
        }
        expectedProjectRebindRef.current = {
          actionId: action.actionId,
          projectId: request.type === 'open_project' ? request.projectId : null,
        };
        try {
          const project = request.type === 'create_project'
            ? await createCanvasAgentProject(request.name)
            : await openCanvasAgentProject(request.projectId);
          expectedProjectRebindRef.current = { actionId: action.actionId, projectId: project.id };
          if (isSessionActive()) {
            await reportAction(bootstrap, action.actionId, 'applied', {
              project: toSafeProjectSummary(project),
            });
          }
          return;
        } catch (error) {
          expectedProjectRebindRef.current = null;
          throw error;
        }
      }
      const requiresWrite = request.type !== 'get_node_images'
        && request.type !== 'get_video_results';
      assertCanvasActionCurrent(
        request.projectId,
        requiresWrite,
        writeAccessRef.current,
        isSessionActive,
      );

      let result: unknown;
      if (request.type === 'get_node_images') {
        result = await buildCanvasAgentNodeImages({
          projectId: request.projectId,
          nodeIds: request.nodeIds,
          maxDimension: request.maxDimension,
        });
      } else if (request.type === 'get_video_results') {
        result = await buildCanvasAgentVideoResults({
          projectId: request.projectId,
          nodeIds: request.nodeIds,
          maxDimension: request.maxDimension,
        });
      } else {
        result = await runDelegatedCanvasMutation(
          bootstrap,
          action.actionId,
          isSessionActive,
          async () => {
            if (request.type === 'import_images') {
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

            const runKind = request.type === 'run_video_nodes' ? 'video' : 'image';
            const allowed = await requestRunAuthorization(
              action.actionId,
              request.nodeIds,
              runKind,
            );
            if (!allowed) {
              throw new CanvasActionAuthorizationError('run_not_authorized');
            }
            assertCanvasActionCurrent(
              request.projectId,
              true,
              writeAccessRef.current,
              isSessionActive,
            );
            const runNodes = request.type === 'run_video_nodes'
              ? runVideoGenerationNodes
              : runImageGenerationNodes;
            const generationResult = await runNodes(request.nodeIds, {
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
  }, [reportAction, requestProjectAuthorization, requestRunAuthorization]);

  useEffect(() => {
    const currentProjectId = projectIdRef.current;
    if (
      disconnectTimerRef.current !== null
      && (boundProjectIdRef.current === null || boundProjectIdRef.current === currentProjectId)
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
    boundProjectIdRef.current = currentProjectId;
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
      resolveProjectAuthorization(false);
      expectedProjectRebindRef.current = null;
      if (bootstrapRef.current === bootstrap) {
        bootstrapRef.current = null;
        clearCapturedWebCanvasBootstrap(bootstrap);
      }
      if (bridgeConnectRef.current?.bootstrap === bootstrap) {
        bridgeConnectRef.current = null;
      }
      boundProjectIdRef.current = null;
      stopActiveSessionRef.current = null;
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
    const stopSession = () => {
      if (!active) {
        return;
      }
      active = false;
      if (stopActiveSessionRef.current === stopSession) {
        stopActiveSessionRef.current = null;
      }
      invalidateCanvasGenerationMutationAuthorities(bootstrap.sessionId);
      if (sessionGenerationRef.current === generation) {
        sessionGenerationRef.current += 1;
      }
      controller.abort();
      connectedRef.current = false;
      setIsConnected(false);
      resolveRunAuthorization(false);
      resolveProjectAuthorization(false);
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
    stopActiveSessionRef.current = stopSession;
    void connect();
    return stopSession;
  }, [
    handleActionEvent,
    handleProposalEvent,
    isActiveBootstrap,
    resolveRunAuthorization,
    resolveProjectAuthorization,
  ]);

  useEffect(() => {
    const boundProjectId = boundProjectIdRef.current;
    if (boundProjectId === projectId) {
      return;
    }
    const expectedRebind = expectedProjectRebindRef.current;
    if (
      expectedRebind
      && projectId
      && expectedRebind.projectId === projectId
    ) {
      boundProjectIdRef.current = projectId;
      expectedProjectRebindRef.current = null;
      return;
    }
    if (boundProjectId === null && projectId !== null && bootstrapRef.current) {
      boundProjectIdRef.current = projectId;
      return;
    }
    stopActiveSessionRef.current?.();
  }, [projectId]);

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
      await runtimeProjectClient.handoffToCodex(project.id, bootstrap.sessionId);
      handedOff = true;
      await enableWebCanvasCodexEditing(bootstrap);
      writeAccessRef.current = true;
      setWriteAccess(true);
      setWriteAuthorizationResolved(true);
    } catch (error) {
      if (handedOff) {
        await runtimeProjectClient.abortCodexHandoff(project.id, bootstrap.sessionId).catch((abortError) => {
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
      && pendingProjectAuthorization === null
      && !writeAuthorizationResolved,
    ),
    pendingProjectAuthorization,
    pendingRunAuthorization,
    grantWriteAccess,
    keepProjectReadOnly,
    grantProjectAuthorization: () => resolveProjectAuthorization(true),
    denyProjectAuthorization: () => resolveProjectAuthorization(false),
    grantRunAuthorization: () => resolveRunAuthorization(true),
    denyRunAuthorization: () => resolveRunAuthorization(false),
  };
}

async function createCanvasAgentProject(name: string) {
  const projectId = await useProjectStore.getState().createProjectPersisted(name);
  const project = useProjectStore.getState().getCurrentProject();
  if (!projectId || !project || project.id !== projectId) {
    throw new CanvasActionStaleError('project_create_failed');
  }
  useCanvasStore.getState().setCanvasData([], [], { past: [], future: [] });
  return project;
}

async function openCanvasAgentProject(projectId: string) {
  const project = await useProjectStore.getState().openProjectAndWait(projectId);
  if (!project || project.id !== projectId) {
    throw new CanvasActionStaleError('project_not_found');
  }
  useCanvasStore.getState().setCanvasData(project.nodes, project.edges, project.history);
  return project;
}

function toSafeProjectSummary(project: {
  id: string;
  name: string;
  createdAt?: number;
  updatedAt?: number;
  nodeCount?: number;
}) {
  return {
    id: project.id,
    name: project.name,
    ...(typeof project.createdAt === 'number' ? { createdAt: project.createdAt } : {}),
    ...(typeof project.updatedAt === 'number' ? { updatedAt: project.updatedAt } : {}),
    nodeCount: typeof project.nodeCount === 'number' ? project.nodeCount : 0,
  };
}

async function runDelegatedCanvasMutation<T>(
  bootstrap: WebCanvasBootstrap,
  actionId: string,
  isSessionActive: () => boolean,
  operation: () => T | Promise<T>,
): Promise<T> {
  const initialProject = useProjectStore.getState().getCurrentProject();
  if (!initialProject) {
    throw new CanvasActionStaleError('project_changed');
  }
  return runtimeProjectClient.withCodexDelegation({
    projectId: initialProject.id,
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
  if (
    requiresWrite
    && (
      projectState.editorState.mode !== 'codex'
      || projectState.editorState.projectId !== projectId
    )
  ) {
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
      || useProjectStore.getState().editorState.projectId !== projectId
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
    const directResultNodeId = (run as { resultNodeId?: unknown }).resultNodeId;
    if (typeof directResultNodeId === 'string' && directResultNodeId.length > 0) {
      return [directResultNodeId];
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
