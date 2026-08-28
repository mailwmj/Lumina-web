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
const PROJECT_REBIND_TTL_MS = 10_000;

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

export interface RuntimeProjectAuthority {
  renewCodexLease(codexSessionId: string, projectId: string): { mode: 'codex'; projectId: string; expiresAt: number };
  revokeCodexLease(codexSessionId: string, projectId: string): boolean;
  createCodexDelegation(
    codexSessionId: string,
    projectId: string,
    actionId: string,
  ): { token: string; actionId: string; expiresAt: number };
}

interface WebCanvasSessionOptions {
  now?: () => number;
  createToken?: () => string;
  createSessionId?: () => string;
  projectService?: RuntimeProjectAuthority;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export class WebCanvasSession {
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly createSessionId: () => string;
  private readonly projectService?: RuntimeProjectAuthority;
  private readonly scheduleTimeout: typeof globalThis.setTimeout;
  private readonly cancelTimeout: typeof globalThis.clearTimeout;
  private canvas = new CanvasSession();
  private bootstrap: WebCanvasBootstrap | null = null;
  private bootstrapConsumed = false;
  private negotiatedCapabilities: WebCanvasCapability[] = [];
  private boundProjectId: string | null = null;
  private currentSnapshot: CanvasSnapshot | null = null;
  private eventResponse: ServerResponse | null = null;
  private codexEditingSessionId: string | null = null;
  private codexEditingProjectId: string | null = null;
  private leaseRenewalTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingProjectRebind: {
    type: 'create_project' | 'open_project';
    expectedProjectId: string | null;
  } | null = null;
  private projectRebindTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WebCanvasSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createToken = options.createToken ?? (() => crypto.randomBytes(32).toString('base64url'));
    this.createSessionId = options.createSessionId ?? crypto.randomUUID;
    this.projectService = options.projectService;
    this.scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
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
      if (!this.canAcceptProjectRebind(snapshot.projectId)) {
        this.resetCanvas('active_project_mismatch');
        throw new CanvasAgentError('ACTIVE_PROJECT_MISMATCH', 'The companion is bound to a different active project.');
      }
      this.clearCodexEditingAuthority();
      this.boundProjectId = snapshot.projectId;
      this.clearPendingProjectRebind();
    } else if (!this.boundProjectId && this.pendingProjectRebind) {
      if (!this.canAcceptProjectRebind(snapshot.projectId)) {
        this.resetCanvas('active_project_mismatch');
        throw new CanvasAgentError('ACTIVE_PROJECT_MISMATCH', 'The browser opened an unexpected project.');
      }
      this.clearPendingProjectRebind();
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
    const proposal = this.canvas.resolveProposal(sessionId, proposalId, status, result, error);
    if (status === 'failed' && this.codexEditingSessionId === sessionId) {
      this.close('canvas_action_failed');
    }
    return proposal;
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
    const action = this.canvas.resolveAction(sessionId, actionId, status, result, error);
    if (action.request.type === 'create_project' || action.request.type === 'open_project') {
      if (status === 'applied') {
        const projectId = readProjectActionResultId(result);
        if (
          projectId
          && (action.request.type === 'create_project' || action.request.projectId === projectId)
        ) {
          this.pendingProjectRebind = {
            type: action.request.type,
            expectedProjectId: projectId,
          };
          this.scheduleProjectRebindExpiry(this.pendingProjectRebind);
        } else {
          this.clearPendingProjectRebind();
        }
      } else {
        this.clearPendingProjectRebind();
      }
    }
    if (status === 'failed' && this.codexEditingSessionId === sessionId) {
      this.close('canvas_action_failed');
    }
    return action;
  }

  enableCodexEditing(token: string, sessionId: string): void {
    this.requireConnected(token, sessionId);
    if (!this.projectService) {
      throw new CanvasAgentError(
        'RUNTIME_UNAVAILABLE',
        'The Runtime editor authority is unavailable.',
      );
    }
    const projectId = this.requireBoundProjectId();
    const lease = this.projectService.renewCodexLease(sessionId, projectId);
    this.codexEditingSessionId = sessionId;
    this.codexEditingProjectId = projectId;
    this.scheduleLeaseRenewal(sessionId, projectId, lease.expiresAt);
  }

