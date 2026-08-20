import { z } from 'zod';

export const CANVAS_AGENT_PROTOCOL_VERSION = 2;

export const canvasAgentToolNames = [
  'canvas_get_state',
  'canvas_get_selection',
  'canvas_get_capabilities',
  'canvas_propose_changes',
  'canvas_get_change_status',
  'canvas_import_images',
  'canvas_run_nodes',
  'canvas_wait_for_nodes',
  'canvas_get_node_images',
  'canvas_get_action_status',
] as const;

export type CanvasAgentToolName = (typeof canvasAgentToolNames)[number];

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();

const nodeDataSchema = z.record(z.unknown());

const imageSourceSchema = z.string().trim().min(1).max(10_000_000).refine(
  isSupportedImageSource,
  'source must be an absolute local path, file URL, HTTP(S) URL, or raster image data URL'
);

export const canvasChangeOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_node'),
    clientId: z.string().trim().min(1).max(80),
    nodeType: z.string().trim().min(1).max(80),
    position: positionSchema.optional(),
    data: nodeDataSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('update_node'),
    nodeId: z.string().trim().min(1).max(160),
    data: nodeDataSchema,
  }).strict(),
  z.object({
    type: z.literal('move_node'),
    nodeId: z.string().trim().min(1).max(160),
    position: positionSchema,
  }).strict(),
  z.object({
    type: z.literal('connect_nodes'),
    sourceNodeId: z.string().trim().min(1).max(160),
    targetNodeId: z.string().trim().min(1).max(160),
    sourceHandle: z.string().trim().min(1).max(80).optional(),
    targetHandle: z.string().trim().min(1).max(80).optional(),
  }).strict(),
]);

export const canvasChangeSetSchema = z.object({
  projectId: z.string().trim().min(1).max(160),
  baseRevision: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(500),
  operations: z.array(canvasChangeOperationSchema).min(1).max(100),
}).strict();

export type CanvasChangeSet = z.infer<typeof canvasChangeSetSchema>;

export const canvasImportImagesSchema = z.object({
  projectId: z.string().trim().min(1).max(160),
  baseRevision: z.string().trim().min(1).max(160),
  images: z.array(z.object({
    clientId: z.string().trim().min(1).max(80),
    source: imageSourceSchema,
    fileName: z.string().trim().min(1).max(260).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
  }).strict()).min(1).max(12),
  position: positionSchema.optional(),
}).strict();

export const canvasRunNodesSchema = z.object({
  projectId: z.string().trim().min(1).max(160),
  baseRevision: z.string().trim().min(1).max(160),
  nodeIds: z.array(z.string().trim().min(1).max(160)).min(1).max(12),
}).strict();

export const canvasGetNodeImagesSchema = z.object({
  projectId: z.string().trim().min(1).max(160),
  nodeIds: z.array(z.string().trim().min(1).max(160)).min(1).max(12),
  maxDimension: z.number().int().min(256).max(1024).default(768),
}).strict();

export const canvasWaitForNodesSchema = z.object({
  projectId: z.string().trim().min(1).max(160),
  nodeIds: z.array(z.string().trim().min(1).max(160)).min(1).max(12),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(15_000),
}).strict();

export const canvasAgentToolSchemas = {
  canvas_get_state: z.object({}).strict(),
  canvas_get_selection: z.object({}).strict(),
  canvas_get_capabilities: z.object({}).strict(),
  canvas_propose_changes: canvasChangeSetSchema,
  canvas_get_change_status: z.object({
    proposalId: z.string().uuid(),
  }).strict(),
  canvas_import_images: canvasImportImagesSchema,
  canvas_run_nodes: canvasRunNodesSchema,
  canvas_wait_for_nodes: canvasWaitForNodesSchema,
  canvas_get_node_images: canvasGetNodeImagesSchema,
  canvas_get_action_status: z.object({
    actionId: z.string().uuid(),
  }).strict(),
} satisfies Record<CanvasAgentToolName, z.AnyZodObject>;

export const canvasAgentToolDescriptions: Record<CanvasAgentToolName, string> = {
  canvas_get_state: 'Read the live state of the project currently open in Lumina, including nodes, edges, selection, viewport, revision, and selected image previews.',
  canvas_get_selection: 'Read the currently selected Lumina canvas nodes and any explicitly selected compressed image previews.',
  canvas_get_capabilities: 'Read the node types, editable fields, and connection capabilities allowed for external Agents.',
  canvas_propose_changes: 'Submit one bounded CanvasChangeSet for direct validation and atomic application in Lumina.',
  canvas_get_change_status: 'Poll the application status of a previously submitted canvas change set.',
  canvas_import_images: 'Import up to 12 absolute local paths, file URLs, HTTP(S) URLs, or raster image data URLs into existing Lumina upload nodes. Images are prepared in parallel and placed as one readable reference column.',
  canvas_run_nodes: 'Run up to 12 existing Lumina image-generation nodes in parallel after validating the active project, canvas revision, prompts, references, and configured models.',
  canvas_wait_for_nodes: 'Wait until any of up to 12 target nodes changes or the timeout expires, then return compact per-node generation progress without the full canvas or capabilities registry.',
  canvas_get_node_images: 'Read status metadata and vision-ready compressed previews for up to 12 image nodes in the active Lumina project. Local paths and original payloads are never returned.',
  canvas_get_action_status: 'Poll an import, node-run, or node-image read only when its initial tool call returned pending.',
};

export type CanvasImportImagesInput = z.infer<typeof canvasImportImagesSchema>;
export type CanvasRunNodesInput = z.infer<typeof canvasRunNodesSchema>;
export type CanvasWaitForNodesInput = z.infer<typeof canvasWaitForNodesSchema>;
export type CanvasGetNodeImagesInput = z.infer<typeof canvasGetNodeImagesSchema>;

export type CanvasActionRequest =
  | ({ type: 'import_images' } & CanvasImportImagesInput)
  | ({ type: 'run_nodes' } & CanvasRunNodesInput)
  | ({ type: 'get_node_images' } & CanvasGetNodeImagesInput);

export interface CanvasSnapshot {
  protocolVersion: number;
  projectId: string;
  projectName: string;
  revision: string;
  nodes: Array<Record<string, unknown> & { id: string }>;
  edges: Array<Record<string, unknown> & { id: string }>;
  selectedNodeIds: string[];
  viewport: { x: number; y: number; zoom: number };
  selectedImagePreviews: Array<{
    nodeId: string;
    mimeType: string;
    dataUrl: string;
  }>;
  capabilities: unknown;
}

export type CanvasProposalStatus = 'pending' | 'applied' | 'stale' | 'failed';

export interface CanvasProposalRecord {
  proposalId: string;
  clientId: string;
  changeSet: CanvasChangeSet;
  status: CanvasProposalStatus;
  createdAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
}

export interface CanvasActionRecord {
  actionId: string;
  clientId: string;
  request: CanvasActionRequest;
  status: CanvasProposalStatus;
  createdAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
}

export interface CanvasAgentErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export class CanvasAgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'CanvasAgentError';
  }

  toPayload(): CanvasAgentErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

function isSupportedImageSource(value: string): boolean {
  return /^(?:https?:\/\/|file:\/\/|\/|[a-z]:[\\/]|\\\\)/i.test(value)
    || /^data:image\/(?:png|jpe?g|webp|gif|bmp|tiff|avif);base64,/i.test(value);
}

export function isCanvasAgentToolName(value: unknown): value is CanvasAgentToolName {
  return typeof value === 'string'
    && (canvasAgentToolNames as readonly string[]).includes(value);
}
