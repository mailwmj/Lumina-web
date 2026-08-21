import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { ReadonlyCanvasError, type ReadonlyCanvasSession } from './session.js';

interface ReadonlyCanvasMcpRuntime {
  issueBootstrap(): ReturnType<ReadonlyCanvasSession['issueBootstrap']>;
  session: ReadonlyCanvasSession;
  close(): Promise<void>;
}

const EMPTY_INPUT = z.object({}).strict();

const READONLY_MCP_INSTRUCTIONS = [
  'Lumina Canvas exposes only the project currently open in the browser.',
  'Call canvas_open, then open the returned canonical URL in the Codex in-app browser.',
  'The browser bridge is read-only. Never request writes, imports, generation, local files, credentials, or other projects.',
  'Use state, selection, and capabilities only after the browser has connected.',
].join(' ');

export async function startReadonlyMcpServer(
  companion: ReadonlyCanvasMcpRuntime,
  onClose?: () => void,
): Promise<void> {
  const server = new McpServer(
    { name: 'lumina-canvas', version: '0.1.0' },
    { instructions: READONLY_MCP_INSTRUCTIONS },
  );
  server.registerTool('canvas_open', {
    description: 'Open the canonical Lumina canvas origin and rotate its one-time browser bridge session.',
    inputSchema: EMPTY_INPUT.shape,
  }, async () => ({ content: [textContent(createOpenResult(companion))] }));
  server.registerTool('canvas_get_state', {
    description: 'Read the current project canvas state allowed by the browser bridge.',
    inputSchema: EMPTY_INPUT.shape,
  }, async () => readTool(() => companion.session.readState()));
  server.registerTool('canvas_get_selection', {
    description: 'Read selected node IDs from the currently open project.',
    inputSchema: EMPTY_INPUT.shape,
  }, async () => readTool(() => companion.session.readSelection()));
  server.registerTool('canvas_get_capabilities', {
    description: 'Read the capability intersection negotiated by the current browser session.',
    inputSchema: EMPTY_INPUT.shape,
  }, async () => readTool(() => companion.session.readCapabilities()));
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void companion.close().finally(onClose);
  };
  await server.connect(transport);
}

function createOpenResult(companion: ReadonlyCanvasMcpRuntime): {
  canonicalOrigin: string;
  url: string;
  expiresAt: number;
} {
  const bootstrap = companion.issueBootstrap();
  const url = new URL(bootstrap.canonicalOrigin);
  url.hash = `lumina-canvas=${encodeURIComponent(JSON.stringify(bootstrap))}`;
  return {
    canonicalOrigin: bootstrap.canonicalOrigin,
    url: url.toString(),
    expiresAt: bootstrap.expiresAt,
  };
}

function readTool(read: () => unknown) {
  try {
    return { content: [textContent(read())] };
  } catch (error) {
    const payload = error instanceof ReadonlyCanvasError
      ? { code: error.code, message: error.message }
      : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
    return {
      isError: true,
      content: [textContent({ ok: false, error: payload })],
    };
  }
}

function textContent(value: unknown) {
  return { type: 'text' as const, text: JSON.stringify(value, null, 2) };
}