  createDelegation(
    token: string,
    sessionId: string,
    actionId: string,
  ): { token: string; actionId: string; expiresAt: number } {
    this.requireConnected(token, sessionId);
    const projectId = this.requireBoundProjectId();
    if (
      !this.projectService
      || this.codexEditingSessionId !== sessionId
      || this.codexEditingProjectId !== projectId
    ) {
      throw new CanvasAgentError(
        'PROJECT_WRITE_NOT_AUTHORIZED',
        'Codex does not own the Runtime editor lease.',
      );
    }
    const lease = this.projectService.renewCodexLease(sessionId, projectId);
    this.scheduleLeaseRenewal(sessionId, projectId, lease.expiresAt);
    return this.projectService.createCodexDelegation(sessionId, projectId, actionId);
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
    if (
      name !== 'canvas_get_change_status'
      && name !== 'canvas_get_action_status'
      && name !== 'canvas_list_projects'
      && name !== 'canvas_create_project'
      && name !== 'canvas_open_project'
    ) {
      this.requireLiveCanvas();
    }
    if (isWebCanvasWriteTool(name) && this.currentSnapshot?.writeAccess !== true) {
      throw new CanvasAgentError(
        'PROJECT_WRITE_NOT_AUTHORIZED',
        'The current Lumina project is read-only for external Agent writes.'
      );
    }
    const pendingRebind = projectRebindForTool(name, input);
    if (pendingRebind) {
      if (this.pendingProjectRebind) {
        throw new CanvasAgentError(
          'PROJECT_SWITCH_IN_PROGRESS',
          'Another project create or open request is still in progress.',
        );
      }
      this.pendingProjectRebind = pendingRebind;
    }
    try {
      return await this.canvas.callTool(name, input);
    } catch (error) {
      if (pendingRebind && this.pendingProjectRebind === pendingRebind) {
        this.clearPendingProjectRebind();
      }
      throw error;
    }
  }

  close(reason = 'session_closed'): void {
    this.clearBridgeSession();
    this.canvas.close(reason);
  }

  private scheduleLeaseRenewal(sessionId: string, projectId: string, expiresAt: number): void {
    if (this.leaseRenewalTimer) {
      this.cancelTimeout(this.leaseRenewalTimer);
    }
    const delay = Math.max(1_000, Math.floor((expiresAt - this.now()) / 2));
    this.leaseRenewalTimer = this.scheduleTimeout(() => {
      this.leaseRenewalTimer = null;
      if (
        this.codexEditingSessionId !== sessionId
        || this.codexEditingProjectId !== projectId
        || !this.projectService
      ) {
        return;
      }
      try {
        const lease = this.projectService.renewCodexLease(sessionId, projectId);
        this.scheduleLeaseRenewal(sessionId, projectId, lease.expiresAt);
      } catch {
        this.close('editor_lease_lost');
      }
    }, delay);
  }

  private requireLiveCanvas(): void {
    if (!this.currentSnapshot || !this.boundProjectId) {
      throw new CanvasAgentError('NO_ACTIVE_CANVAS', 'No active Lumina canvas is connected.');
    }
  }

  private requireBoundProjectId(): string {
    this.requireLiveCanvas();
    return this.boundProjectId as string;
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
    this.clearCodexEditingAuthority();
    this.clearPendingProjectRebind();
    this.bootstrap = null;
    this.bootstrapConsumed = false;
    this.negotiatedCapabilities = [];
    this.boundProjectId = null;
    this.currentSnapshot = null;
    this.eventResponse = null;
  }

  private canAcceptProjectRebind(projectId: string): boolean {
    const pending = this.pendingProjectRebind;
    return Boolean(pending?.expectedProjectId === projectId);
  }

  private scheduleProjectRebindExpiry(
    pending: NonNullable<WebCanvasSession['pendingProjectRebind']>,
  ): void {
    if (this.projectRebindTimer) {
      this.cancelTimeout(this.projectRebindTimer);
    }
    this.projectRebindTimer = this.scheduleTimeout(() => {
      this.projectRebindTimer = null;
      if (this.pendingProjectRebind === pending) {
        this.pendingProjectRebind = null;
      }
    }, PROJECT_REBIND_TTL_MS);
  }

  private clearPendingProjectRebind(): void {
    if (this.projectRebindTimer) {
      this.cancelTimeout(this.projectRebindTimer);
      this.projectRebindTimer = null;
    }
    this.pendingProjectRebind = null;
  }

  private clearCodexEditingAuthority(): void {
    if (this.leaseRenewalTimer) {
      this.cancelTimeout(this.leaseRenewalTimer);
      this.leaseRenewalTimer = null;
    }
    const codexSessionId = this.codexEditingSessionId;
    const codexProjectId = this.codexEditingProjectId;
    this.codexEditingSessionId = null;
    this.codexEditingProjectId = null;
    if (codexSessionId && codexProjectId && this.projectService) {
      try {
        this.projectService.revokeCodexLease(codexSessionId, codexProjectId);
      } catch {
        // Expiry or Runtime shutdown already revoked this authority.
      }
    }
  }
}

function projectRebindForTool(
  name: CanvasAgentToolName,
  input: Record<string, unknown>,
): { type: 'create_project' | 'open_project'; expectedProjectId: string | null } | null {
  if (name === 'canvas_create_project') {
    return { type: 'create_project', expectedProjectId: null };
  }
  if (name === 'canvas_open_project') {
    return { type: 'open_project', expectedProjectId: String(input.projectId ?? '') };
  }
  return null;
}

function readProjectActionResultId(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }
  const project = (result as { project?: unknown }).project;
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return null;
  }
  const projectId = (project as { id?: unknown }).id;
  return typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null;
}

function tokensMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
