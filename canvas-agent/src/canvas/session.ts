import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';

import {
  CANVAS_AGENT_PROTOCOL_VERSION,
  CanvasAgentError,
  type CanvasActionRecord,
  type CanvasActionRequest,
  type CanvasAgentToolName,
  type CanvasChangeSet,
  type CanvasProposalRecord,
  type CanvasProposalStatus,
  type CanvasSnapshot,
  type CanvasWaitForNodesInput,
} from './protocol.js';
import {
  buildNodeProgress,
  fingerprintNodeProgress,
  type CanvasNodeProgressResult,
} from './nodeProgress.js';

const ACTIVE_CANVAS_TTL_MS = 15_000;
const PROPOSAL_TTL_MS = 10 * 60_000;
const MAX_RETAINED_PROPOSALS = 100;
const ACTION_FAST_WAIT_MS = 8_000;
const PROPOSAL_FAST_WAIT_MS = 750;
const MAX_SELECTED_IMAGE_PREVIEWS = 6;
const MAX_PREVIEW_DATA_URL_LENGTH = 1_500_000;

interface CanvasClientState {
  snapshot: CanvasSnapshot;
  updatedAt: number;
}

interface CanvasNodeWaiter {
  clientId: string;
  projectId: string;
  nodeIds: string[];
  baselineFingerprint: string;
  resolve: (result: CanvasNodeProgressResult) => void;
  reject: (error: CanvasAgentError) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class CanvasSession {
  private readonly clients = new Map<string, ServerResponse>();
  private readonly canvasStates = new Map<string, CanvasClientState>();
  private readonly proposals = new Map<string, CanvasProposalRecord>();
  private readonly actions = new Map<string, CanvasActionRecord>();
  private readonly actionWaiters = new Map<
    string,
    (record: CanvasActionRecord) => void
  >();
  private readonly proposalWaiters = new Map<
    string,
    (record: CanvasProposalRecord) => void
  >();
  private readonly nodeWaiters = new Set<CanvasNodeWaiter>();
  private activeClientId = '';

  constructor(
    private readonly actionFastWaitMs = ACTION_FAST_WAIT_MS,
    private readonly proposalFastWaitMs = PROPOSAL_FAST_WAIT_MS
  ) {}

  health(includeActiveProject = false): {
    ok: true;
    protocolVersion: number;
    hasActiveCanvas: boolean;
    readiness: 'waiting_for_canvas' | 'connecting' | 'ready';
    activeProject?: { id: string; name: string };
  } {
    const activeState = this.resolveActiveState(false);
    return {
      ok: true,
      protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION,
      hasActiveCanvas: Boolean(activeState),
      readiness: activeState
        ? 'ready'
        : this.clients.size > 0
          ? 'connecting'
          : 'waiting_for_canvas',
      ...(activeState && includeActiveProject ? {
        activeProject: {
          id: activeState.snapshot.projectId,
          name: activeState.snapshot.projectName,
        },
      } : {}),
    };
  }

  openEvents(clientId: string, response: ServerResponse): void {
    const resolvedClientId = clientId || crypto.randomUUID();
    const previous = this.clients.get(resolvedClientId);
    if (previous && previous !== response) {
      this.markClientRequestsStale(resolvedClientId, 'canvas_disconnected');
      previous.end();
    }
    this.canvasStates.delete(resolvedClientId);
    this.clients.set(resolvedClientId, response);
    this.activeClientId = resolvedClientId;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sendEvent(response, 'hello', {
      ok: true,
      protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION,
      clientId: resolvedClientId,
    });
    const timer = setInterval(() => sendEvent(response, 'ping', { time: Date.now() }), 10_000);
    response.on('close', () => {
      clearInterval(timer);
      if (this.clients.get(resolvedClientId) !== response) {
        return;
      }
      this.clients.delete(resolvedClientId);
      this.canvasStates.delete(resolvedClientId);
      this.markClientRequestsStale(resolvedClientId, 'canvas_disconnected');
      this.rejectNodeWaiters(
        resolvedClientId,
        new CanvasAgentError('NO_ACTIVE_CANVAS', 'The Lumina canvas disconnected while waiting for node progress.')
      );
      if (this.activeClientId === resolvedClientId) {
        this.activeClientId = [...this.clients.keys()][0] ?? '';
      }
    });
  }

  updateState(clientId: string, value: unknown): void {
    if (!clientId || !this.clients.has(clientId)) {
      throw new CanvasAgentError('CANVAS_NOT_CONNECTED', 'The Lumina canvas event stream is not connected.');
    }
    const previous = this.canvasStates.get(clientId)?.snapshot;
    const snapshot = parseCanvasSnapshot(value, previous);
    this.canvasStates.set(clientId, { snapshot, updatedAt: Date.now() });
    this.activeClientId = clientId;
    if (
      previous
      && (previous.projectId !== snapshot.projectId || previous.revision !== snapshot.revision)
    ) {
      this.proposals.forEach((proposal) => {
        if (
          proposal.clientId === clientId
          && proposal.status === 'pending'
          && (
            proposal.changeSet.projectId !== snapshot.projectId
            || proposal.changeSet.baseRevision !== snapshot.revision
          )
        ) {
          this.updateProposalRecord(proposal, 'stale', undefined, 'canvas_changed');
        }
      });
    }
    this.resolveNodeWaiters(clientId, snapshot);
  }

  resolveProposal(
    clientId: string,
    proposalId: string,
    status: Exclude<CanvasProposalStatus, 'pending'>,
    result?: unknown,
    error?: string
  ): CanvasProposalRecord {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.clientId !== clientId) {
      throw new CanvasAgentError('PROPOSAL_NOT_FOUND', 'The canvas change proposal was not found.');
    }
    if (
      proposal.status !== 'pending'
      && !(proposal.status === 'stale' && proposal.error === 'canvas_changed' && status === 'applied')
    ) {
      return proposal;
    }
    this.updateProposalRecord(proposal, status, result, error);
    return proposal;
  }

