import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core';
import { getVersion as getTauriVersion } from '@tauri-apps/api/app';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl as openTauriUrl } from '@tauri-apps/plugin-opener';

export type RuntimeMode = 'tauri' | 'web';

export interface RuntimeProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  nodesJson: string;
  edgesJson: string;
  viewportJson: string;
  historyJson: string;
}

type RuntimeCommandArgs = Record<string, unknown> | undefined;

const WEB_PROJECTS_STORAGE_KEY = 'lumina.web.projects.v1';
const webProjectMemory = new Map<string, RuntimeProjectRecord>();

function getWebStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readWebProjects(): Map<string, RuntimeProjectRecord> {
  const storage = getWebStorage();
  if (!storage) {
    return new Map(webProjectMemory);
  }

  try {
    const parsed = JSON.parse(storage.getItem(WEB_PROJECTS_STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Map();
    }
    return new Map(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, RuntimeProjectRecord] =>
          Boolean(entry[1]) && typeof entry[1] === 'object' && !Array.isArray(entry[1])
      )
    );
  } catch {
    return new Map(webProjectMemory);
  }
}

function writeWebProjects(projects: Map<string, RuntimeProjectRecord>): void {
  webProjectMemory.clear();
  for (const [id, record] of projects) {
    webProjectMemory.set(id, record);
  }

  const storage = getWebStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(WEB_PROJECTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(projects)));
  } catch {
    // A quota error must not prevent the Web shell from opening. The in-memory copy
    // remains available for the current session and the caller receives no fake Tauri error.
  }
}

function unsupportedWebCommand(command: string): never {
  throw new Error(`Web runtime does not support command "${command}" yet`);
}

async function invokeWeb<T>(command: string, args?: RuntimeCommandArgs): Promise<T> {
  const projects = readWebProjects();

  switch (command) {
    case 'list_project_summaries': {
      const summaries = [...projects.values()]
        .map(({ id, name, createdAt, updatedAt, nodeCount }) => ({
          id,
          name,
          createdAt,
          updatedAt,
          nodeCount,
        }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
      return summaries as T;
    }
    case 'get_project_record':
      return (projects.get(String(args?.projectId)) ?? null) as T;
    case 'upsert_project_record': {
      const record = args?.record;
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('Invalid project record');
      }
      const typedRecord = record as RuntimeProjectRecord;
      projects.set(typedRecord.id, typedRecord);
      writeWebProjects(projects);
      return undefined as T;
    }
    case 'update_project_viewport_record': {
      const projectId = String(args?.projectId);
      const record = projects.get(projectId);
      if (record) {
        projects.set(projectId, { ...record, viewportJson: String(args?.viewportJson ?? record.viewportJson) });
        writeWebProjects(projects);
      }
      return undefined as T;
    }
    case 'rename_project_record': {
      const projectId = String(args?.projectId);
      const record = projects.get(projectId);
      if (record) {
        projects.set(projectId, {
          ...record,
          name: String(args?.name ?? record.name),
          updatedAt: Number(args?.updatedAt ?? record.updatedAt),
        });
        writeWebProjects(projects);
      }
      return undefined as T;
    }
    case 'delete_project_record':
      projects.delete(String(args?.projectId));
      writeWebProjects(projects);
      return undefined as T;
    case 'create_project_dirs':
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
