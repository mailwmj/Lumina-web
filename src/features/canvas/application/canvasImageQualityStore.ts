import { create } from 'zustand';

export const MAX_RETAINED_ORIGINAL_IMAGE_NODES = 3;

interface CanvasImageQualityState {
  focusedNodeId: string | null;
  isInteractionActive: boolean;
  isOriginalImageMode: boolean;
  retainedOriginalNodeIds: string[];
  requestedOriginalNodeIds: string[];
  setFocusedNodeId: (nodeId: string | null) => void;
  setInteractionActive: (active: boolean) => void;
  setOriginalImageMode: (active: boolean) => void;
  retainOriginalNode: (nodeId: string) => void;
  retainVisibleOriginalNodes: (visibleNodeIds: readonly string[]) => void;
  setRequestedOriginalNodes: (nodeIds: readonly string[]) => void;
  clearRetainedOriginalNodes: () => void;
}

export const useCanvasImageQualityStore = create<CanvasImageQualityState>((set) => ({
  focusedNodeId: null,
  isInteractionActive: false,
  isOriginalImageMode: false,
  retainedOriginalNodeIds: [],
  requestedOriginalNodeIds: [],
  setFocusedNodeId: (nodeId) => set((state) => (
    state.focusedNodeId === nodeId ? state : { focusedNodeId: nodeId }
  )),
  setInteractionActive: (active) => set((state) => (
    state.isInteractionActive === active ? state : { isInteractionActive: active }
  )),
  setOriginalImageMode: (active) => set((state) => (
    state.isOriginalImageMode === active ? state : { isOriginalImageMode: active }
  )),
  retainOriginalNode: (nodeId) => set((state) => {
    const retainedOriginalNodeIds = [
      ...state.retainedOriginalNodeIds.filter((id) => id !== nodeId),
      nodeId,
    ].slice(-MAX_RETAINED_ORIGINAL_IMAGE_NODES);
    return { retainedOriginalNodeIds };
  }),
  retainVisibleOriginalNodes: (visibleNodeIds) => set((state) => {
    const visibleNodeIdSet = new Set(visibleNodeIds);
    const retainedOriginalNodeIds = state.retainedOriginalNodeIds.filter(
      (nodeId) => visibleNodeIdSet.has(nodeId)
    );
    return retainedOriginalNodeIds.length === state.retainedOriginalNodeIds.length
      ? state
      : { retainedOriginalNodeIds };
  }),
  setRequestedOriginalNodes: (nodeIds) => set((state) => {
    const requestedOriginalNodeIds = [...new Set(nodeIds)];
    const unchanged = requestedOriginalNodeIds.length === state.requestedOriginalNodeIds.length
      && requestedOriginalNodeIds.every((nodeId, index) => (
        state.requestedOriginalNodeIds[index] === nodeId
      ));
    return unchanged ? state : { requestedOriginalNodeIds };
  }),
  clearRetainedOriginalNodes: () => set((state) => (
    !state.isOriginalImageMode
      && state.retainedOriginalNodeIds.length === 0
      && state.requestedOriginalNodeIds.length === 0
      ? state
      : {
        isOriginalImageMode: false,
        retainedOriginalNodeIds: [],
        requestedOriginalNodeIds: [],
      }
  )),
}));
