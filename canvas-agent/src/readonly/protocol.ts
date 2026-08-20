export const READONLY_CANVAS_PROTOCOL = {
  major: 1,
  minor: 0,
  build: 'lumina-canvas-readonly-v1',
} as const;

export const READONLY_CANVAS_CAPABILITIES = [
  'canvas.read.state',
  'canvas.read.selection',
  'canvas.read.capabilities',
] as const;

export type ReadonlyCanvasCapability = (typeof READONLY_CANVAS_CAPABILITIES)[number];

export interface ReadonlyCanvasProtocol {
  major: number;
  minor: number;
  build: string;
}

export interface ReadonlyCanvasHello {
  protocol: ReadonlyCanvasProtocol;
  capabilities: readonly string[];
}

export interface ReadonlyCanvasState {
  project: {
    id: string;
    name: string;
    revision: string;
  };
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    width?: number;
    height?: number;
    parentId?: string;
    data: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
    valueType?: string;
    inputOrder?: number;
  }>;
  viewport: { x: number; y: number; zoom: number };
}

export interface ReadonlyCanvasSnapshot {
  protocol: ReadonlyCanvasProtocol;
  capabilities: readonly string[];
  state: ReadonlyCanvasState;
  selection: { nodeIds: string[] };
}

export type ReadonlyCanvasNegotiation =
  | { ok: true; capabilities: ReadonlyCanvasCapability[] }
  | { ok: false; reason: string; capabilities: [] };

export function negotiateReadonlyCanvasProtocol(
  hello: ReadonlyCanvasHello,
): ReadonlyCanvasNegotiation {
  if (!isProtocol(hello.protocol)) {
    return { ok: false, reason: 'invalid_protocol', capabilities: [] };
  }
  if (hello.protocol.major !== READONLY_CANVAS_PROTOCOL.major) {
    return { ok: false, reason: 'protocol_major_mismatch', capabilities: [] };
  }
  if (hello.protocol.build !== READONLY_CANVAS_PROTOCOL.build) {
    return { ok: false, reason: 'protocol_build_mismatch', capabilities: [] };
  }
  const capabilities = [...new Set(hello.capabilities)]
    .filter(isReadonlyCanvasCapability);
  if (capabilities.length === 0) {
    return { ok: false, reason: 'no_supported_capabilities', capabilities: [] };
  }
  return { ok: true, capabilities };
}

export function parseReadonlyCanvasHello(value: unknown): ReadonlyCanvasHello {
  const record = readRecord(value, 'hello');
  rejectUnknownFields(record, ['protocol', 'capabilities'], 'hello');
  const capabilities = readStringArray(record.capabilities, 'hello.capabilities');
  return {
    protocol: parseProtocol(record.protocol),
    capabilities,
  };
}

export function parseReadonlyCanvasSnapshot(value: unknown): ReadonlyCanvasSnapshot {
  const record = readRecord(value, 'snapshot');
  rejectUnknownFields(record, ['protocol', 'capabilities', 'state', 'selection'], 'snapshot');
  const stateRecord = readRecord(record.state, 'snapshot.state');
  rejectUnknownFields(stateRecord, ['project', 'nodes', 'edges', 'viewport'], 'snapshot.state');
  const project = parseProject(stateRecord.project);
  const nodes = readArray(stateRecord.nodes, 'snapshot.state.nodes').map(parseNode);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const selection = parseSelection(record.selection, nodeIds);

  return {
    protocol: parseProtocol(record.protocol),
    capabilities: readStringArray(record.capabilities, 'snapshot.capabilities'),
    state: {
      project,
      nodes,
      edges: readArray(stateRecord.edges, 'snapshot.state.edges').map(parseEdge),
      viewport: parseViewport(stateRecord.viewport),
    },
    selection,
  };
}

function parseProject(value: unknown): ReadonlyCanvasState['project'] {
  const record = readRecord(value, 'snapshot.state.project');
  rejectUnknownFields(record, ['id', 'name', 'revision'], 'snapshot.state.project');
  return {
    id: readNonEmptyString(record.id, 'snapshot.state.project.id'),
    name: readNonEmptyString(record.name, 'snapshot.state.project.name'),
    revision: readNonEmptyString(record.revision, 'snapshot.state.project.revision'),
  };
}