  resolveAction(
    clientId: string,
    actionId: string,
    status: Exclude<CanvasProposalStatus, 'pending'>,
    result?: unknown,
    error?: string
  ): CanvasActionRecord {
    const action = this.actions.get(actionId);
    if (!action || action.clientId !== clientId) {
      throw new CanvasAgentError('ACTION_NOT_FOUND', 'The canvas action was not found.');
    }
    if (action.status !== 'pending') {
      return action;
    }
    this.updateActionRecord(action, status, result, error);
    return action;
  }

  async callTool(name: CanvasAgentToolName, input: Record<string, unknown>): Promise<unknown> {
    this.pruneRequests();
    if (name === 'canvas_get_change_status') {
      return this.getProposalStatus(String(input.proposalId ?? ''));
    }
    if (name === 'canvas_get_action_status') {
      return this.getActionStatus(String(input.actionId ?? ''));
    }

    const { clientId, snapshot } = this.requireActiveState();
    if (name === 'canvas_get_state') {
      return snapshot;
    }
    if (name === 'canvas_get_selection') {
      const selectedIds = new Set(snapshot.selectedNodeIds);
      return {
        projectId: snapshot.projectId,
        revision: snapshot.revision,
        nodes: snapshot.nodes.filter((node) => selectedIds.has(node.id)),
        imagePreviews: snapshot.selectedImagePreviews,
      };
    }
    if (name === 'canvas_get_capabilities') {
      return {
        projectId: snapshot.projectId,
        revision: snapshot.revision,
        capabilities: snapshot.capabilities,
      };
    }
    if (name === 'canvas_wait_for_nodes') {
      return this.waitForNodes(
        clientId,
        snapshot,
        input as unknown as CanvasWaitForNodesInput
      );
    }

    if (name === 'canvas_import_images') {
      return this.createAction(clientId, snapshot, {
        type: 'import_images',
        ...(input as Omit<Extract<CanvasActionRequest, { type: 'import_images' }>, 'type'>),
      });
    }
    if (name === 'canvas_run_nodes') {
      return this.createAction(clientId, snapshot, {
        type: 'run_nodes',
        ...(input as Omit<Extract<CanvasActionRequest, { type: 'run_nodes' }>, 'type'>),
      });
    }
    if (name === 'canvas_get_node_images') {
      return this.createAction(clientId, snapshot, {
        type: 'get_node_images',
        ...(input as Omit<Extract<CanvasActionRequest, { type: 'get_node_images' }>, 'type'>),
      });
    }

    return this.createProposal(clientId, snapshot, input as unknown as CanvasChangeSet);
  }

