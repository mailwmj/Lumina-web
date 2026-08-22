import process from 'node:process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ZodError } from 'zod';

import {
  CanvasAgentError,
  canvasAgentToolDescriptions,
  canvasAgentToolNames,
  canvasAgentToolSchemas,
  type CanvasAgentErrorPayload,
  type CanvasAgentToolName,
} from '../canvas/protocol.js';
import type { WebCanvasSession } from './session.js';

interface WebCanvasMcpRuntime {
  ensureOpen(): ReturnType<WebCanvasSession['ensureOpen']>;
  session: WebCanvasSession;
  close(): Promise<void>;
}

const EMPTY_INPUT = canvasAgentToolSchemas.canvas_get_state;

const WEB_MCP_INSTRUCTIONS = [
  'Lumina Canvas exposes only the project currently open in the browser.',
  'Call canvas_open. When its status is awaiting_browser, open or focus the returned URL in the user\'s connected Chrome exactly as returned.',
  'When Chrome is not connected, ask the user to connect Chrome and stop. Do not create an isolated browser project.',
  'When canvas_open reports awaiting_project, select a project in the connected Chrome before reading state or requesting a change.',
  'Read state once before a change and reuse its projectId and revision.',
  'The project is read-only until the browser owner enables bounded non-billing writes for this session.',
  'Use one canvas_propose_changes for each atomic setup phase. Deletion, credentials, arbitrary files, and arbitrary result-node creation are unavailable.',
  'Import only user-provided HTTPS or raster data images. Never request local paths or file URLs.',
  'canvas_run_nodes always requires a separate current browser authorization after the setup is visible.',
  'Use canvas_wait_for_nodes and canvas_get_node_images for compact progress and selected result previews.',
  'After a disconnect, timeout, token rotation, or stale revision, do not replay a write or generation request.',
].join(' ');

export async function startWebMcpServer(
  companion: WebCanvasMcpRuntime,
  onClose?: () => void | Promise<void>,
): Promise<void> {
  const server = new McpServer(
    { name: 'lumina-canvas', version: '0.2.0' },
    { instructions: WEB_MCP_INSTRUCTIONS },
  );
  server.registerTool('canvas_open', {
    description: 'Open or inspect the canonical Lumina canvas bridge without rotating an active browser session.',
    inputSchema: EMPTY_INPUT.shape,
  }, async () => ({ content: [textContent(createOpenResult(companion))] }));
  canvasAgentToolNames.forEach((name) => registerTool(server, companion, name));

  const transport = new StdioServerTransport();
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;
  const closeSession = () => {
    closePromise ??= (async () => {
      try {
        await companion.close();
      } catch {
        // Closing stdio must still release the installed runtime.
      }
      try {
        await onClose?.();
      } catch {
        // The MCP transport has already closed, so cleanup errors cannot be reported.
      }
      resolveClosed?.();
    })();
    return closePromise;
  };
  const closeTransport = () => {
    void transport.close().catch(() => {});
  };
  transport.onclose = () => {
    process.stdin.off('end', closeTransport);
    process.stdin.off('close', closeTransport);
    void closeSession();
  };
  process.stdin.once('end', closeTransport);
  process.stdin.once('close', closeTransport);
  await server.connect(transport);
  await closed;
}

function registerTool(
  server: McpServer,
  companion: WebCanvasMcpRuntime,
  name: CanvasAgentToolName,
): void {
  const schema = canvasAgentToolSchemas[name];
  server.registerTool(name, {
    description: canvasAgentToolDescriptions[name],
    inputSchema: schema.shape,
  }, async (rawInput: unknown) => {
    try {
      const input = schema.parse(rawInput);
      const result = await companion.session.callTool(name, input);
      return { content: toMcpContent(result) };
    } catch (error) {
      return {
        isError: true,
        content: [textContent({ ok: false, error: toErrorPayload(error) })],
      };
    }
  });
}

function createOpenResult(companion: WebCanvasMcpRuntime): Exclude<ReturnType<WebCanvasMcpRuntime['ensureOpen']>, {
  status: 'awaiting_browser';
}> | {
  status: 'awaiting_browser';
  canonicalOrigin: string;
  url: string;
  expiresAt: number;
} {
  const opened = companion.ensureOpen();
  if (opened.status !== 'awaiting_browser') {
    return opened;
  }
  const { bootstrap } = opened;
  const url = new URL(bootstrap.canonicalOrigin);
  url.hash = `lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`;
  return {
    status: 'awaiting_browser',
    canonicalOrigin: bootstrap.canonicalOrigin,
    url: url.toString(),
    expiresAt: bootstrap.expiresAt,
  };
}

type McpToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function toMcpContent(result: unknown): McpToolContent[] {
  const images: Array<{ data: string; mimeType: string }> = [];
  const metadata = stripImageDataUrls(result, images);
  return [
    textContent(metadata),
    ...images.map((image) => ({ type: 'image' as const, ...image })),
  ];
}

function stripImageDataUrls(
  value: unknown,
  images: Array<{ data: string; mimeType: string }>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripImageDataUrls(item, images));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : '';
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
  const metadata: Record<string, unknown> = {};
  Object.entries(record).forEach(([key, entry]) => {
    if (key === 'dataUrl' && match) {
      return;
    }
    metadata[key] = stripImageDataUrls(entry, images);
  });
  if (match) {
    images.push({
      mimeType: match[1],
      data: match[2].replace(/\s/g, ''),
    });
  }
  return metadata;
}

function toErrorPayload(error: unknown): CanvasAgentErrorPayload {
  if (error instanceof CanvasAgentError) {
    return error.toPayload();
  }
  if (error instanceof ZodError) {
    return {
      code: 'INVALID_ARGUMENTS',
      message: 'The MCP tool arguments are invalid.',
      details: error.issues,
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

function textContent(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: JSON.stringify(value, null, 2) };
}
