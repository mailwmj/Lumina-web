import crypto from 'node:crypto';

import {
  negotiateReadonlyCanvasProtocol,
  parseReadonlyCanvasSnapshot,
  type ReadonlyCanvasCapability,
  type ReadonlyCanvasHello,
  type ReadonlyCanvasSnapshot,
  type ReadonlyCanvasState,
} from './protocol.js';

const BOOTSTRAP_TTL_MS = 5 * 60_000;
const ACTIVE_CANVAS_TTL_MS = 20_000;

export class ReadonlyCanvasError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ReadonlyCanvasBootstrap {
  endpoint: string;
  canonicalOrigin: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}

interface ReadonlyCanvasSessionOptions {
  now?: () => number;
  createToken?: () => string;
  createSessionId?: () => string;
}

interface ActiveCanvas {
  snapshot: ReadonlyCanvasSnapshot;
  lastSeenAt: number;
}

export class ReadonlyCanvasSession {
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly createSessionId: () => string;
  private bootstrap: ReadonlyCanvasBootstrap | null = null;
  private bootstrapConsumed = false;
  private negotiatedCapabilities: ReadonlyCanvasCapability[] = [];
  private activeCanvas: ActiveCanvas | null = null;

  constructor(options: ReadonlyCanvasSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createToken = options.createToken ?? (() => crypto.randomBytes(32).toString('base64url'));
    this.createSessionId = options.createSessionId ?? crypto.randomUUID;
  }

  issueBootstrap(endpoint: string, canonicalOrigin: string): ReadonlyCanvasBootstrap {
    const expiresAt = this.now() + BOOTSTRAP_TTL_MS;
    this.negotiatedCapabilities = [];
    this.activeCanvas = null;
    this.bootstrapConsumed = false;
    this.bootstrap = {
      endpoint,
      canonicalOrigin,
      sessionId: this.createSessionId(),
      token: this.createToken(),
      expiresAt,
    };
    return { ...this.bootstrap };
  }

  connect(token: string, hello: ReadonlyCanvasHello, sessionId?: string): {
    capabilities: ReadonlyCanvasCapability[];
  } {
    const bootstrap = this.requireBootstrap(token, sessionId);
    if (this.bootstrapConsumed) {
      throw new ReadonlyCanvasError('UNAUTHORIZED', 'The canvas bridge bootstrap has already been consumed.');
    }
    if (this.now() > bootstrap.expiresAt) {
      this.clear();
      throw new ReadonlyCanvasError('SESSION_EXPIRED', 'The canvas bridge session has expired.');
    }
    const negotiated = negotiateReadonlyCanvasProtocol(hello);
    if (!negotiated.ok) {
      this.clearActiveCanvas();
      throw new ReadonlyCanvasError('PROTOCOL_INCOMPATIBLE', negotiated.reason);
    }
    this.negotiatedCapabilities = negotiated.capabilities;
    this.activeCanvas = null;
    this.bootstrapConsumed = true;
    return { capabilities: [...this.negotiatedCapabilities] };
  }

  publish(token: string, value: unknown, sessionId?: string): void {
    this.requireBootstrap(token, sessionId);
    this.requireConnected();
    let snapshot: ReadonlyCanvasSnapshot;
    try {
      snapshot = parseReadonlyCanvasSnapshot(value);
    } catch (error) {
      throw new ReadonlyCanvasError(
        'INVALID_SNAPSHOT',
        error instanceof Error ? error.message : String(error),
      );
    }
    const negotiated = negotiateReadonlyCanvasProtocol({
      protocol: snapshot.protocol,
      capabilities: snapshot.capabilities,
    });
    if (!negotiated.ok || !sameCapabilities(negotiated.capabilities, this.negotiatedCapabilities)) {
      throw new ReadonlyCanvasError('PROTOCOL_INCOMPATIBLE', 'The published canvas capabilities are incompatible.');
    }
    if (this.activeCanvas && this.activeCanvas.snapshot.state.project.id !== snapshot.state.project.id) {
      throw new ReadonlyCanvasError('ACTIVE_PROJECT_MISMATCH', 'The companion is bound to a different active project.');
    }
    this.activeCanvas = { snapshot, lastSeenAt: this.now() };
  }

  disconnect(token: string, sessionId?: string): void {
    this.requireBootstrap(token, sessionId);
    this.clearActiveCanvas();
  }

  close(): void {
    this.clear();
  }

  readState(): ReadonlyCanvasState {
    this.requireActiveCanvas('canvas.read.state');
    return structuredClone(this.activeCanvas!.snapshot.state);
  }

  readSelection(): ReadonlyCanvasSnapshot['selection'] {
    this.requireActiveCanvas('canvas.read.selection');
    return structuredClone(this.activeCanvas!.snapshot.selection);
  }

  readCapabilities(): ReadonlyCanvasCapability[] {
    this.requireActiveCanvas('canvas.read.capabilities');
    return [...this.negotiatedCapabilities];
  }

  private requireActiveCanvas(capability: ReadonlyCanvasCapability): void {
    this.requireConnected();
    if (!this.negotiatedCapabilities.includes(capability)) {
      throw new ReadonlyCanvasError('CAPABILITY_NOT_NEGOTIATED', `Capability ${capability} was not negotiated.`);
    }
    if (!this.activeCanvas) {
      throw new ReadonlyCanvasError('NO_ACTIVE_CANVAS', 'No active canvas is connected.');
    }
    if (this.now() - this.activeCanvas.lastSeenAt > ACTIVE_CANVAS_TTL_MS) {
      this.clearActiveCanvas();
      throw new ReadonlyCanvasError('NO_ACTIVE_CANVAS', 'The active canvas heartbeat expired.');
    }
  }

  private requireConnected(): void {
    const bootstrap = this.bootstrap;
    if (!bootstrap || this.negotiatedCapabilities.length === 0) {
      throw new ReadonlyCanvasError('NO_ACTIVE_CANVAS', 'No active canvas is connected.');
    }
    if (this.now() > bootstrap.expiresAt) {
      this.clear();
      throw new ReadonlyCanvasError('SESSION_EXPIRED', 'The canvas bridge session has expired.');
    }
  }

  private requireBootstrap(token: string, sessionId?: string): ReadonlyCanvasBootstrap {
    const bootstrap = this.bootstrap;
    if (!bootstrap || !tokensMatch(token, bootstrap.token) || (sessionId && sessionId !== bootstrap.sessionId)) {
      throw new ReadonlyCanvasError('UNAUTHORIZED', 'The canvas bridge token is invalid.');
    }
    return bootstrap;
  }

  private clear(): void {
    this.bootstrap = null;
    this.bootstrapConsumed = false;
    this.clearActiveCanvas();
  }

  private clearActiveCanvas(): void {
    this.negotiatedCapabilities = [];
    this.activeCanvas = null;
  }
}

function sameCapabilities(
  left: readonly ReadonlyCanvasCapability[],
  right: readonly ReadonlyCanvasCapability[],
): boolean {
  return left.length === right.length && left.every((capability) => right.includes(capability));
}

function tokensMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
