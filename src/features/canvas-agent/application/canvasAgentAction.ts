import type {
  CanvasAgentActionRequest,
  PendingCanvasAgentAction,
} from '@/features/canvas-agent/domain/types';

export class CanvasAgentActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CanvasAgentActionError';
  }
}

export function parsePendingCanvasAgentAction(value: unknown): PendingCanvasAgentAction {
  const record = readRecord(value, 'The canvas action payload is invalid.');
  if (
    typeof record.actionId !== 'string'
    || !record.actionId
    || typeof record.createdAt !== 'number'
  ) {
    throw new CanvasAgentActionError('INVALID_ACTION', 'The canvas action payload is incomplete.');
  }
  return {
    actionId: record.actionId,
    createdAt: record.createdAt,
    request: parseActionRequest(record.request),
  };
}

function parseActionRequest(value: unknown): CanvasAgentActionRequest {
  const request = readRecord(value, 'The canvas action request is invalid.');
  const projectId = readRequiredString(request.projectId, 'projectId');

  if (request.type === 'import_images') {
    const baseRevision = readRequiredString(request.baseRevision, 'baseRevision');
    if (!Array.isArray(request.images) || request.images.length < 1 || request.images.length > 12) {
      throw new CanvasAgentActionError('INVALID_ACTION', 'Import actions require 1 to 12 images.');
    }
    return {
      type: 'import_images',
      projectId,
      baseRevision,
      images: request.images.map((value) => {
        const image = readRecord(value, 'An imported image is invalid.');
        const source = readRequiredString(image.source, 'source');
        if (source.length > 10_000_000 || !isSupportedImageSource(source)) {
          throw new CanvasAgentActionError(
            'INVALID_ACTION',
            'source must be an absolute local path, file URL, HTTP(S) URL, or raster image data URL.'
          );
        }
        return {
          clientId: readRequiredString(image.clientId, 'clientId'),
          source,
          ...(typeof image.fileName === 'string' ? { fileName: image.fileName } : {}),
          ...(typeof image.displayName === 'string' ? { displayName: image.displayName } : {}),
        };
      }),
      ...(request.position === undefined ? {} : { position: parsePosition(request.position) }),
    };
  }

  if (request.type === 'run_nodes') {
    return {
      type: 'run_nodes',
      projectId,
      baseRevision: readRequiredString(request.baseRevision, 'baseRevision'),
      nodeIds: parseNodeIds(request.nodeIds),
    };
  }

  if (request.type === 'get_node_images') {
    const maxDimension = Number(request.maxDimension);
    if (!Number.isInteger(maxDimension) || maxDimension < 256 || maxDimension > 1024) {
      throw new CanvasAgentActionError('INVALID_ACTION', 'maxDimension must be from 256 to 1024.');
    }
    return {
      type: 'get_node_images',
      projectId,
      nodeIds: parseNodeIds(request.nodeIds),
      maxDimension,
    };
  }

  throw new CanvasAgentActionError('UNKNOWN_ACTION', 'The canvas action type is not allowed.');
}

function parseNodeIds(value: unknown): string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 12
    || !value.every((nodeId) => typeof nodeId === 'string' && nodeId.length > 0)
  ) {
    throw new CanvasAgentActionError('INVALID_ACTION', 'nodeIds must contain 1 to 12 node IDs.');
  }
  return [...new Set(value)];
}

function parsePosition(value: unknown): { x: number; y: number } {
  const position = readRecord(value, 'The canvas action position is invalid.');
  if (
    typeof position.x !== 'number'
    || !Number.isFinite(position.x)
    || typeof position.y !== 'number'
    || !Number.isFinite(position.y)
  ) {
    throw new CanvasAgentActionError('INVALID_ACTION', 'The canvas action position is invalid.');
  }
  return { x: position.x, y: position.y };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CanvasAgentActionError('INVALID_ACTION', `${field} is required.`);
  }
  return value;
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanvasAgentActionError('INVALID_ACTION', message);
  }
  return value as Record<string, unknown>;
}

function isSupportedImageSource(value: string): boolean {
  return /^(?:https?:\/\/|file:\/\/|\/|[a-z]:[\\/]|\\\\)/i.test(value)
    || /^data:image\/(?:png|jpe?g|webp|gif|bmp|tiff|avif);base64,/i.test(value);
}
