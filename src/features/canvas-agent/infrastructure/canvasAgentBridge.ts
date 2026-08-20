import type { CanvasAgentSnapshot } from '@/features/canvas-agent/domain/types';
import {
  normalizeExternalAgentUrl,
  type ExternalAgentConnectionConfig,
} from '@/stores/settingsStore';

export interface CanvasAgentEndpoint {
  url: string;
  token: string;
}

export interface CanvasAgentEvent {
  type: string;
  payload: unknown;
}

const REQUEST_TIMEOUT_MS = 5_000;
const PROPOSAL_RESULT_RETRY_DELAYS_MS = [0, 200, 600] as const;

export function resolveCanvasAgentEndpoint(
  config: ExternalAgentConnectionConfig
): CanvasAgentEndpoint | null {
  if (!config.enabled || !config.token.trim()) {
    return null;
  }
  const url = normalizeExternalAgentUrl(config.url);
  if (!url) {
    return null;
  }
  return {
    url,
    token: config.token.trim(),
  };
}

export async function postCanvasAgentSnapshot(
  endpoint: CanvasAgentEndpoint,
  clientId: string,
  snapshot: CanvasAgentSnapshot,
  options: { includeSelectedImagePreviews: boolean }
): Promise<void> {
  const body = options.includeSelectedImagePreviews
    ? snapshot
    : omitSelectedImagePreviews(snapshot);
  await postJson(endpoint, `/canvas/state?clientId=${encodeURIComponent(clientId)}`, body);
}

export async function postCanvasProposalResult(
  endpoint: CanvasAgentEndpoint,
  clientId: string,
  body: {
    proposalId: string;
    status: 'applied' | 'stale' | 'failed';
    result?: unknown;
    error?: string;
  }
): Promise<void> {
  let lastError: unknown;
  for (const delayMs of PROPOSAL_RESULT_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await delay(delayMs);
    }
    try {
      await postJson(endpoint, `/canvas/result?clientId=${encodeURIComponent(clientId)}`, body);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function postCanvasActionResult(
  endpoint: CanvasAgentEndpoint,
  clientId: string,
  body: {
    actionId: string;
    status: 'applied' | 'stale' | 'failed';
    result?: unknown;
    error?: string;
  }
): Promise<void> {
  let lastError: unknown;
  for (const delayMs of PROPOSAL_RESULT_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await delay(delayMs);
    }
    try {
      await postJson(endpoint, `/canvas/action-result?clientId=${encodeURIComponent(clientId)}`, body);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function consumeCanvasAgentEvents(
  endpoint: CanvasAgentEndpoint,
  clientId: string,
  signal: AbortSignal,
  callbacks: {
    onOpen: () => void;
    onEvent: (event: CanvasAgentEvent) => void;
  }
): Promise<void> {
  const response = await fetch(
    `${endpoint.url}/events?clientId=${encodeURIComponent(clientId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        Accept: 'text/event-stream',
      },
      cache: 'no-store',
      signal,
    }
  );
  if (!response.ok || !response.body) {
    throw new Error(`Canvas Agent event stream failed with status ${response.status}.`);
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

async function postJson(
  endpoint: CanvasAgentEndpoint,
  path: string,
  body: unknown
): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${endpoint.url}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Canvas Agent request failed with status ${response.status}.`);
    }
  } finally {
    window.clearTimeout(timeout);
  }
}

function parseEventBlock(block: string): CanvasAgentEvent | null {
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

function omitSelectedImagePreviews(
  snapshot: CanvasAgentSnapshot
): Omit<CanvasAgentSnapshot, 'selectedImagePreviews'> {
  const { selectedImagePreviews: _selectedImagePreviews, ...rest } = snapshot;
  return rest;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
