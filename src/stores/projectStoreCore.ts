import { logger } from '@/lib/logger';
import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Viewport } from '@xyflow/react';
import {
  useCanvasStore,
  type CanvasEdge,
  type CanvasHistoryState,
  type CanvasNode,
  type CanvasNodeData,
} from './canvasStore';
import { withProjectMutationOrdering } from '@/features/project/application/withProjectMutationOrdering';
import {
  deserializeProjectHistory,
  sanitizeProjectNodesForPersistence,
  serializeProjectHistory,
  stripAssetBackedDisplayUrls,
} from '@/features/project/application/projectHistoryPersistence';
import type {
  ProjectRecord,
  ProjectRepository,
  ProjectSummaryRecord,
} from '@/features/project/domain/projectRepository';
import {
  INITIAL_PROJECT_REVISION,
  nextProjectRevision,
} from '@/features/project/domain/projectRevision';

const DEFAULT_VIEWPORT: Viewport = {
  x: 0,
  y: 0,
  zoom: 1,
};

function createEmptyHistory(): CanvasHistoryState {
  return {
    past: [],
    future: [],
  };
}

const IMAGE_REF_PREFIX = '__img_ref__:';
const UPSERT_DEBOUNCE_MS = 260;
const VIEWPORT_UPSERT_DEBOUNCE_MS = 280;
const VIEWPORT_EPSILON = 0.001;
const IDLE_PERSIST_TIMEOUT_MS = 1200;
const FALLBACK_IDLE_DELAY_MS = 64;

export {
  deserializeProjectHistory,
  sanitizeProjectNodesForPersistence,
  serializeProjectHistory,
} from '@/features/project/application/projectHistoryPersistence';

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface Project extends ProjectSummary {
  revision: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
  history: CanvasHistoryState;
}

export interface ProjectSaveOptions {
  immediate?: boolean;
}

type PersistedProject = Project & {
  imagePool?: string[];
};

interface PersistedProjectNodes {
  nodes: CanvasNode[];
  imagePool?: string[];
}

function encodeImageReference(
  imageUrl: string | null | undefined,
  imagePool: string[],
  imageIndexMap: Map<string, number>
): string | null | undefined {
  if (typeof imageUrl !== 'string' || imageUrl.length === 0) {
    return imageUrl;
  }

  const existingIndex = imageIndexMap.get(imageUrl);
  if (typeof existingIndex === 'number') {
    return `${IMAGE_REF_PREFIX}${existingIndex}`;
  }

  const nextIndex = imagePool.length;
  imagePool.push(imageUrl);
  imageIndexMap.set(imageUrl, nextIndex);
  return `${IMAGE_REF_PREFIX}${nextIndex}`;
}

function decodeImageReference(
  imageUrl: string | null | undefined,
  imagePool: string[] | undefined
): string | null | undefined {
  if (typeof imageUrl !== 'string' || !imagePool || !imageUrl.startsWith(IMAGE_REF_PREFIX)) {
    return imageUrl;
  }

  const index = Number.parseInt(imageUrl.slice(IMAGE_REF_PREFIX.length), 10);
  if (!Number.isFinite(index) || index < 0) {
    return imageUrl;
  }

  return imagePool[index] ?? null;
}

function mapNodeImageReferences(
  nodes: CanvasNode[],
  mapImageUrl: (imageUrl: string | null | undefined) => string | null | undefined
): CanvasNode[] {
  return nodes.map((node) => {
    const nodeData = node.data as Record<string, unknown>;
    const nextData: Record<string, unknown> = { ...nodeData };

    if ('imageUrl' in nextData) {
      nextData.imageUrl = mapImageUrl(nextData.imageUrl as string | null | undefined) ?? null;
    }
    if ('previewImageUrl' in nextData) {
      nextData.previewImageUrl =
        mapImageUrl(nextData.previewImageUrl as string | null | undefined) ?? null;
    }
    if ('lastFrameImageUrl' in nextData) {
      nextData.lastFrameImageUrl =
        mapImageUrl(nextData.lastFrameImageUrl as string | null | undefined) ?? null;
    }

    if (Array.isArray(nextData.frames)) {
      nextData.frames = nextData.frames.map((frame) => {
        if (!frame || typeof frame !== 'object') {
          return frame;
        }

        const frameRecord = frame as Record<string, unknown>;
        if (!('imageUrl' in frameRecord)) {
          return frame;
        }

        return {
          ...frameRecord,
          imageUrl: mapImageUrl(frameRecord.imageUrl as string | null | undefined) ?? null,
          previewImageUrl:
            mapImageUrl(frameRecord.previewImageUrl as string | null | undefined) ?? null,
        };
      });
    }

    return {
      ...node,
      data: nextData as CanvasNodeData,
    };
  });
}