function parseNode(value: unknown): ReadonlyCanvasState['nodes'][number] {
  const record = readRecord(value, 'snapshot.state.nodes[]');
  rejectUnknownFields(record, ['id', 'type', 'position', 'width', 'height', 'parentId', 'data'], 'snapshot.state.nodes[]');
  const node = {
    id: readNonEmptyString(record.id, 'snapshot.state.nodes[].id'),
    type: readNonEmptyString(record.type, 'snapshot.state.nodes[].type'),
    position: parsePoint(record.position, 'snapshot.state.nodes[].position'),
    data: readRecord(record.data, 'snapshot.state.nodes[].data'),
  } as ReadonlyCanvasState['nodes'][number];
  if (typeof record.width === 'number' && Number.isFinite(record.width)) {
    node.width = record.width;
  }
  if (typeof record.height === 'number' && Number.isFinite(record.height)) {
    node.height = record.height;
  }
  if (record.parentId !== undefined) {
    node.parentId = readNonEmptyString(record.parentId, 'snapshot.state.nodes[].parentId');
  }
  return node;
}

function parseEdge(value: unknown): ReadonlyCanvasState['edges'][number] {
  const record = readRecord(value, 'snapshot.state.edges[]');
  rejectUnknownFields(record, ['id', 'source', 'target', 'sourceHandle', 'targetHandle', 'valueType', 'inputOrder'], 'snapshot.state.edges[]');
  const edge = {
    id: readNonEmptyString(record.id, 'snapshot.state.edges[].id'),
    source: readNonEmptyString(record.source, 'snapshot.state.edges[].source'),
    target: readNonEmptyString(record.target, 'snapshot.state.edges[].target'),
  } as ReadonlyCanvasState['edges'][number];
  ['sourceHandle', 'targetHandle', 'valueType'].forEach((field) => {
    if (record[field] !== undefined) {
      edge[field as 'sourceHandle' | 'targetHandle' | 'valueType'] = readNonEmptyString(
        record[field],
        `snapshot.state.edges[].${field}`,
      );
    }
  });
  if (typeof record.inputOrder === 'number' && Number.isFinite(record.inputOrder)) {
    edge.inputOrder = record.inputOrder;
  }
  return edge;
}

function parseViewport(value: unknown): ReadonlyCanvasState['viewport'] {
  const record = readRecord(value, 'snapshot.state.viewport');
  rejectUnknownFields(record, ['x', 'y', 'zoom'], 'snapshot.state.viewport');
  return {
    x: readFiniteNumber(record.x, 'snapshot.state.viewport.x'),
    y: readFiniteNumber(record.y, 'snapshot.state.viewport.y'),
    zoom: readFiniteNumber(record.zoom, 'snapshot.state.viewport.zoom'),
  };
}

function parseSelection(value: unknown, nodeIds: Set<string>): { nodeIds: string[] } {
  const record = readRecord(value, 'snapshot.selection');
  rejectUnknownFields(record, ['nodeIds'], 'snapshot.selection');
  const selectedIds = readStringArray(record.nodeIds, 'snapshot.selection.nodeIds');
  if (selectedIds.some((nodeId) => !nodeIds.has(nodeId))) {
    throw new Error('snapshot.selection.nodeIds must reference current state nodes.');
  }
  return { nodeIds: selectedIds };
}

function parseProtocol(value: unknown): ReadonlyCanvasProtocol {
  const record = readRecord(value, 'protocol');
  rejectUnknownFields(record, ['major', 'minor', 'build'], 'protocol');
  return {
    major: readInteger(record.major, 'protocol.major'),
    minor: readInteger(record.minor, 'protocol.minor'),
    build: readNonEmptyString(record.build, 'protocol.build'),
  };
}

function parsePoint(value: unknown, field: string): { x: number; y: number } {
  const record = readRecord(value, field);
  rejectUnknownFields(record, ['x', 'y'], field);
  return {
    x: readFiniteNumber(record.x, `${field}.x`),
    y: readFiniteNumber(record.y, `${field}.y`),
  };
}

function isProtocol(value: unknown): value is ReadonlyCanvasProtocol {
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

function isReadonlyCanvasCapability(value: string): value is ReadonlyCanvasCapability {
  return (READONLY_CANVAS_CAPABILITIES as readonly string[]).includes(value);
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  return value;
}

function readStringArray(value: unknown, field: string): string[] {
  const values = readArray(value, field);
  if (!values.every((entry) => typeof entry === 'string' && entry.trim())) {
    throw new Error(`${field} must contain non-empty strings.`);
  }
  return values as string[];
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function readFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
}

function readInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: string[], field: string): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error(`${field} contains unsupported fields.`);
  }
}
