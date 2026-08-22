import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';

import {
  CanvasAgentError,
  type CanvasActionRecord,
  type CanvasAgentToolName,
  type CanvasProposalRecord,
  type CanvasProposalStatus,
  type CanvasSnapshot,
} from '../canvas/protocol.js';
import { CanvasSession } from '../canvas/session.js';
import {
  capabilityForTool,
  isWebCanvasWriteTool,
  negotiateWebCanvasProtocol,
  type WebCanvasCapability,
  type WebCanvasHello,
} from './protocol.js';

const BOOTSTRAP_TTL_MS = 5 * 60_000;

export interface WebCanvasBootstrap {
  bridge: 'web';
  endpoint: string;
  canonicalOrigin: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}

export type WebCanvasOpenResult =
  | { status: 'awaiting_browser'; bootstrap: WebCanvasBootstrap }
  | { status: 'awaiting_project'; canonicalOrigin: string }
  | { status: 'connected'; canonicalOrigin: string };

interface WebCanvasSessionOptions {
  now?: () => number;
  createToken?: () => string;
  createSessionId?: () => string;
}

export class WebCanvasSession {
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly createSessionId: () => string;
  private canvas = new CanvasSession();
  private bootstrap: WebCanvasBootstrap | null = null;
  private bootstrapConsumed = false;
  private negotiatedCapabilities: WebCanvasCapability[] = [];
  private boundProjectId: string | null = null;
  private currentSnapshot: CanvasSnapshot | null = null;
  private eventResponse: ServerResponse | null = null;

  constructor(options: WebCanvasSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createToken = options.createToken ?? (() => crypto.randomBytes(32).toString('base64url'));
    this.createSessionId = options.createSessionId ?? crypto.randomUUID;
  }

  issueBootstrap(endpoint: string, canonicalOrigin: string): WebCanvasBootstrap {
    this.canvas.close('session_rotated');
    this.canvas = new CanvasSession();
    this.clearBridgeSession();
    this.bootstrap = {
      bridge: 'web',
      endpoint,
      canonicalOrigin,
      sessionId: this.createSessionId(),
      token: this.createToken(),
      expiresAt: this.now() + BOOTSTRAP_TTL_MS,
    };
    return { ...this.bootstrap };
  }

  ensureOpen(endpoint: string, canonicalOrigin: string): WebCanvasOpenResult {
    const bootstrap = this.bootstrap;
    if (bootstrap && this.bootstrapConsumed && this.negotiatedCapabilities.length > 0) {
      return {
        status: this.currentSnapshot && this.boundProjectId ? 'connected' : 'awaiting_project',
        canonicalOrigin: bootstrap.canonicalOrigin,
      };
    }
    if (bootstrap && this.now() < bootstrap.expiresAt) {
      return {
        status: 'awaiting_browser',
        bootstrap: { ...bootstrap },
      };
    }
    return {
      status: 'awaiting_browser',
      bootstrap: this.issueBootstrap(endpoint, canonicalOrigin),
    };
  }

  connect(token: string, hello: WebCanvasHello, sessionId: string): { capabilities: WebCanvasCapability[] } {
    if (this.bootstrapConsumed) {
      this.requireConnected(token, sessionId);
      throw new CanvasAgentError('UNAUTHORIZED', 'The canvas bridge bootstrap has already been consumed.');
    }
    this.requireBootstrap(token, sessionId);
    const negotiated = negotiateWebCanvasProtocol(hello);
    if (!negotiated.ok) {
      this.resetCanvas('protocol_incompatible');
      throw new CanvasAgentError('PROTOCOL_INCOMPATIBLE', negotiated.reason);
    }
    this.bootstrapConsumed = true;
    this.negotiatedCapabilities = negotiated.capabilities;
    return { capabilities: [...this.negotiatedCapabilities] };
  }

  openEvents(token: string, sessionId: string, response: ServerResponse): void {
    this.requireConnected(token, sessionId);
    this.currentSnapshot = null;
    this.boundProjectId = null;
    this.eventResponse = response;
    response.once('close', () => {
      if (this.eventResponse === response) {
        this.clearBridgeSession();
      }
    });
    this.canvas.openEvents(sessionId, response);
  }

