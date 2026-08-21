import { useEffect, useMemo, useRef } from 'react';

import { buildReadonlyCanvasSnapshot } from '@/features/canvas-agent/application/readonlyCanvasSnapshot';
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
  const snapshot = useMemo(() => buildReadonlyCanvasSnapshot(input), [
    input.projectId,
    input.projectName,
    input.projectRevision,
    input.nodes,
    input.edges,
    input.selectedNodeIds,
    input.viewport,
  ]);
  const snapshotRef = useRef(snapshot);
  const bootstrapRef = useRef<ReadonlyCanvasBootstrap | null>(null);
  const connectionRef = useRef<Promise<void> | null>(null);
  const connectedProjectIdRef = useRef<string | null>(null);
  const disconnectTimerRef = useRef<number | null>(null);
  const snapshotPublisherRef = useRef<ReadonlyCanvasSnapshotPublisher | null>(null);
  if (!snapshotPublisherRef.current) {
    snapshotPublisherRef.current = new ReadonlyCanvasSnapshotPublisher((error) => {
      logger.debug('[CodexCanvas] Failed to publish read-only canvas snapshot', error);
    });
  }
  snapshotRef.current = snapshot;

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
    const publish = () => {
      if (!bootstrapRef.current || disconnected) {
        return;
      }
      snapshotPublisherRef.current?.enqueue(bootstrapRef.current, snapshotRef.current);
    };
    connectionRef.current ??= connectReadonlyCanvasBridge(bootstrap);
    void connectionRef.current
      .then(publish)
      .catch((error) => logger.debug('[CodexCanvas] Failed to connect read-only canvas bridge', error));
    const heartbeat = window.setInterval(publish, SNAPSHOT_HEARTBEAT_MS);
    return () => {
      disconnected = true;
      window.clearInterval(heartbeat);
      const disconnectTimer = window.setTimeout(() => {
        if (disconnectTimerRef.current !== disconnectTimer) {
          return;
        }
        disconnectTimerRef.current = null;
        snapshotPublisherRef.current?.clear();
        bootstrapRef.current = null;
        connectionRef.current = null;
        connectedProjectIdRef.current = null;
        clearCapturedReadonlyCanvasBootstrap(bootstrap);
        void disconnectReadonlyCanvasBridge(bootstrap);
      }, 0);
      disconnectTimerRef.current = disconnectTimer;
    };
  }, [input.projectId]);

  useEffect(() => {
    const bootstrap = bootstrapRef.current;
    if (bootstrap && connectedProjectIdRef.current === input.projectId && input.projectRevision) {
      snapshotPublisherRef.current?.enqueue(bootstrap, snapshot);
    }
  }, [snapshot]);
}
