import { useEffect, useMemo, useRef } from 'react';

import { buildReadonlyCanvasSnapshot } from '@/features/canvas-agent/application/readonlyCanvasSnapshot';
import {
  connectReadonlyCanvasBridge,
  disconnectReadonlyCanvasBridge,
  publishReadonlyCanvasSnapshot,
} from '@/features/canvas-agent/infrastructure/readonlyCanvasBridge';
import {
  consumeReadonlyCanvasBootstrap,
  type ReadonlyCanvasBootstrap,
} from '@/features/canvas-agent/infrastructure/readonlyCanvasBootstrap';
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
  snapshotRef.current = snapshot;

  useEffect(() => {
    if (!bootstrapRef.current) {
      bootstrapRef.current = consumeReadonlyCanvasBootstrap(window.location, window.history);
    }
    const bootstrap = bootstrapRef.current;
    if (!bootstrap || !input.projectId || !input.projectRevision || bootstrap.expiresAt <= Date.now()) {
      return;
    }
    bootstrapRef.current = bootstrap;
    let disconnected = false;
    const publish = async () => {
      if (!bootstrapRef.current || disconnected) {
        return;
      }
      try {
        await publishReadonlyCanvasSnapshot(bootstrapRef.current, snapshotRef.current);
      } catch (error) {
        logger.debug('[CodexCanvas] Failed to publish read-only canvas snapshot', error);
      }
    };
    void connectReadonlyCanvasBridge(bootstrap)
      .then(publish)
      .catch((error) => logger.debug('[CodexCanvas] Failed to connect read-only canvas bridge', error));
    const heartbeat = window.setInterval(() => void publish(), SNAPSHOT_HEARTBEAT_MS);
    return () => {
      disconnected = true;
      window.clearInterval(heartbeat);
      bootstrapRef.current = null;
      void disconnectReadonlyCanvasBridge(bootstrap);
    };
  }, [input.projectId]);

  useEffect(() => {
    const bootstrap = bootstrapRef.current;
    if (bootstrap && input.projectId && input.projectRevision) {
      void publishReadonlyCanvasSnapshot(bootstrap, snapshot).catch((error) => {
        logger.debug('[CodexCanvas] Failed to update read-only canvas snapshot', error);
      });
    }
  }, [snapshot]);
}
