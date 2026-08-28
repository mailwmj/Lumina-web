import type { CanvasAgentToolName } from '../canvas/protocol.js';

export const WEB_CANVAS_PROTOCOL = {
  major: 2,
  minor: 0,
  build: 'lumina-canvas-web-v2',
} as const;

export const WEB_CANVAS_CAPABILITIES = [
  'project.read.list',
  'project.write.create',
  'project.write.open',
  'canvas.read.state',
  'canvas.read.selection',
  'canvas.read.capabilities',
  'canvas.read.change-status',
  'canvas.write.changes',
  'canvas.write.import-images',
  'canvas.run.images',
  'canvas.run.videos',
  'canvas.wait.nodes',
  'canvas.read.node-images',
  'canvas.read.video-results',
  'canvas.read.action-status',
] as const;

export type WebCanvasCapability = (typeof WEB_CANVAS_CAPABILITIES)[number];

export interface WebCanvasProtocol {
  major: number;
  minor: number;
  build: string;
}

export interface WebCanvasHello {
  protocol: WebCanvasProtocol;
  capabilities: readonly string[];
}

export type WebCanvasNegotiation =
  | { ok: true; capabilities: WebCanvasCapability[] }
  | { ok: false; reason: string; capabilities: [] };

export function negotiateWebCanvasProtocol(hello: WebCanvasHello): WebCanvasNegotiation {
  if (!isProtocol(hello.protocol)) {
    return { ok: false, reason: 'invalid_protocol', capabilities: [] };
  }
  if (hello.protocol.major !== WEB_CANVAS_PROTOCOL.major) {
    return { ok: false, reason: 'protocol_major_mismatch', capabilities: [] };
  }
  if (hello.protocol.build !== WEB_CANVAS_PROTOCOL.build) {
    return { ok: false, reason: 'protocol_build_mismatch', capabilities: [] };
  }
  const capabilities = [...new Set(hello.capabilities)]
    .filter(isWebCanvasCapability);
  if (capabilities.length === 0) {
    return { ok: false, reason: 'no_supported_capabilities', capabilities: [] };
  }
  return { ok: true, capabilities };
}

export function parseWebCanvasHello(value: unknown): WebCanvasHello {
  const record = readRecord(value, 'hello');
  rejectUnknownFields(record, ['protocol', 'capabilities'], 'hello');
  return {
    protocol: parseProtocol(record.protocol),
    capabilities: readStringArray(record.capabilities, 'hello.capabilities'),
  };
}

export function capabilityForTool(name: CanvasAgentToolName): WebCanvasCapability {
  switch (name) {
    case 'canvas_list_projects':
      return 'project.read.list';
    case 'canvas_create_project':
      return 'project.write.create';
    case 'canvas_open_project':
      return 'project.write.open';
    case 'canvas_get_state':
      return 'canvas.read.state';
    case 'canvas_get_selection':
      return 'canvas.read.selection';
    case 'canvas_get_capabilities':
      return 'canvas.read.capabilities';
    case 'canvas_get_change_status':
      return 'canvas.read.change-status';
    case 'canvas_propose_changes':
      return 'canvas.write.changes';
    case 'canvas_import_images':
      return 'canvas.write.import-images';
    case 'canvas_run_nodes':
      return 'canvas.run.images';
    case 'canvas_run_video_nodes':
      return 'canvas.run.videos';
    case 'canvas_wait_for_nodes':
      return 'canvas.wait.nodes';
    case 'canvas_get_node_images':
      return 'canvas.read.node-images';
    case 'canvas_get_video_results':
      return 'canvas.read.video-results';
    case 'canvas_get_action_status':
      return 'canvas.read.action-status';
  }
}

export function isWebCanvasWriteTool(name: CanvasAgentToolName): boolean {
  return name === 'canvas_propose_changes'
    || name === 'canvas_import_images'
    || name === 'canvas_run_nodes'
    || name === 'canvas_run_video_nodes';
}

function parseProtocol(value: unknown): WebCanvasProtocol {
  const record = readRecord(value, 'hello.protocol');
  rejectUnknownFields(record, ['major', 'minor', 'build'], 'hello.protocol');
  return {
    major: readInteger(record.major, 'hello.protocol.major'),
    minor: readInteger(record.minor, 'hello.protocol.minor'),
    build: readNonEmptyString(record.build, 'hello.protocol.build'),
  };
}

function isProtocol(value: unknown): value is WebCanvasProtocol {
  const record = value as Record<string, unknown>;
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Number.isInteger(record.major)
    && typeof record.major === 'number'
    && record.major >= 0
    && Number.isInteger(record.minor)
    && typeof record.minor === 'number'
    && record.minor >= 0
    && typeof record.build === 'string'
    && Boolean(record.build);
}

function isWebCanvasCapability(value: string): value is WebCanvasCapability {
  return (WEB_CANVAS_CAPABILITIES as readonly string[]).includes(value);
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${field} must contain non-empty strings.`);
  }
  return value;
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function readInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error(`${field} contains unsupported fields.`);
  }
}
