import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core';
import { getVersion as getTauriVersion } from '@tauri-apps/api/app';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl as openTauriUrl } from '@tauri-apps/plugin-opener';
import { webProjectRepository } from '@/features/project/infrastructure/webProjectRepository';
import type { ProjectRecord } from '@/features/project/domain/projectRepository';

export type RuntimeMode = 'tauri' | 'web';
export type { ProjectRecord as RuntimeProjectRecord } from '@/features/project/domain/projectRepository';

type RuntimeCommandArgs = Record<string, unknown> | undefined;

function unsupportedWebCommand(command: string): never {
  throw new Error(`Web runtime does not support command "${command}" yet`);
}

async function invokeWeb<T>(command: string, args?: RuntimeCommandArgs): Promise<T> {
  switch (command) {
    case 'list_project_summaries':
      return (await webProjectRepository.listSummaries()) as T;
    case 'get_project_record':
      return (await webProjectRepository.get(String(args?.projectId))) as T;
    case 'upsert_project_record': {
      const record = args?.record;
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('Invalid project record');
      }
      await webProjectRepository.saveSnapshot(record as ProjectRecord);
      return undefined as T;
    }
    case 'update_project_viewport_record': {
      const projectId = String(args?.projectId);
      const current = await webProjectRepository.get(projectId);
      await webProjectRepository.updateViewport(
        projectId,
        String(args?.viewportJson ?? current?.viewportJson ?? '')
      );
      return undefined as T;
    }
    case 'rename_project_record': {
      const projectId = String(args?.projectId);
      const current = await webProjectRepository.get(projectId);
      await webProjectRepository.rename(
        projectId,
        String(args?.name ?? current?.name ?? ''),
        Number(args?.updatedAt ?? current?.updatedAt)
      );
      return undefined as T;
    }
    case 'delete_project_record':
      await webProjectRepository.delete(String(args?.projectId));
      return undefined as T;
    case 'create_project_dirs':
      await webProjectRepository.createProjectDirs(
        String(args?.projectId),
        String(args?.projectName ?? '')
      );
      return undefined as T;
    default:
      return unsupportedWebCommand(command);
  }
}

/**
 * The only runtime composition boundary. UI and application code can use this
 * object without deciding whether the current host is Tauri or a browser.
 */
export const runtime = {
  mode: (): RuntimeMode => (isTauri() ? 'tauri' : 'web'),
  isDesktop: (): boolean => isTauri(),
  invoke: async <T>(command: string, args?: RuntimeCommandArgs): Promise<T> =>
    isTauri()
      ? args === undefined
        ? tauriInvoke<T>(command)
        : tauriInvoke<T>(command, args)
      : invokeWeb<T>(command, args),
  notifyFrontendReady: async (): Promise<void> => {
    if (isTauri()) {
      await tauriInvoke('frontend_ready');
    }
  },
  getAppVersion: async (): Promise<string> => {
    if (isTauri()) {
      return getTauriVersion();
    }
    return import.meta.env.VITE_APP_VERSION || '0.2.37';
  },
  openDirectory: async (): Promise<string | null> => {
    if (!isTauri()) {
      return null;
    }
    const selected = await openDialog({ directory: true, multiple: false });
    return typeof selected === 'string' ? selected : null;
  },
  openUrl: async (url: string): Promise<void> => {
    if (isTauri()) {
      await openTauriUrl(url);
      return;
    }
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  },
};

export function getRuntimeMode(): RuntimeMode {
  return runtime.mode();
}
