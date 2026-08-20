# Canvas Interaction And Visual Refresh Implementation Plan

**Outcome:** In pan mode, a user can select, edit, connect, and drag nodes while dragging the empty pane still pans the viewport. The canvas diamond grid, image metadata, floating titles, and connection handles match the supplied references, measured by the acceptance checks below.

**Scope:** Frontend canvas interaction and presentation only. Do not change AI generation, Tauri commands, SQLite persistence, project snapshot formats, edge routing, or node registry connectivity rules.

**Verified baseline (2026-08-09):**

- `Canvas.tsx` keeps `elementsSelectable` enabled in both modes, but restricts `nodesDraggable` and `nodesConnectable` to select mode.
- `CanvasNodeImage.tsx` calculates image dimensions only during hover and renders the tooltip in a document-level portal.
- `UploadNode.tsx` persists the original upload name in `sourceFileName` and may also copy it to `displayName`.
- Image and upload nodes render an editable floating `NodeHeader` above the node.
- Node handles are globally 8 px and node renderers repeat 8 px Tailwind overrides.
- Direct inspection of the reference editor found a `#030303` canvas with a CSS-gradient diamond grid. The latest side-by-side comparison establishes a 72 px local base interval for the requested visual density.
- Git history shows commit `233ea66` deliberately enabled selection in both tools. Preserve that behavior and complete it rather than reverting the change.

## Decisions And Trade-offs

- Pan mode distinguishes the drag origin: dragging an empty pane pans; dragging a node moves that node. Selection-box dragging remains select-mode-only.
- Node titles stop rendering for every node type, not only image nodes. Keep `displayName` and legacy labels in data for compatibility and internal identification.
- Hide the settings UI for "use uploaded filename as node title" because the visible title is removed. Keep the persisted Store field and setter so old settings and upload flows remain readable.
- Selected image metadata applies to top-level uploaded image nodes and generated/result image nodes. Do not add metadata overlays to small reference thumbnails inside editors or storyboard cells.
- Uploaded images use `sourceFileName`. Generated images derive a decoded basename from the raw output URL/path, ignoring query strings and fragments. When no real basename exists (for example a `data:` URL), show the existing node display name; do not invent a file extension.
- Image metadata is rendered inside the React Flow node coordinate system, positioned below the image node. Do not use a document portal, continuous `requestAnimationFrame`, pointer-move handler, or repeated `getBoundingClientRect` calls.
- Render the grid as one CSS-gradient layer tied only to the React Flow viewport. Do not generate point or line elements in React.

## Performance Guardrails

- Do not add work to `onNodeDrag` beyond the existing position updates. No image parsing, DOM measurement, Store persistence, or async work may run per drag frame.
- Preserve drag-end persistence and `onlyRenderVisibleElements`.
- Do not load an original image merely because its node is mounted. Resolve original dimensions only while that top-level image node is selected.
- A selected node may start at most one dimension request for the same source per mounted selection state. Ignore stale completions after deselection, source change, or unmount.
- Metadata components must be memoizable and receive primitive props where practical. Do not subscribe every image node to the full canvas Store.
- Changing selection, panning, zooming, or dragging must not install an animation loop for metadata positioning.
- Keep the background and handle changes CSS/SVG-only. Add no new runtime dependency.

## Implementation Tasks

### Task 1: Complete pan-mode node interaction

**Primary file:** `src/features/canvas/Canvas.tsx`

- Keep `panOnDrag` enabled only in pan mode.
- Keep `selectionOnDrag` enabled only in select mode.
- Enable node dragging and node connections in both modes.
- Keep `elementsSelectable` enabled.
- Confirm interactive controls carrying `nodrag`/`nopan` semantics remain editable in pan mode.

### Task 2: Match the reference canvas

**Primary files:** `src/features/canvas/Canvas.tsx`, `src/index.css`, and the existing canvas-grid setting source if needed.

- Canvas color: `#030303` in dark mode.
- Grid: intersecting 45 degree and -45 degree lines with a point at each intersection.
- Point radius: 1.05 px; diagonal half-width: 0.45 px; layer opacity: 0.92.
- Grid interval: 72 px on both axes at zoom 1.
- Keep visual grid and snap grid aligned. If legacy `snapGridSize: 20` persistence prevents this, normalize only the legacy default rather than overwriting a future explicit user choice.

### Task 3: Remove floating node names

**Primary files:** node renderers under `src/features/canvas/nodes/`, `src/features/canvas/ui/NodeHeader.tsx`, and `src/components/SettingsDialog.tsx`.

- Remove floating `NodeHeader` rendering and now-unused title-editing code from all node renderers.
- Do not solve this with `display: none`; the hidden inputs and measurement observers must not remain mounted.
- Delete `NodeHeader.tsx` only if no call sites remain.
- Hide the obsolete upload-filename-title setting row, but retain its persisted Store shape for compatibility.
- Do not rewrite existing project node data.

### Task 4: Add selected image metadata

**Primary files:** `src/features/canvas/nodes/UploadNode.tsx`, `src/features/canvas/nodes/ImageNode.tsx`, and focused shared UI/application helpers.

- Add a small shared component for selected top-level image metadata.
- Render nothing when the node is not selected or no image exists.
- Display filename first, then `width × height`, centered beneath the node in the current resolution-label area.
- Truncate long filenames without hiding or shifting the dimensions.
- Prefer original dimensions. Resolve them only on selection and cancel/ignore stale work.
- Keep the existing image viewer behavior.
- Remove hover-only resolution behavior from these two top-level image nodes without changing thumbnail behavior elsewhere unless the shared API requires an explicit opt-out.
- Add unit tests for basename resolution: Unix path, Windows path, encoded HTTP URL, signed URL, trailing slash, `blob:`, and `data:` fallback.