function mapHistoryImageReferences(
  history: CanvasHistoryState,
  mapImageUrl: (imageUrl: string | null | undefined) => string | null | undefined
): CanvasHistoryState {
  return {
    past: history.past.map((snapshot) => ({
      ...snapshot,
      nodes: mapNodeImageReferences(snapshot.nodes, mapImageUrl),
    })),
    future: history.future.map((snapshot) => ({
      ...snapshot,
      nodes: mapNodeImageReferences(snapshot.nodes, mapImageUrl),
    })),
  };
}

function encodeProject(project: Project): PersistedProject {
  const imagePool: string[] = [];
  const imageIndexMap = new Map<string, number>();
  const encode = (imageUrl: string | null | undefined) =>
    encodeImageReference(imageUrl, imagePool, imageIndexMap);

  return {
    ...project,
    nodes: mapNodeImageReferences(
      stripAssetBackedDisplayUrls(sanitizeProjectNodesForPersistence(project.nodes)),
      encode,
    ),
    history: serializeProjectHistory(project.history),
    imagePool,
  };
}

function decodeProject(project: PersistedProject): Project {
  const decode = (imageUrl: string | null | undefined) =>
    decodeImageReference(imageUrl, project.imagePool);

  return {
    ...project,
    nodes: mapNodeImageReferences(project.nodes, decode),
    history: mapHistoryImageReferences(project.history, decode),
  };
}

function safeParseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function describePersistenceError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function extractImagePoolFromHistoryJson(historyJson: string): string[] {
  const imagePoolKey = '"imagePool"';
  const keyIndex = historyJson.indexOf(imagePoolKey);
  if (keyIndex < 0) {
    return [];
  }

  const arrayStart = historyJson.indexOf('[', keyIndex + imagePoolKey.length);
  if (arrayStart < 0) {
    return [];
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let arrayEnd = -1;

  for (let index = arrayStart; index < historyJson.length; index += 1) {
    const char = historyJson[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '[') {
      depth += 1;
      continue;
    }

    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        arrayEnd = index;
        break;
      }
    }
  }

  if (arrayEnd < 0) {
    return [];
  }

  const rawArrayJson = historyJson.slice(arrayStart, arrayEnd + 1);
  const parsed = safeParseJson<unknown>(rawArrayJson, []);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((item): item is string => typeof item === 'string');
}

function toProjectSummary(record: ProjectSummaryRecord): ProjectSummary {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
  };
}

function toProjectRecord(project: Project): ProjectRecord {
  const encodedProject = encodeProject(project);
  const persistedNodes = encodedProject.nodes;
  const persistedHistory = encodedProject.history;

  return {
    id: encodedProject.id,
    name: encodedProject.name,
    createdAt: encodedProject.createdAt,
    updatedAt: encodedProject.updatedAt,
    nodeCount: encodedProject.nodeCount,
    schemaVersion: 1,
    revision: encodedProject.revision,
    nodesJson: JSON.stringify({
      nodes: persistedNodes,
      imagePool: encodedProject.imagePool ?? [],
    } satisfies PersistedProjectNodes),
    edgesJson: JSON.stringify(encodedProject.edges),
    viewportJson: JSON.stringify(encodedProject.viewport),
    historyJson: JSON.stringify(persistedHistory),
  };
}