  publish(token: string, value: unknown, sessionId: string): void {
    this.requireConnected(token, sessionId);
    const snapshot = this.canvas.updateState(sessionId, value);
    if (this.boundProjectId && this.boundProjectId !== snapshot.projectId) {
      this.resetCanvas('active_project_mismatch');
      throw new CanvasAgentError('ACTIVE_PROJECT_MISMATCH', 'The companion is bound to a different active project.');
    }
    this.boundProjectId ??= snapshot.projectId;
    this.currentSnapshot = snapshot;
  }

  resolveProposal(
    token: string,
    sessionId: string,
    proposalId: string,
    status: Exclude<CanvasProposalStatus, 'pending'>,
    result?: unknown,
    error?: string,
  ): CanvasProposalRecord {
    this.requireConnected(token, sessionId);
    return this.canvas.resolveProposal(sessionId, proposalId, status, result, error);
  }

  resolveAction(
    token: string,
    sessionId: string,
    actionId: string,
    status: Exclude<CanvasProposalStatus, 'pending'>,
    result?: unknown,
    error?: string,
  ): CanvasActionRecord {
    this.requireConnected(token, sessionId);
    return this.canvas.resolveAction(sessionId, actionId, status, result, error);
  }

  disconnect(token: string, sessionId: string): void {
    this.requireConnected(token, sessionId);
    this.close('canvas_disconnected');
  }

  async callTool(name: CanvasAgentToolName, input: Record<string, unknown>): Promise<unknown> {
    this.requireSession();
    const capability = capabilityForTool(name);
    if (!this.negotiatedCapabilities.includes(capability)) {
      throw new CanvasAgentError('CAPABILITY_NOT_NEGOTIATED', `Capability ${capability} was not negotiated.`);
    }
    if (name !== 'canvas_get_change_status' && name !== 'canvas_get_action_status') {
      this.requireLiveCanvas();
    }
    if (isWebCanvasWriteTool(name) && this.currentSnapshot?.writeAccess !== true) {
      throw new CanvasAgentError(
        'PROJECT_WRITE_NOT_AUTHORIZED',
        'The current Lumina project is read-only for external Agent writes.'
      );
    }
    return this.canvas.callTool(name, input);
  }

  close(reason = 'session_closed'): void {
    this.clearBridgeSession();
    this.canvas.close(reason);
  }

  private requireLiveCanvas(): void {
    if (!this.currentSnapshot || !this.boundProjectId) {
      throw new CanvasAgentError('NO_ACTIVE_CANVAS', 'No active Lumina canvas is connected.');
    }
  }

  private requireSession(): WebCanvasBootstrap {
    const bootstrap = this.bootstrap;
    if (!bootstrap || !this.bootstrapConsumed || this.negotiatedCapabilities.length === 0) {
      throw new CanvasAgentError('NO_ACTIVE_CANVAS', 'No active Lumina canvas is connected.');
    }
    return bootstrap;
  }

  private requireConnected(token: string, sessionId: string): void {
    const bootstrap = this.bootstrap;
    if (!bootstrap || bootstrap.sessionId !== sessionId || !tokensMatch(token, bootstrap.token)) {
      throw new CanvasAgentError('UNAUTHORIZED', 'The canvas bridge token is invalid.');
    }
    this.requireSession();
  }

  private requireBootstrap(token: string, sessionId: string): WebCanvasBootstrap {
    const bootstrap = this.bootstrap;
    if (!bootstrap || bootstrap.sessionId !== sessionId || !tokensMatch(token, bootstrap.token)) {
      throw new CanvasAgentError('UNAUTHORIZED', 'The canvas bridge token is invalid.');
    }
    if (this.now() >= bootstrap.expiresAt) {
      this.close();
      throw new CanvasAgentError('SESSION_EXPIRED', 'The canvas bridge session has expired.');
    }
    return bootstrap;
  }

  private resetCanvas(reason: string): void {
    this.clearBridgeSession();
    this.canvas.close(reason);
  }

  private clearBridgeSession(): void {
    this.bootstrap = null;
    this.bootstrapConsumed = false;
    this.negotiatedCapabilities = [];
    this.boundProjectId = null;
    this.currentSnapshot = null;
    this.eventResponse = null;
  }
}

function tokensMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