### Task 5: Enlarge and reposition connection handles

**Primary files:** `src/index.css` and/or one shared canvas handle style module, plus node renderers only where repeated overrides must be removed.

- Visible handle box: 20 x 20 px at zoom 1.
- Border: 3 px solid white.
- Fill: the canvas edge primary color (purple in the current theme).
- Position: the handle center lies on the corresponding node border; left/right and special multi-input vertical positions remain semantically correct.
- Apply one shared style to all React Flow connection handles. Do not leave competing per-node 8 px overrides.
- Preserve pointer hit testing, `source`/`target` classes, handle IDs, multi-connect logic, and connection start/end behavior.

## Acceptance Standard

### Interaction

- In pan mode, clicking each representative node selects it and shows its action toolbar.
- In pan mode, dragging a node changes its canvas position; dragging empty canvas changes the viewport instead.
- In pan mode, an editable text/prompt control accepts focus and input without moving the node or viewport.
- A source handle can start and complete a valid connection in pan mode.
- Select mode still supports node dragging and partial selection-box behavior.

### Visual

- Dark canvas computed background is `rgb(3, 3, 3)`.
- Diamond grid repeats every 72 px horizontally and vertically at zoom 1, with 1.05 px intersection points and 0.45 px diagonal half-width.
- The grid remains neutral and does not use the accent color.
- The toolbar copy is `显示/隐藏网格` / `Show/Hide Grid`; toggling it mounts or removes the grid layer.
- No floating node name appears above upload, image generation, image result, group, storyboard, video, audio, or text annotation nodes.
- Deselecting an image removes the filename and resolution metadata.
- Selecting an uploaded image shows its decoded original filename before its original dimensions.
- Selecting a generated image shows the derived output basename before its original dimensions.
- A long filename truncates while dimensions remain fully visible.
- Handles compute to 20 x 20 px with a 3 px white border, and their centers align with the node edge within 1 px at zoom 1.
- A large landscape image node still has clearly visible left/right handles and no overlap between metadata, resize control, or action toolbar.

### Performance And Regression

- Dragging a node does not trigger image-dimension requests, metadata DOM measurements, or project persistence until drag stop.
- Merely opening a project with unselected image nodes triggers no new original-image dimension requests.
- Repeated pointer movement over an image triggers no metadata work.
- Selection/deselection leaves no timer, animation frame, observer, or pending state update after unmount.
- Existing preview/original-image switching by zoom remains intact.
- Existing edge handle IDs and multi-selection connector behavior remain intact.
- Light theme remains readable even though the supplied visual target is dark theme.

## Verification Commands

```bash
npx tsc --noEmit
npx vitest run
npm run build
```

Then run the Vite app and verify the interaction and visual criteria at desktop viewports of 1440 x 900 and 1920 x 1080. Capture screenshots with one unselected image, one selected image with a long filename, one selected generated result, and one enlarged landscape result.

## Exclusions

- No Rust or SQLite changes.
- No node registry connectivity changes.
- No provider/model changes.
- No redesign of toolbars, minimap, edges, image viewer, or node resize behavior beyond avoiding overlap with the requested metadata and handles.
- No commit, tag, release, or push unless separately requested.

## Follow-up Acceptance (2026-08-09)

- Regular node handles use the edge primary color for their inner fill and retain the shared 20 px size and 3 px white border.
- Regular node handles are visually hidden and non-interactive until their node is hovered; the active source/target remains visible while a connection is in progress.
- Handle visibility is CSS-only and adds no component state, Store subscription, pointer-move handler, or layout measurement.
- The multi-selection connector remains visible without hover.
- The multi-selection connector uses the same 20 px primary-color fill, white border, and shadow as regular handles, with a transparent 32 px hit target and no additional visible outer button surface.

## Execution Record (2026-08-09)

- Status: complete.
- `git diff --check`: passed.
- `npx tsc --noEmit`: passed.
- `npx vitest run`: 14 files and 68 tests passed.
- `npm run build`: passed; only the pre-existing Browserslist age and bundle-size warnings remain.
- Chromium at 1920 x 1080: regular handles were non-interactive at `opacity: 0` away from a node and became interactive at `opacity: 1` on node hover; computed fill was `rgb(139, 92, 246)`, size was 20 x 20 px, and border was 3 px white.
- Chromium at 1920 x 1080: dragging a hover-revealed source handle to a target increased the rendered edge count from 1 to 2.
- Chromium at 1920 x 1080: two selected source-capable nodes hid their individual source handles; the always-visible multi-selection connector computed to 20 x 20 px inside a transparent 32 x 32 px button.
- Chromium at 1920 x 1080: dragging the multi-selection connector to a target increased the rendered edge count from 2 to 3 without duplicating the existing edge.
- Chromium screenshots at 1440 x 900 and 1920 x 1080 showed no page overflow or new handle-related overlap.
- Performance: hover visibility is CSS-only. No render state, Store subscription, pointer-move handler, layout observer, or drag-frame work was added for the handle change.

## Grid Reference Correction (2026-08-09)

- Status: complete.
- The visual background is one CSS-gradient layer, not React-rendered dots or lines.
- The visible base interval is 72 px, matching the latest side-by-side comparison; stored legacy intervals of 20 or 36 migrate to 72.
- Chromium computed the local canvas background as `rgb(3, 3, 3)` and the grid as three 72 px gradient layers using the reference point, line, and opacity values.
- Chromium verified hide/show unmounting and restoration, zoom-scaled spacing, and pan-adjusted background position.
- `npx tsc --noEmit`, focused grid tests, and `git diff --check` passed. No package build was run for this correction.