function fromProjectRecord(record: ProjectRecord): Project {
  const parsedNodesPayload = safeParseJson<CanvasNode[] | PersistedProjectNodes>(record.nodesJson, []);
  const parsedNodes = Array.isArray(parsedNodesPayload)
    ? parsedNodesPayload
    : Array.isArray(parsedNodesPayload.nodes)
      ? parsedNodesPayload.nodes
      : [];
  const parsedEdges = safeParseJson<CanvasEdge[]>(record.edgesJson, []);
  const parsedViewport = safeParseJson<Viewport>(record.viewportJson, DEFAULT_VIEWPORT);
  const extractedImagePool = extractImagePoolFromHistoryJson(record.historyJson);
  const parsedHistory = deserializeProjectHistory(record.historyJson);

  const persistedProject: PersistedProject = {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
    revision: record.revision ?? INITIAL_PROJECT_REVISION,
    nodes: parsedNodes,
    edges: parsedEdges,
    viewport: parsedViewport ?? DEFAULT_VIEWPORT,
    history: parsedHistory,
    imagePool: Array.isArray(parsedNodesPayload)
      ? extractedImagePool
      : parsedNodesPayload.imagePool ?? extractedImagePool,
  };

  const decodedProject = decodeProject(persistedProject);
  return {
    ...decodedProject,
    nodeCount: parsedNodes.length,
    viewport: decodedProject.viewport ?? DEFAULT_VIEWPORT,
    history: decodedProject.history ?? createEmptyHistory(),
  };
}

interface PersistProjectOptions {
  immediate?: boolean;
  debounceMs?: number;
}

interface PersistViewportOptions {
  immediate?: boolean;
  debounceMs?: number;
}

function scheduleIdlePersist(task: () => void): void {
  const idleHost = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };

  if (typeof idleHost.requestIdleCallback === 'function') {
    idleHost.requestIdleCallback(task, { timeout: IDLE_PERSIST_TIMEOUT_MS });
    return;
  }

  setTimeout(task, FALLBACK_IDLE_DELAY_MS);
}

function hasViewportMeaningfulDelta(current: Viewport, next: Viewport): boolean {
  return (
    Math.abs(current.x - next.x) > VIEWPORT_EPSILON ||
    Math.abs(current.y - next.y) > VIEWPORT_EPSILON ||
    Math.abs(current.zoom - next.zoom) > VIEWPORT_EPSILON
  );
}

function normalizeViewport(viewport: Viewport): Viewport {
  return {
    x: Number(viewport.x.toFixed(2)),
    y: Number(viewport.y.toFixed(2)),
    zoom: Number(viewport.zoom.toFixed(4)),
  };
}

function nextRevisionForProject(
  currentProject: Project,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  history: CanvasHistoryState,
): string {
  const changed = currentProject.nodes !== nodes
    || currentProject.edges !== edges
    || currentProject.history !== history;
  return changed ? nextProjectRevision(currentProject.revision) : currentProject.revision;
}

function updateProjectSummary(
  summaries: ProjectSummary[],
  updated: ProjectSummary
): ProjectSummary[] {
  const next = summaries.map((summary) => (summary.id === updated.id ? updated : summary));
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next;
}

export interface ProjectState {
  projects: ProjectSummary[];
  currentProjectId: string | null;
  currentProject: Project | null;
  isCurrentProjectReadOnly: boolean;
  isCurrentProjectRecovery: boolean;
  isHydrated: boolean;
  isOpeningProject: boolean;
  hydrationError: string | null;
  persistenceError: string | null;

  hydrate: (options?: { force?: boolean }) => Promise<void>;
  createProject: (name: string) => string;
  deleteProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  openProject: (id: string) => void;
  takeOverCurrentProject: () => void;
  closeProject: () => void;
  getCurrentProject: () => Project | null;
  getCurrentProjectExportRecord: () => ProjectRecord | null;
  saveCurrentProject: (
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    viewport?: Viewport,
    history?: CanvasHistoryState,
    options?: ProjectSaveOptions,
  ) => Promise<void>;
  saveCurrentProjectViewport: (viewport: Viewport) => void;
  cancelPendingViewportPersist: () => void;
  flushPendingPersistence: () => void;
  clearPersistenceError: () => void;
}

