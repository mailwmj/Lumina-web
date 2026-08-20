import { invoke, isTauri } from '@tauri-apps/api/core';

export interface CanvasAgentRuntimeInfo {
  available: boolean;
  running: boolean;
  url: string | null;
  token: string | null;
  registrationCommand: string | null;
  error: string | null;
}

export interface CanvasAgentHealthInfo {
  ok: true;
  protocolVersion: number;
  hasActiveCanvas: boolean;
  readiness: 'waiting_for_canvas' | 'connecting' | 'ready';
  activeProject?: {
    id: string;
    name: string;
  };
}

export function isCanvasAgentManagedByLumina(): boolean {
  return isTauri();
}

export async function getCanvasAgentRuntime(): Promise<CanvasAgentRuntimeInfo | null> {
  if (!isTauri()) {
    return null;
  }
  return await invoke<CanvasAgentRuntimeInfo>('get_canvas_agent_runtime');
}

export async function getCanvasAgentHealth(
  url: string,
  token: string
): Promise<CanvasAgentHealthInfo> {
  const response = await fetch(`${url.replace(/\/$/, '')}/health`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`Canvas Agent health check failed with status ${response.status}.`);
  }
  const value = await response.json() as Partial<CanvasAgentHealthInfo>;
  if (
    value.ok !== true
    || typeof value.protocolVersion !== 'number'
    || typeof value.hasActiveCanvas !== 'boolean'
    || !isCanvasAgentReadiness(value.readiness)
  ) {
    throw new Error('Canvas Agent health response is invalid.');
  }
  return value as CanvasAgentHealthInfo;
}

function isCanvasAgentReadiness(
  value: unknown
): value is CanvasAgentHealthInfo['readiness'] {
  return value === 'waiting_for_canvas' || value === 'connecting' || value === 'ready';
}
