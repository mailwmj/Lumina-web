import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ZodError } from 'zod';

import type { CanvasAgentConfig } from '../config.js';
import {
  CanvasAgentError,
  canvasAgentToolDescriptions,
  canvasAgentToolNames,
  canvasAgentToolSchemas,
  type CanvasAgentErrorPayload,
  type CanvasAgentToolName,
} from '../canvas/protocol.js';

interface ToolHttpResponse {
  ok?: boolean;
  result?: unknown;
  error?: CanvasAgentErrorPayload;
}

const MCP_TOOL_TIMEOUT_MS = 35_000;

const MCP_INSTRUCTIONS = [
  'Calls follow business phases; there is no fixed total call limit. Avoid repeated full-state reads without a state change or reason.',
  'Use one canvas_propose_changes per atomic setup phase; include complete node data and same-batch clientId connections instead of splitting by object or field.',
  'Use terminal results directly; call status tools only when the initial result is pending.',
  'Call canvas_run_nodes only after the user has explicitly authorized the visible setup.',
  'Lumina exposes only the project currently open in the desktop app.',
  'Read canvas_get_state before changing the canvas and reuse its projectId and revision.',
  'Import user-provided images in one canvas_import_images batch; absolute local paths, file URLs, HTTP(S) URLs, and raster image data URLs are supported.',
  'Create one existing imageNode per distinct shot, omit create_node.position for automatic readable column layout, and connect references in the same order used by 图片 1, 图片 2, and subsequent prompt labels.',
  'Use displayName only for a concise canvas title of at most 80 characters; keep the complete generation instruction in prompt.',
  'canvas_propose_changes validates and atomically applies one bounded change set without an in-app approval step.',
  'After a run, use canvas_wait_for_nodes with the returned result node IDs for compact progress; repeat waits as needed until every target is terminal.',
  'Use canvas_get_node_images with explicit ready result node IDs to inspect outputs.',
  'Deletion and arbitrary result-node creation remain unavailable.',
].join(' ');

export async function startMcpServer(config: CanvasAgentConfig): Promise<void> {
  const server = new McpServer(
    { name: 'lumina-canvas', version: '0.2.0' },
    { instructions: MCP_INSTRUCTIONS }
  );
  canvasAgentToolNames.forEach((name) => registerTool(server, config, name));
  await server.connect(new StdioServerTransport());
}

function registerTool(
  server: McpServer,
  config: CanvasAgentConfig,
  name: CanvasAgentToolName
): void {
  const schema = canvasAgentToolSchemas[name];
  server.registerTool(
    name,
    {
      description: canvasAgentToolDescriptions[name],
      inputSchema: schema.shape,
    },
    async (rawInput: unknown) => {
      try {
        const input = schema.parse(rawInput);
        const result = await postTool(config, name, input);
        return {
          content: toMcpContent(result),
        };
      } catch (error) {
        const payload = toErrorPayload(error);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: payload }, null, 2) }],
        };
      }
    }
  );
}

type McpToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export function toMcpContent(result: unknown): McpToolContent[] {
  const images: Array<{ data: string; mimeType: string }> = [];
  const metadata = stripImageDataUrls(result, images);
  return [
    { type: 'text', text: JSON.stringify(metadata, null, 2) },
    ...images.map((image) => ({ type: 'image' as const, ...image })),
  ];
}

function stripImageDataUrls(
  value: unknown,
  images: Array<{ data: string; mimeType: string }>
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

async function postTool(
  config: CanvasAgentConfig,
  name: CanvasAgentToolName,
  input: unknown
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${config.url}/api/tools`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, input }),
      signal: AbortSignal.timeout(MCP_TOOL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CanvasAgentError(
      'BRIDGE_UNAVAILABLE',
      'Lumina Canvas Agent is not running or cannot be reached.',
      error instanceof Error ? error.message : String(error)
    );
  }

  const body = await response.json() as ToolHttpResponse;
  if (!response.ok || !body.ok) {
    throw new CanvasAgentError(
      body.error?.code ?? 'TOOL_CALL_FAILED',
      body.error?.message ?? 'The canvas tool call failed.',
      body.error?.details
    );
  }
  return body.result;
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