export function createProjectStore(repository: ProjectRepository) {
  const orderedRepository = withProjectMutationOrdering(repository);
  let openProjectRequestSeq = 0;
  let unsubscribeCurrentWriteAccess: (() => void) | null = null;
  const queuedProjectUpserts = new Map<string, Project>();
  const projectUpsertTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const projectUpsertsInFlight = new Set<string>();
  const projectUpsertCompletions = new Map<string, Promise<void>>();
  const persistedProjectRevisions = new Map<string, string>();
  const queuedViewportUpserts = new Map<string, string>();
  const viewportUpsertTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const viewportUpsertsInFlight = new Set<string>();
  const deletingProjectIds = new Set<string>();
  let setStoreError: (kind: 'hydration' | 'persistence', error: unknown) => void = () => undefined;

  const reportStoreError = (
    kind: 'hydration' | 'persistence',
    context: string,
    error: unknown
  ): void => {
    logger.error(context, error);
    setStoreError(kind, error);
  };

  const clearQueuedProjectUpsert = (projectId: string): void => {
    const timer = projectUpsertTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      projectUpsertTimers.delete(projectId);
    }
    queuedProjectUpserts.delete(projectId);
  };

  const clearQueuedViewportUpsert = (projectId: string): void => {
    const timer = viewportUpsertTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      viewportUpsertTimers.delete(projectId);
    }
    queuedViewportUpserts.delete(projectId);
  };

  const flushProjectUpsert = (
    projectId: string,
    options?: { bypassIdle?: boolean }
  ): void => {
    if (deletingProjectIds.has(projectId) || projectUpsertsInFlight.has(projectId)) {
      return;
    }

    const project = queuedProjectUpserts.get(projectId);
    if (!project) {
      return;
    }

    queuedProjectUpserts.delete(projectId);
    projectUpsertsInFlight.add(projectId);
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    projectUpsertCompletions.set(projectId, completion);

    const settle = () => {
      projectUpsertsInFlight.delete(projectId);
      projectUpsertCompletions.delete(projectId);
      resolveCompletion();
      if (!deletingProjectIds.has(projectId) && queuedProjectUpserts.has(projectId)) {
        flushProjectUpsert(projectId);
      }
    };

    const executePersist = () => {
      if (deletingProjectIds.has(projectId)) {
        settle();
        return;
      }

      const record = toProjectRecord(project);
      const expectedRevision = persistedProjectRevisions.get(projectId) ?? INITIAL_PROJECT_REVISION;
      void orderedRepository
        .saveSnapshot(record, { expectedRevision })
        .then(() => {
          persistedProjectRevisions.set(projectId, record.revision ?? INITIAL_PROJECT_REVISION);
        })
        .catch((error) => {
          reportStoreError('persistence', 'Failed to persist project record', error);
        })
        .finally(settle);
    };

    if (options?.bypassIdle) {
      executePersist();
      return;
    }
    scheduleIdlePersist(executePersist);
  };

  const queueProjectUpsert = (project: Project, options?: PersistProjectOptions): void => {
    const projectId = project.id;
    if (deletingProjectIds.has(projectId)) {
      return;
    }
    queuedProjectUpserts.set(projectId, project);

    const existingTimer = projectUpsertTimers.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      projectUpsertTimers.delete(projectId);
    }

    const debounceMs = options?.immediate ? 0 : (options?.debounceMs ?? UPSERT_DEBOUNCE_MS);
    if (debounceMs <= 0) {
      flushProjectUpsert(projectId, { bypassIdle: true });
      return;
    }

    const timer = setTimeout(() => {
      projectUpsertTimers.delete(projectId);
      flushProjectUpsert(projectId);
    }, debounceMs);
    projectUpsertTimers.set(projectId, timer);
  };

  const persistProject = (project: Project, options?: PersistProjectOptions): void => {
    clearQueuedViewportUpsert(project.id);
    queueProjectUpsert(project, options);
  };

  const persistProjectImmediately = async (project: Project): Promise<void> => {
    clearQueuedProjectUpsert(project.id);
    clearQueuedViewportUpsert(project.id);
    let pendingUpsert = projectUpsertCompletions.get(project.id);
    while (pendingUpsert) {
      await pendingUpsert;
      pendingUpsert = projectUpsertCompletions.get(project.id);
    }
    const record = toProjectRecord(project);
    const expectedRevision = persistedProjectRevisions.get(project.id) ?? INITIAL_PROJECT_REVISION;
    await orderedRepository.saveSnapshot(record, { expectedRevision });
    persistedProjectRevisions.set(project.id, record.revision ?? INITIAL_PROJECT_REVISION);
  };

  const flushViewportUpsert = (projectId: string): void => {
    if (deletingProjectIds.has(projectId) || viewportUpsertsInFlight.has(projectId)) {
      return;
    }

    const viewportJson = queuedViewportUpserts.get(projectId);
    if (typeof viewportJson !== 'string') {
      return;
    }

    queuedViewportUpserts.delete(projectId);
    viewportUpsertsInFlight.add(projectId);

    void orderedRepository
      .updateViewport(projectId, viewportJson)
      .catch((error) => {
        reportStoreError('persistence', 'Failed to persist project viewport', error);
      })
      .finally(() => {
        viewportUpsertsInFlight.delete(projectId);
        if (!deletingProjectIds.has(projectId) && queuedViewportUpserts.has(projectId)) {
          flushViewportUpsert(projectId);
        }
      });
  };

  const queueViewportUpsert = (
    projectId: string,
    viewport: Viewport,
    options?: PersistViewportOptions
  ): void => {
    if (deletingProjectIds.has(projectId)) {
      return;
    }
    queuedViewportUpserts.set(projectId, JSON.stringify(viewport));

    const existingTimer = viewportUpsertTimers.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      viewportUpsertTimers.delete(projectId);
    }

    const debounceMs = options?.immediate
      ? 0
      : (options?.debounceMs ?? VIEWPORT_UPSERT_DEBOUNCE_MS);
    if (debounceMs <= 0) {
      flushViewportUpsert(projectId);
      return;
    }

    const timer = setTimeout(() => {
      viewportUpsertTimers.delete(projectId);
      flushViewportUpsert(projectId);
    }, debounceMs);
    viewportUpsertTimers.set(projectId, timer);
  };

  const persistProjectDelete = (projectId: string): void => {
    deletingProjectIds.add(projectId);
    clearQueuedProjectUpsert(projectId);
    clearQueuedViewportUpsert(projectId);
    void orderedRepository.delete(projectId).catch((error) => {
      deletingProjectIds.delete(projectId);
      reportStoreError('persistence', 'Failed to delete project record', error);
    });
  };

  const clearCurrentWriteAccessSubscription = (): void => {
    unsubscribeCurrentWriteAccess?.();
    unsubscribeCurrentWriteAccess = null;
  };

  return create<ProjectState>((set, get) => {
    setStoreError = (kind, error) => {
      const message = describePersistenceError(error);
      if (kind === 'hydration') {
        set({ hydrationError: message });
      } else {
        set({ persistenceError: message });
      }
    };

    return ({
    projects: [],
    currentProjectId: null,
    currentProject: null,
    isCurrentProjectReadOnly: false,
    isCurrentProjectRecovery: false,
    isHydrated: false,
    isOpeningProject: false,
    hydrationError: null,
    persistenceError: null,

    clearPersistenceError: () => set({ persistenceError: null }),

    hydrate: async (options) => {
      if (!options?.force && get().isHydrated && !get().hydrationError) {
        return;
      }

      set({ hydrationError: null });

      try {
        const records = await orderedRepository.listSummaries();
        const projects = records.map(toProjectSummary).sort((a, b) => b.updatedAt - a.updatedAt);
        set({
          projects,
          currentProjectId: null,
          currentProject: null,
          isCurrentProjectReadOnly: false,
          isCurrentProjectRecovery: false,
          isHydrated: true,
          hydrationError: null,
        });
      } catch (error) {
        reportStoreError('hydration', 'Failed to hydrate project summaries', error);
        set({
          projects: [],
          currentProjectId: null,
          currentProject: null,
          isCurrentProjectReadOnly: false,
          isCurrentProjectRecovery: false,
          isHydrated: false,
          hydrationError: describePersistenceError(error),
        });
      }
    },

    createProject: (name) => {
      clearCurrentWriteAccessSubscription();
      const id = uuidv4();
      const now = Date.now();
      const project: Project = {
        id,
        name,
        createdAt: now,
        updatedAt: now,
        nodeCount: 0,
        revision: INITIAL_PROJECT_REVISION,
        nodes: [],
        edges: [],
        viewport: DEFAULT_VIEWPORT,
        history: createEmptyHistory(),
      };

      set((state) => ({
        projects: [{ ...project }, ...state.projects],
        currentProjectId: id,
        currentProject: project,
        isCurrentProjectReadOnly: false,
        isCurrentProjectRecovery: false,
        isOpeningProject: false,
      }));
      if (orderedRepository.watchWriteAccess) {
        unsubscribeCurrentWriteAccess = orderedRepository.watchWriteAccess(id, (access) => {
          if (get().currentProjectId === id) {
            set({
              isCurrentProjectReadOnly: access.role !== 'writer' || get().isCurrentProjectRecovery,
            });
          }
        });
      }
      if (orderedRepository.getWriteAccess) {
        void orderedRepository.getWriteAccess(id).then((access) => {
          if (get().currentProjectId === id) {
            set({
              isCurrentProjectReadOnly: access.role !== 'writer' || get().isCurrentProjectRecovery,
            });
          }
        }).catch((error) => {
          reportStoreError('persistence', 'Failed to acquire project writer ownership', error);
        });
      }
      persistProject(project, { immediate: true });
      void orderedRepository.createProjectDirs(id, name).catch((error) => {
        reportStoreError('persistence', 'Failed to create project directories', error);
      });
      return id;
    },

    deleteProject: (id) => {
      if (get().currentProjectId === id) {
        clearCurrentWriteAccessSubscription();
      }
      set((state) => ({
        projects: state.projects.filter((project) => project.id !== id),
        currentProjectId: state.currentProjectId === id ? null : state.currentProjectId,
        currentProject: state.currentProject?.id === id ? null : state.currentProject,
        isCurrentProjectReadOnly: state.currentProjectId === id
          ? false
          : state.isCurrentProjectReadOnly,
        isCurrentProjectRecovery: state.currentProjectId === id
          ? false
          : state.isCurrentProjectRecovery,
        isOpeningProject: false,
      }));
      persistProjectDelete(id);
      persistedProjectRevisions.delete(id);
    },

    renameProject: (id, name) => {
      const now = Date.now();
      set((state) => {
        const projects = state.projects.map((summary) =>
          summary.id === id ? { ...summary, name, updatedAt: now } : summary
        );
        return {
          projects: projects.sort((a, b) => b.updatedAt - a.updatedAt),
          currentProject:
            state.currentProject?.id === id
              ? { ...state.currentProject, name, updatedAt: now }
              : state.currentProject,
        };
      });

      const nextCurrentProject = get().currentProject?.id === id ? get().currentProject : null;
      if (nextCurrentProject) {
        persistProject(nextCurrentProject, { immediate: true });
        return;
      }
      void orderedRepository.rename(id, name, now).catch((error) => {
        reportStoreError('persistence', 'Failed to rename project record', error);
      });
    },

    openProject: (id) => {
      const reqSeq = ++openProjectRequestSeq;
      clearCurrentWriteAccessSubscription();
      useCanvasStore.getState().closeImageViewer();
      set({ isOpeningProject: true });

      void (async () => {
        try {
          const record = await orderedRepository.get(id);
          if (reqSeq !== openProjectRequestSeq) {
            return;
          }
          if (!record) {
            set({ isOpeningProject: false });
            return;
          }

          const project = fromProjectRecord(record);
          const isRecovery = Boolean(record.recovery);
          persistedProjectRevisions.set(id, project.revision);
          const access = orderedRepository.getWriteAccess
            ? await orderedRepository.getWriteAccess(id)
            : { role: 'writer' as const };
          if (reqSeq !== openProjectRequestSeq) {
            return;
          }
          if (orderedRepository.watchWriteAccess) {
            unsubscribeCurrentWriteAccess = orderedRepository.watchWriteAccess(id, (nextAccess) => {
              if (get().currentProjectId === id) {
                set({
                  isCurrentProjectReadOnly: nextAccess.role !== 'writer'
                    || get().isCurrentProjectRecovery,
                });
              }
            });
          }
          set((state) => ({
            currentProjectId: id,
            currentProject: project,
            isCurrentProjectReadOnly: isRecovery || access.role !== 'writer',
            isCurrentProjectRecovery: isRecovery,
            isOpeningProject: false,
            projects: updateProjectSummary(state.projects, {
              id: project.id,
              name: project.name,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              nodeCount: project.nodeCount,
            }),
          }));
        } catch (error) {
          if (reqSeq !== openProjectRequestSeq) {
            return;
          }
          reportStoreError('persistence', 'Failed to open project', error);
          set({ isOpeningProject: false });
        }
      })();
    },

    takeOverCurrentProject: () => {
      const currentProjectId = get().currentProjectId;
      if (!currentProjectId || !orderedRepository.takeOverWriteAccess) {
        return;
      }
      void orderedRepository.takeOverWriteAccess(currentProjectId)
        .then((access) => {
          if (get().currentProjectId === currentProjectId) {
            set({
              isCurrentProjectReadOnly: access.role !== 'writer' || get().isCurrentProjectRecovery,
            });
          }
        })
        .catch((error) => {
          reportStoreError('persistence', 'Failed to take over project writer ownership', error);
        });
    },

    closeProject: () => {
      openProjectRequestSeq += 1;
      clearCurrentWriteAccessSubscription();
      useCanvasStore.getState().closeImageViewer();
      const { currentProjectId, currentProject, isCurrentProjectReadOnly } = get();
      let persistedSummary: ProjectSummary | null = null;

      if (currentProjectId && currentProject && currentProject.id === currentProjectId) {
        const canvasState = useCanvasStore.getState();
        const nextProject: Project = {
          ...currentProject,
          nodes: canvasState.nodes,
          edges: canvasState.edges,
          viewport: canvasState.currentViewport ?? currentProject.viewport ?? DEFAULT_VIEWPORT,
          history: canvasState.history ?? currentProject.history ?? createEmptyHistory(),
          nodeCount: canvasState.nodes.length,
          updatedAt: Date.now(),
          revision: nextRevisionForProject(
            currentProject,
            canvasState.nodes,
            canvasState.edges,
            canvasState.history ?? currentProject.history ?? createEmptyHistory(),
          ),
        };

        persistedSummary = {
          id: nextProject.id,
          name: nextProject.name,
          createdAt: nextProject.createdAt,
          updatedAt: nextProject.updatedAt,
          nodeCount: nextProject.nodeCount,
        };
        if (!isCurrentProjectReadOnly) {
          persistProject(nextProject, { immediate: true });
        }
      }

      set((state) => ({
        projects: persistedSummary
          ? updateProjectSummary(state.projects, persistedSummary)
          : state.projects,
        currentProjectId: null,
        currentProject: null,
        isCurrentProjectReadOnly: false,
        isCurrentProjectRecovery: false,
        isOpeningProject: false,
      }));
    },

    getCurrentProject: () => {
      const { currentProjectId, currentProject } = get();
      if (!currentProjectId || !currentProject || currentProject.id !== currentProjectId) {
        return null;
      }
      return currentProject;
    },

    getCurrentProjectExportRecord: () => {
      const { currentProjectId, currentProject } = get();
      if (!currentProjectId || !currentProject || currentProject.id !== currentProjectId) {
        return null;
      }
      const canvasState = useCanvasStore.getState();
      const history = canvasState.history ?? currentProject.history ?? createEmptyHistory();
      const snapshot: Project = {
        ...currentProject,
        nodes: canvasState.nodes,
        edges: canvasState.edges,
        viewport: canvasState.currentViewport ?? currentProject.viewport ?? DEFAULT_VIEWPORT,
        history,
        nodeCount: canvasState.nodes.length,
        revision: nextRevisionForProject(currentProject, canvasState.nodes, canvasState.edges, history),
      };
      return toProjectRecord(snapshot);
    },

    saveCurrentProject: async (nodes, edges, viewport, history, options) => {
      const { currentProjectId, currentProject } = get();
      if (!currentProjectId || !currentProject || currentProject.id !== currentProjectId) {
        return;
      }

      const nextViewport = viewport ?? currentProject.viewport ?? DEFAULT_VIEWPORT;
      const nextHistory = history ?? currentProject.history ?? createEmptyHistory();
      const nextNodeCount = nodes.length;
      const hasViewportChanged =
        currentProject.viewport.x !== nextViewport.x ||
        currentProject.viewport.y !== nextViewport.y ||
        currentProject.viewport.zoom !== nextViewport.zoom;
      const hasChanged =
        currentProject.nodes !== nodes ||
        currentProject.edges !== edges ||
        currentProject.history !== nextHistory ||
        currentProject.nodeCount !== nextNodeCount ||
        hasViewportChanged;
      if (!hasChanged) {
        return;
      }

      const nextProject: Project = {
        ...currentProject,
        nodes,
        edges,
        viewport: nextViewport,
        history: nextHistory,
        nodeCount: nextNodeCount,
        updatedAt: Date.now(),
        revision: nextRevisionForProject(currentProject, nodes, edges, nextHistory),
      };

      if (options?.immediate) {
        try {
          await persistProjectImmediately(nextProject);
        } catch (error) {
          reportStoreError('persistence', 'Failed to persist project record', error);
          throw error;
        }
        const latestState = get();
        if (
          latestState.currentProjectId !== currentProjectId
          || latestState.currentProject !== currentProject
          || latestState.isCurrentProjectReadOnly
        ) {
          return;
        }
        set((state) => ({
          currentProject: nextProject,
          projects: updateProjectSummary(state.projects, {
            id: nextProject.id,
            name: nextProject.name,
            createdAt: nextProject.createdAt,
            updatedAt: nextProject.updatedAt,
            nodeCount: nextProject.nodeCount,
          }),
        }));
        return;
      }
      set((state) => ({
        currentProject: nextProject,
        projects: updateProjectSummary(state.projects, {
          id: nextProject.id,
          name: nextProject.name,
          createdAt: nextProject.createdAt,
          updatedAt: nextProject.updatedAt,
          nodeCount: nextProject.nodeCount,
        }),
      }));
      persistProject(nextProject);
    },

    saveCurrentProjectViewport: (viewport) => {
      const { currentProjectId, currentProject } = get();
      if (!currentProjectId || !currentProject || currentProject.id !== currentProjectId) {
        return;
      }

      const nextViewport = normalizeViewport(viewport);
      if (!hasViewportMeaningfulDelta(currentProject.viewport, nextViewport)) {
        return;
      }

      set({ currentProject: { ...currentProject, viewport: nextViewport } });
      queueViewportUpsert(currentProjectId, nextViewport);
    },

    cancelPendingViewportPersist: () => {
      const currentProjectId = get().currentProjectId;
      if (currentProjectId) {
        clearQueuedViewportUpsert(currentProjectId);
      }
    },

    flushPendingPersistence: () => {
      for (const [projectId, timer] of projectUpsertTimers) {
        clearTimeout(timer);
        projectUpsertTimers.delete(projectId);
      }
      for (const [projectId, timer] of viewportUpsertTimers) {
        clearTimeout(timer);
        viewportUpsertTimers.delete(projectId);
      }

      for (const projectId of queuedProjectUpserts.keys()) {
        flushProjectUpsert(projectId, { bypassIdle: true });
      }
      for (const projectId of queuedViewportUpserts.keys()) {
        flushViewportUpsert(projectId);
      }
    },
  });
  });
}
