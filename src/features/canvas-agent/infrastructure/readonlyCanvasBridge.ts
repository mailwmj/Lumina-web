import {
  READONLY_CANVAS_CAPABILITIES,
  READONLY_CANVAS_PROTOCOL,
  type ReadonlyCanvasSnapshot,
} from '@/features/canvas-agent/application/readonlyCanvasSnapshot';
import type { ReadonlyCanvasBootstrap } from './readonlyCanvasBootstrap';

const REQUEST_TIMEOUT_MS = 5_000;

export async function connectReadonlyCanvasBridge(bootstrap: ReadonlyCanvasBootstrap): Promise<void> {
  await postReadonlyCanvasBridge(bootstrap, '/v1/connect', {
    sessionId: bootstrap.sessionId,
    protocol: READONLY_CANVAS_PROTOCOL,
    capabilities: READONLY_CANVAS_CAPABILITIES,
  });
}

export async function publishReadonlyCanvasSnapshot(
  bootstrap: ReadonlyCanvasBootstrap,
  snapshot: ReadonlyCanvasSnapshot,
): Promise<void> {
  await postReadonlyCanvasBridge(bootstrap, '/v1/state', {
    ...snapshot,
    sessionId: bootstrap.sessionId,
  });
}

export async function disconnectReadonlyCanvasBridge(bootstrap: ReadonlyCanvasBootstrap): Promise<void> {
  await postReadonlyCanvasBridge(bootstrap, '/v1/disconnect', { sessionId: bootstrap.sessionId });
}

async function postReadonlyCanvasBridge(
  bootstrap: ReadonlyCanvasBootstrap,
  path: string,
  body: unknown,
): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${bootstrap.endpoint}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bootstrap.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Lumina canvas bridge request failed with status ${response.status}.`);
    }
  } finally {
    window.clearTimeout(timeout);
  }
}
