import { useCallback, useEffect, useRef } from 'react';

import {
  buildReadonlyCanvasSnapshot,
  type ReadonlyCanvasSnapshot,
} from '@/features/canvas-agent/application/readonlyCanvasSnapshot';
import {
  connectReadonlyCanvasBridge,
  disconnectReadonlyCanvasBridge,
} from '@/features/canvas-agent/infrastructure/readonlyCanvasBridge';
import {
  clearCapturedReadonlyCanvasBootstrap,
  getCapturedReadonlyCanvasBootstrap,
  type ReadonlyCanvasBootstrap,
} from '@/features/canvas-agent/infrastructure/readonlyCanvasBootstrap';
import { ReadonlyCanvasSnapshotPublisher } from '@/features/canvas-agent/infrastructure/readonlyCanvasSnapshotPublisher';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { Viewport } from '@xyflow/react';
import { logger } from '@/lib/logger';

const SNAPSHOT_HEARTBEAT_MS = 5_000;
const SNAPSHOT_PUBLISH_DELAY_MS = 100;

interface UseReadonlyCanvasBridgeInput {
  projectId: string;
  projectName: string;
  projectRevision: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeIds: string[];
  viewport: Viewport;
}

export function useReadonlyCanvasBridge(input: UseReadonlyCanvasBridgeInput): void {
  const capturedBootstrap = getCapturedReadonlyCanvasBootstrap();
  const canBuildSnapshot = Boolean(
    capturedBootstrap
      && input.projectId
      && input.projectRevision
      && capturedBootstrap.expiresAt > Date.now(),
  );
  const snapshotInputRef = useRef(input);
  snapshotInputRef.current = input;
  const snapshotRef = useRef<ReadonlyCanvasSnapshot | null>(null);
  const bootstrapRef = useRef<ReadonlyCanvasBootstrap | null>(null);
  const connectionRef = useRef<Promise<void> | null>(null);
  const connectedProjectIdRef = useRef<string | null>(null);
  const bridgeConnectedRef = useRef(false);
  const disconnectTimerRef = useRef<number | null>(null);
  const snapshotBuildTimerRef = useRef<number | null>(null);
  const snapshotPublisherRef = useRef<ReadonlyCanvasSnapshotPublisher | null>(null);
  if (!snapshotPublisherRef.current) {
    snapshotPublisherRef.current = new ReadonlyCanvasSnapshotPublisher((error) => {
      logger.debug('[CodexCanvas] Failed to publish read-only canvas snapshot', error);
    });
  }

  const publishLatestSnapshot = useCallback(() => {
    const bootstrap = bootstrapRef.current;
    const latestInput = snapshotInputRef.current;
    if (
      !bootstrap
      || !bridgeConnectedRef.current
      || connectedProjectIdRef.current !== latestInput.projectId
      || !latestInput.projectRevision
    ) {
      return;
    }
    const snapshot = buildReadonlyCanvasSnapshot(latestInput);
    snapshotRef.current = snapshot;
    snapshotPublisherRef.current?.enqueue(bootstrap, snapshot);
  }, []);

  const publishHeartbeat = useCallback(() => {
    const bootstrap = bootstrapRef.current;
    const snapshot = snapshotRef.current;
    if (bootstrap && snapshot && bridgeConnectedRef.current) {
      snapshotPublisherRef.current?.enqueue(bootstrap, snapshot);
    }
  }, []);

  const clearScheduledSnapshotBuild = useCallback(() => {
    if (snapshotBuildTimerRef.current !== null) {
      window.clearTimeout(snapshotBuildTimerRef.current);
      snapshotBuildTimerRef.current = null;
    }
  }, []);

  const scheduleSnapshotBuild = useCallback(() => {
    clearScheduledSnapshotBuild();
    snapshotBuildTimerRef.current = window.setTimeout(() => {
      snapshotBuildTimerRef.current = null;
      publishLatestSnapshot();
    }, SNAPSHOT_PUBLISH_DELAY_MS);
  }, [clearScheduledSnapshotBuild, publishLatestSnapshot]);

  useEffect(() => {
    const sameProject = connectedProjectIdRef.current === input.projectId;
    if (disconnectTimerRef.current !== null && sameProject) {
      window.clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    if (!bootstrapRef.current) {
      bootstrapRef.current = getCapturedReadonlyCanvasBootstrap();
    }
    const bootstrap = bootstrapRef.current;
    if (!bootstrap || !input.projectId || !input.projectRevision || bootstrap.expiresAt <= Date.now()) {
      return;
    }
    if (connectedProjectIdRef.current && connectedProjectIdRef.current !== input.projectId) {
      return;
    }
    bootstrapRef.current = bootstrap;
    connectedProjectIdRef.current = input.projectId;
    let disconnected = false;
    connectionRef.current ??= connectReadonlyCanvasBridge(bootstrap);
    void connectionRef.current
      .then(() => {
        if (disconnected || bridgeConnectedRef.current || bootstrapRef.current !== bootstrap) {
          return;
        }
        bridgeConnectedRef.current = true;
        publishLatestSnapshot();
      })
      .catch((error) => logger.debug('[CodexCanvas] Failed to connect read-only canvas bridge', error));
    const heartbeat = window.setInterval(publishHeartbeat, SNAPSHOT_HEARTBEAT_MS);
    return () => {
      disconnected = true;
      window.clearInterval(heartbeat);
      const disconnectTimer = window.setTimeout(() => {
        if (disconnectTimerRef.current !== disconnectTimer) {
          return;
        }
        disconnectTimerRef.current = null;
        snapshotPublisherRef.current?.clear();
        clearScheduledSnapshotBuild();
        bootstrapRef.current = null;
        connectionRef.current = null;
        connectedProjectIdRef.current = null;
        bridgeConnectedRef.current = false;
        snapshotRef.current = null;
        clearCapturedReadonlyCanvasBootstrap(bootstrap);
        void disconnectReadonlyCanvasBridge(bootstrap);
      }, 0);
      disconnectTimerRef.current = disconnectTimer;
    };
  }, [clearScheduledSnapshotBuild, input.projectId, publishHeartbeat, publishLatestSnapshot]);

  useEffect(() => {
    if (!canBuildSnapshot || !bridgeConnectedRef.current) {
      return;
    }
    scheduleSnapshotBuild();
    return clearScheduledSnapshotBuild;
  }, [
    canBuildSnapshot,
    clearScheduledSnapshotBuild,
    input.projectId,
    input.projectName,
    input.projectRevision,
    input.nodes,
    input.edges,
    input.selectedNodeIds,
    input.viewport,
    scheduleSnapshotBuild,
  ]);
}
