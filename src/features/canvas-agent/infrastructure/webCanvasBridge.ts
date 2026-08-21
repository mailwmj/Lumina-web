import {
  WEB_CANVAS_CAPABILITIES,
  WEB_CANVAS_PROTOCOL,
} from '@/features/canvas-agent/application/webCanvasProtocol';
import type { CanvasAgentSnapshot } from '@/features/canvas-agent/domain/types';
import type { WebCanvasBootstrap } from './webCanvasBootstrap';

const REQUEST_TIMEOUT_MS = 5_000;

export interface WebCanvasEvent {
  type: string;
  payload: unknown;
}

interface WebCanvasTerminalResult {
  proposalId?: string;
  actionId?: string;
  status: 'applied' | 'stale' | 'failed';
  result?: unknown;
  error?: string;
}

export async function connectWebCanvasBridge(bootstrap: WebCanvasBootstrap): Promise<void> {
  await postWebCanvasBridge(bootstrap, '/v1/connect', {
    sessionId: bootstrap.sessionId,
    protocol: WEB_CANVAS_PROTOCOL,
    capabilities: WEB_CANVAS_CAPABILITIES,
  });
}

export async function publishWebCanvasSnapshot(
  bootstrap: WebCanvasBootstrap,
  snapshot: CanvasAgentSnapshot,
  options: { includeSelectedImagePreviews: boolean },
): Promise<void> {
  const value = options.includeSelectedImagePreviews
    ? snapshot
    : omitSelectedImagePreviews(snapshot);
  await postWebCanvasBridge(bootstrap, '/v1/state', {
    ...value,
    sessionId: bootstrap.sessionId,
  });
}

export async function postWebCanvasProposalResult(
  bootstrap: WebCanvasBootstrap,
  result: WebCanvasTerminalResult & { proposalId: string },
): Promise<void> {
  await postWebCanvasBridge(bootstrap, '/v1/result', {
    ...result,
    sessionId: bootstrap.sessionId,
  });
}

export async function postWebCanvasActionResult(
  bootstrap: WebCanvasBootstrap,
  result: WebCanvasTerminalResult & { actionId: string },
): Promise<void> {
  await postWebCanvasBridge(bootstrap, '/v1/action-result', {
    ...result,
    sessionId: bootstrap.sessionId,
  });
}

export async function disconnectWebCanvasBridge(bootstrap: WebCanvasBootstrap): Promise<void> {
  await postWebCanvasBridge(bootstrap, '/v1/disconnect', { sessionId: bootstrap.sessionId });
}

export async function consumeWebCanvasEvents(
  bootstrap: WebCanvasBootstrap,
  signal: AbortSignal,
  callbacks: {
    onOpen: () => void;
    onEvent: (event: WebCanvasEvent) => void;
  },
): Promise<void> {
  const response = await fetch(
    `${bootstrap.endpoint}/v1/events?sessionId=${encodeURIComponent(bootstrap.sessionId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bootstrap.token}`,
        Accept: 'text/event-stream',
      },
      cache: 'no-store',
      signal,
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Lumina canvas bridge event stream failed with status ${response.status}.`);
  }
  callbacks.onOpen();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const event = parseEventBlock(block);
      if (event) {
        callbacks.onEvent(event);
      }
      separatorIndex = buffer.indexOf('\n\n');
    }
  }
}

async function postWebCanvasBridge(
  bootstrap: WebCanvasBootstrap,
  path: string,
  body: unknown,
): Promise<void> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
    globalThis.clearTimeout(timeout);
  }
}

function omitSelectedImagePreviews(
  snapshot: CanvasAgentSnapshot,
): Omit<CanvasAgentSnapshot, 'selectedImagePreviews'> {
  const { selectedImagePreviews: _selectedImagePreviews, ...rest } = snapshot;
  return rest;
}

function parseEventBlock(block: string): WebCanvasEvent | null {
  let type = 'message';
  const dataLines: string[] = [];
  block.split('\n').forEach((line) => {
    if (line.startsWith('event:')) {
      type = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  });
  if (dataLines.length === 0) {
    return null;
  }
  const data = dataLines.join('\n');
  try {
    return { type, payload: JSON.parse(data) as unknown };
  } catch {
    return { type, payload: data };
  }
}
