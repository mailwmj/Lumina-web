import { invoke, isTauri } from '@tauri-apps/api/core';
import { logger } from '@/lib/logger';

export interface RuntimeSystemInfo {
  osName: string;
  osVersion: string;
  osBuild: string;
}

export async function getRuntimeSystemInfo(): Promise<RuntimeSystemInfo | null> {
  if (!isTauri()) {
    return null;
  }

  try {
    return await invoke<RuntimeSystemInfo>('get_runtime_system_info');
  } catch (error) {
    logger.warn('failed to get runtime system info from tauri', error);
    return null;
  }
}
