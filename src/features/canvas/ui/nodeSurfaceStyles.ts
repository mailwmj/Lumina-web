export const NODE_SURFACE_SELECTED_CLASS =
  'border-accent shadow-[var(--node-selected-shadow)]';

export const NODE_SURFACE_IDLE_CLASS =
  'border-[var(--ui-border-strong)] hover:border-accent/35';

export function resolveNodeSurfaceStateClass(selected?: boolean): string {
  return selected ? NODE_SURFACE_SELECTED_CLASS : NODE_SURFACE_IDLE_CLASS;
}