  private async createProposal(
    clientId: string,
    snapshot: CanvasSnapshot,
    changeSet: CanvasChangeSet
  ): Promise<Omit<CanvasProposalRecord, 'clientId' | 'changeSet'>> {
    if (changeSet.projectId !== snapshot.projectId) {
      throw new CanvasAgentError('PROJECT_CHANGED', 'The active Lumina project no longer matches the proposal.', {
        activeProjectId: snapshot.projectId,
      });
    }
    if (changeSet.baseRevision !== snapshot.revision) {
      throw new CanvasAgentError('REVISION_STALE', 'The canvas changed after the Agent read it.', {
        activeRevision: snapshot.revision,
      });
    }
    this.ensureNoPendingRequest(clientId);

    const now = Date.now();
    const proposal: CanvasProposalRecord = {
      proposalId: crypto.randomUUID(),
      clientId,
      changeSet,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.proposals.set(proposal.proposalId, proposal);
    const client = this.clients.get(clientId);
    if (!client) {
      this.updateProposalRecord(proposal, 'stale', undefined, 'canvas_disconnected');
      throw new CanvasAgentError('NO_ACTIVE_CANVAS', 'No active Lumina canvas is connected.');
    }
    const completion = new Promise<CanvasProposalRecord>((resolve) => {
      this.proposalWaiters.set(proposal.proposalId, resolve);
    });
    sendEvent(client, 'change_proposal', {
      proposalId: proposal.proposalId,
      changeSet: proposal.changeSet,
      createdAt: proposal.createdAt,
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      completion,
      new Promise<CanvasProposalRecord>((resolve) => {
        timeout = setTimeout(() => resolve(proposal), this.proposalFastWaitMs);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (completed.status === 'pending') {
      this.proposalWaiters.delete(proposal.proposalId);
    }
    return this.toProposalStatus(completed);
  }

  private async createAction(
    clientId: string,
    snapshot: CanvasSnapshot,
    request: CanvasActionRequest
  ): Promise<Omit<CanvasActionRecord, 'clientId' | 'request'>> {
    if (request.projectId !== snapshot.projectId) {
      throw new CanvasAgentError('PROJECT_CHANGED', 'The active Lumina project no longer matches the action.', {
        activeProjectId: snapshot.projectId,
      });
    }
    if ('baseRevision' in request && request.baseRevision !== snapshot.revision) {
      throw new CanvasAgentError('REVISION_STALE', 'The canvas changed after the Agent read it.', {
        activeRevision: snapshot.revision,
      });
    }
    this.ensureNoPendingRequest(clientId);

    const now = Date.now();
    const action: CanvasActionRecord = {
      actionId: crypto.randomUUID(),
      clientId,
      request,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.actions.set(action.actionId, action);
    const client = this.clients.get(clientId);
    if (!client) {
      this.updateActionRecord(action, 'stale', undefined, 'canvas_disconnected');
      throw new CanvasAgentError('NO_ACTIVE_CANVAS', 'No active Lumina canvas is connected.');
    }

    const completion = new Promise<CanvasActionRecord>((resolve) => {
      this.actionWaiters.set(action.actionId, resolve);
    });
    sendEvent(client, 'action_request', {
      actionId: action.actionId,
      request: action.request,
      createdAt: action.createdAt,
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      completion,
      new Promise<CanvasActionRecord>((resolve) => {
        timeout = setTimeout(() => resolve(action), this.actionFastWaitMs);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (completed.status === 'pending') {
      this.actionWaiters.delete(action.actionId);
    }
    const status = this.toActionStatus(completed);
    this.compactDeliveredActionResult(completed);
    return status;
  }

  private getProposalStatus(proposalId: string): Omit<CanvasProposalRecord, 'clientId' | 'changeSet'> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new CanvasAgentError('PROPOSAL_NOT_FOUND', 'The canvas change proposal was not found.');
    }
    return this.toProposalStatus(proposal);
  }

  private toProposalStatus(
    proposal: CanvasProposalRecord
  ): Omit<CanvasProposalRecord, 'clientId' | 'changeSet'> {
    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      createdAt: proposal.createdAt,
      updatedAt: proposal.updatedAt,
      ...(proposal.result === undefined ? {} : { result: proposal.result }),
      ...(proposal.error ? { error: proposal.error } : {}),
    };
  }

  private waitForNodes(
    clientId: string,
    snapshot: CanvasSnapshot,
    input: CanvasWaitForNodesInput
  ): Promise<CanvasNodeProgressResult> {
    if (input.projectId !== snapshot.projectId) {
      throw new CanvasAgentError(
        'PROJECT_CHANGED',
        'The active Lumina project no longer matches the requested node progress.',
        { activeProjectId: snapshot.projectId }
      );
    }
    const nodeIds = [...new Set(input.nodeIds)];
    const initial = buildNodeProgress(snapshot, nodeIds, false, false);
    if (initial.summary.allTerminal) {
      return Promise.resolve(initial);
    }

    return new Promise<CanvasNodeProgressResult>((resolve, reject) => {
      const waiter: CanvasNodeWaiter = {
        clientId,
        projectId: input.projectId,
        nodeIds,
        baselineFingerprint: fingerprintNodeProgress(initial),
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.nodeWaiters.delete(waiter);
          const state = this.canvasStates.get(clientId);
          const current = state?.snapshot;
          if (
            !this.clients.has(clientId)
            || !state
            || Date.now() - state.updatedAt > ACTIVE_CANVAS_TTL_MS
            || current?.projectId !== input.projectId
          ) {
            reject(new CanvasAgentError(
              'NO_ACTIVE_CANVAS',
              'The Lumina canvas became unavailable while waiting for node progress.'
            ));
            return;
          }
          resolve(buildNodeProgress(current, nodeIds, false, true));
        }, input.timeoutMs),
      };
      this.nodeWaiters.add(waiter);
    });
  }

  private resolveNodeWaiters(clientId: string, snapshot: CanvasSnapshot): void {
    this.nodeWaiters.forEach((waiter) => {
      if (waiter.clientId !== clientId) {
        return;
      }
      if (waiter.projectId !== snapshot.projectId) {
        this.finishNodeWaiter(waiter, () => waiter.reject(new CanvasAgentError(
          'PROJECT_CHANGED',
          'The active Lumina project changed while waiting for node progress.',
          { activeProjectId: snapshot.projectId }
        )));
        return;
      }
      const current = buildNodeProgress(snapshot, waiter.nodeIds, true, false);
      if (
        current.summary.allTerminal
        || fingerprintNodeProgress(current) !== waiter.baselineFingerprint
      ) {
        this.finishNodeWaiter(waiter, () => waiter.resolve(current));
      }
    });
  }

  private rejectNodeWaiters(clientId: string, error: CanvasAgentError): void {
    this.nodeWaiters.forEach((waiter) => {
      if (waiter.clientId === clientId) {
        this.finishNodeWaiter(waiter, () => waiter.reject(error));
      }
    });
  }

  private finishNodeWaiter(waiter: CanvasNodeWaiter, finish: () => void): void {
    clearTimeout(waiter.timeout);
    this.nodeWaiters.delete(waiter);
    finish();
  }

  private getActionStatus(actionId: string): Omit<CanvasActionRecord, 'clientId' | 'request'> & {
    actionType: CanvasActionRequest['type'];
  } {
    const action = this.actions.get(actionId);
    if (!action) {
      throw new CanvasAgentError('ACTION_NOT_FOUND', 'The canvas action was not found.');
    }
    const status = this.toActionStatus(action);
    this.compactDeliveredActionResult(action);
    return status;
  }

  private toActionStatus(action: CanvasActionRecord): Omit<CanvasActionRecord, 'clientId' | 'request'> & {
    actionType: CanvasActionRequest['type'];
  } {
    return {
      actionId: action.actionId,
      actionType: action.request.type,
      status: action.status,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      ...(action.result === undefined ? {} : { result: action.result }),
      ...(action.error ? { error: action.error } : {}),
    };
  }

  private compactDeliveredActionResult(action: CanvasActionRecord): void {
    if (action.status === 'pending' || action.request.type !== 'get_node_images') {
      return;
    }
    action.result = omitDataUrls(action.result);
  }

  private requireActiveState(): { clientId: string; snapshot: CanvasSnapshot } {
    const state = this.resolveActiveState(true);
    if (!state) {
      throw new CanvasAgentError('NO_ACTIVE_CANVAS', 'No active Lumina canvas is connected.');
    }
    return state;
  }

  private resolveActiveState(
    throwOnExpired: boolean
  ): { clientId: string; snapshot: CanvasSnapshot } | null {
    const clientId = this.activeClientId;
    const state = this.canvasStates.get(clientId);
    if (!clientId || !this.clients.has(clientId) || !state) {
      return null;
    }
    if (Date.now() - state.updatedAt > ACTIVE_CANVAS_TTL_MS) {
      if (throwOnExpired) {
        throw new CanvasAgentError('NO_ACTIVE_CANVAS', 'The connected Lumina canvas stopped publishing live state.');
      }
      return null;
    }
    return { clientId, snapshot: state.snapshot };
  }

  private ensureNoPendingRequest(clientId: string): void {
    const pendingProposal = [...this.proposals.values()].find(
      (proposal) => proposal.clientId === clientId && proposal.status === 'pending'
    );
    const pendingAction = [...this.actions.values()].find(
      (action) => action.clientId === clientId && action.status === 'pending'
    );
    if (pendingProposal || pendingAction) {
      throw new CanvasAgentError('REQUEST_PENDING', 'Another canvas request is still being applied.', {
        ...(pendingProposal ? { proposalId: pendingProposal.proposalId } : {}),
        ...(pendingAction ? { actionId: pendingAction.actionId } : {}),
      });
    }
  }

  private markClientRequestsStale(clientId: string, reason: string): void {
    this.proposals.forEach((proposal) => {
      if (proposal.clientId === clientId && proposal.status === 'pending') {
        this.updateProposalRecord(proposal, 'stale', undefined, reason);
      }
    });
    this.actions.forEach((action) => {
      if (action.clientId === clientId && action.status === 'pending') {
        this.updateActionRecord(action, 'stale', undefined, reason);
      }
    });
  }

  private updateProposalRecord(
    proposal: CanvasProposalRecord,
    status: CanvasProposalStatus,
    result?: unknown,
    error?: string
  ): void {
    proposal.status = status;
    proposal.updatedAt = Date.now();
    proposal.result = result;
    proposal.error = error;
    const waiter = this.proposalWaiters.get(proposal.proposalId);
    const mayBeCommittedSnapshotRace = status === 'stale' && error === 'canvas_changed';
    if (waiter && !mayBeCommittedSnapshotRace) {
      this.proposalWaiters.delete(proposal.proposalId);
      waiter(proposal);
    }
  }

  private updateActionRecord(
    action: CanvasActionRecord,
    status: CanvasProposalStatus,
    result?: unknown,
    error?: string
  ): void {
    action.status = status;
    action.updatedAt = Date.now();
    action.result = result;
    action.error = error;
    const waiter = this.actionWaiters.get(action.actionId);
    if (waiter) {
      this.actionWaiters.delete(action.actionId);
      waiter(action);
    }
  }

  private pruneRequests(): void {
    const now = Date.now();
    this.proposals.forEach((proposal, proposalId) => {
      if (proposal.status === 'pending' && now - proposal.createdAt > PROPOSAL_TTL_MS) {
        this.updateProposalRecord(proposal, 'stale', undefined, 'proposal_expired');
      }
      if (now - proposal.updatedAt > PROPOSAL_TTL_MS) {
        this.proposals.delete(proposalId);
      }
    });
    while (this.proposals.size > MAX_RETAINED_PROPOSALS) {
      const oldestId = this.proposals.keys().next().value as string | undefined;
      if (!oldestId) {
        break;
      }
      this.proposals.delete(oldestId);
    }
    this.actions.forEach((action, actionId) => {
      if (action.status === 'pending' && now - action.createdAt > PROPOSAL_TTL_MS) {
        this.updateActionRecord(action, 'stale', undefined, 'action_expired');
      }
      if (now - action.updatedAt > PROPOSAL_TTL_MS) {
        this.actions.delete(actionId);
      }
    });
    while (this.actions.size > MAX_RETAINED_PROPOSALS) {
      const oldestId = this.actions.keys().next().value as string | undefined;
      if (!oldestId) {
        break;
      }
      this.actions.delete(oldestId);
    }
  }
}

function parseCanvasSnapshot(
  value: unknown,
  previous?: CanvasSnapshot
): CanvasSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanvasAgentError('INVALID_SNAPSHOT', 'The canvas snapshot is invalid.');
  }
  const snapshot = value as Partial<CanvasSnapshot>;
  if (
    snapshot.protocolVersion !== CANVAS_AGENT_PROTOCOL_VERSION
    || typeof snapshot.projectId !== 'string'
    || !snapshot.projectId
    || typeof snapshot.projectName !== 'string'
    || typeof snapshot.revision !== 'string'
    || !snapshot.revision
    || !Array.isArray(snapshot.nodes)
    || !Array.isArray(snapshot.edges)
    || !Array.isArray(snapshot.selectedNodeIds)
    || !snapshot.viewport
    || snapshot.capabilities === undefined
  ) {
    throw new CanvasAgentError('INVALID_SNAPSHOT', 'The canvas snapshot is missing required fields.');
  }
  if (
    !snapshot.selectedNodeIds.every((nodeId) => typeof nodeId === 'string')
    || typeof snapshot.viewport.x !== 'number'
    || !Number.isFinite(snapshot.viewport.x)
    || typeof snapshot.viewport.y !== 'number'
    || !Number.isFinite(snapshot.viewport.y)
    || typeof snapshot.viewport.zoom !== 'number'
    || !Number.isFinite(snapshot.viewport.zoom)
  ) {
    throw new CanvasAgentError('INVALID_SNAPSHOT', 'The canvas snapshot contains invalid live state.');
  }

  const sameProject = previous?.projectId === snapshot.projectId;
  const rawPreviews = snapshot.selectedImagePreviews;
  const selectedNodeIds = new Set(snapshot.selectedNodeIds);
  const selectedImagePreviews = rawPreviews === undefined
    ? (sameProject ? previous?.selectedImagePreviews ?? [] : [])
    : parseSelectedImagePreviews(rawPreviews);

  return {
    ...(snapshot as CanvasSnapshot),
    selectedImagePreviews: selectedImagePreviews.filter((preview) => (
      selectedNodeIds.has(preview.nodeId)
    )),
  };
}

function omitDataUrls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitDataUrls);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'dataUrl')
      .map(([key, entry]) => [key, omitDataUrls(entry)])
  );
}

function parseSelectedImagePreviews(value: unknown): CanvasSnapshot['selectedImagePreviews'] {
  if (!Array.isArray(value) || value.length > MAX_SELECTED_IMAGE_PREVIEWS) {
    throw new CanvasAgentError('INVALID_SNAPSHOT', 'The selected image preview list is invalid.');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new CanvasAgentError('INVALID_SNAPSHOT', 'A selected image preview is invalid.');
    }
    const preview = item as Record<string, unknown>;
    if (
      typeof preview.nodeId !== 'string'
      || !preview.nodeId
      || typeof preview.mimeType !== 'string'
      || !preview.mimeType.startsWith('image/')
      || typeof preview.dataUrl !== 'string'
      || !preview.dataUrl.startsWith('data:image/')
      || preview.dataUrl.length > MAX_PREVIEW_DATA_URL_LENGTH
    ) {
      throw new CanvasAgentError('INVALID_SNAPSHOT', 'A selected image preview is invalid.');
    }
    return {
      nodeId: preview.nodeId,
      mimeType: preview.mimeType,
      dataUrl: preview.dataUrl,
    };
  });
}

function sendEvent(response: ServerResponse, type: string, payload: unknown): void {
  response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
