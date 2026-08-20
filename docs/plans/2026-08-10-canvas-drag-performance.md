# Canvas Drag Performance Implementation Plan

**Goal:** Keep node dragging responsive by preventing position-only updates from re-rendering graph-input consumers and by keeping ReactFlow callback/config references stable.

**Architecture:** Add a memoized application-layer projection of canvas nodes containing only workflow fields (`id`, `type`, and `data`). Node components and selection toolbars consume that projection, while actions that need layout read the current store state at execution time. ReactFlow remains controlled, so existing drag, alignment, history, and persistence behavior stays unchanged.

**Tech Stack:** React 18, TypeScript, Zustand 5, @xyflow/react 12, Vitest, Vite.

## Task 1: Add stable workflow selectors

**Files:**
- Create: `src/features/canvas/application/canvasNodeSelectors.ts`
- Create: `src/features/canvas/application/canvasNodeSelectors.test.ts`
- Modify: `src/features/canvas/domain/canvasNodes.ts`

1. Define an explicit workflow-node shape with `id`, `type`, and `data` only.
2. Implement a memoized selector that reuses its array for position, selection, and dimension-only node updates.
3. Implement a stable selected-node ID selector for the overlay.
4. Test reference preservation for layout-only updates and invalidation for data, type, add, remove, and selection changes.
5. Run `npx vitest run src/features/canvas/application/canvasNodeSelectors.test.ts`.

## Task 2: Move graph-input consumers to semantic nodes

**Files:**
- Modify: `src/features/canvas/application/textGenerationInputs.ts`
- Modify: `src/features/canvas/application/graphImageResolver.ts`
- Modify: `src/features/canvas/application/ports.ts`
- Modify: `src/features/canvas/nodes/TextGenerationNode.tsx`
- Modify: `src/features/canvas/nodes/ImageEditNode.tsx`
- Modify: `src/features/canvas/nodes/VideoGenNode.tsx`
- Modify: `src/features/canvas/nodes/SD2VideoGenNode.tsx`
- Modify: `src/features/canvas/nodes/StoryboardNode.tsx`
- Modify: `src/features/canvas/nodes/StoryboardGenNode.tsx`

1. Update graph-input APIs to accept the explicit workflow projection.
2. Replace full `nodes` subscriptions in each graph-input consumer with the stable workflow selector.
3. Read current full nodes from `useCanvasStore.getState()` inside actions that require current layout.
4. Run the focused selector and existing graph-input tests.

## Task 3: Narrow the selection overlay subscription

**Files:**
- Modify: `src/features/canvas/ui/SelectedNodeOverlay.tsx`
- Modify: `src/features/canvas/ui/NodeActionToolbar.tsx`
- Modify: `src/features/canvas/ui/MultiSelectionActionToolbar.tsx`
- Modify: `src/features/canvas/application/imageBatchDownload.ts`
- Modify: `src/features/canvas/tools/types.ts`
- Modify: `src/features/canvas/tools/registry.ts`
- Modify: `src/features/canvas/tools/builtInTools.ts`

1. Subscribe separately to stable workflow data, selected IDs, and the primary selected ID.
2. Pass semantic node data to toolbar helpers so dragging cannot wake the overlay.
3. Preserve all single- and multi-selection toolbar behavior.

## Task 4: Stabilize ReactFlow inputs

**Files:**
- Modify: `src/features/canvas/Canvas.tsx`

1. Read current nodes inside `handleNodesChange` and remove `nodes` from its dependency list.
2. Hoist static ReactFlow option objects and key arrays to module scope.
3. Memoize the dynamic snap-grid tuple.
4. Keep the existing position alignment, history snapshot, and deferred persistence flow intact.

## Task 5: Verify behavior and performance

**Files:**
- Preserve existing diagnostic cleanup deletions without rewriting history.

1. Run focused Vitest tests for selectors and graph input behavior.
2. Run `npx tsc --noEmit`.
3. Run `npm run build`.
4. Start the Vite development server and repeat the browser drag measurement on the mixed-node canvas.
5. Confirm position-only dragging no longer commits graph-input consumers or the selected-node overlay, and report the before/after measurements.
