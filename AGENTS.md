# AGENTS.md

## 1. Project Goal And Stack

- Product: a node canvas for media upload, AI image and video creation/editing,
  prompt polish, and storyboard workflows.
- Web app: React, TypeScript, Zustand, `@xyflow/react`, and TailwindCSS.
- Current durable data: the registered canonical browser Origin's IndexedDB
  adapters store project records, history, asset Blobs, and settings. ADR-0006
  assigns only projects, history, and assets to the runtime file library at
  #45; the mixed browser settings record remains live until #46 moves
  non-secret preferences and provider credentials/tokens to their separate
  owners. Do not describe either target as a current adapter.
- Generation service: the Node.js GenerationGateway provides constrained
  same-origin provider and temporary-media routes.
- Optional integration: the Codex plugin and `@lumina-web/canvas-agent` expose
  a session-local bridge at the registered Origin. `canvas_open` opens or
  focuses its returned URL in the user's connected Chrome; if Chrome is not
  connected, request it and stop rather than creating another browser library.
- Core principles: decoupling, extensibility, regression coverage, automatic
  browser persistence, and responsive interaction.

## 2. Codebase Reading Order

Read the following sequence when understanding a change:

1. Entry and state:
   `src/App.tsx`, `src/stores/projectStore.ts`, `src/stores/canvasStore.ts`.
2. Canvas flow:
   `src/features/canvas/Canvas.tsx`, `domain/canvasNodes.ts`,
   `domain/nodeRegistry.ts`, and `NodeSelectionMenu.tsx`.
3. Nodes and overlays:
   `src/features/canvas/nodes/`, `ui/SelectedNodeOverlay.tsx`,
   `ui/NodeActionToolbar.tsx`, `ui/NodeToolDialog.tsx`,
   `ui/nodeControlStyles.ts`, and `ui/nodeToolbarConfig.ts`.
4. Tools and browser media:
   `src/features/canvas/tools/`,
   `src/features/media/infrastructure/browserImageToolProcessor.ts`, and
   `src/runtime/mediaRuntime.ts`.
5. Models and providers:
   `src/features/canvas/models/`, `infrastructure/webImageApi.ts`,
   `infrastructure/webTextApi.ts`, `infrastructure/webVideoApi.ts`, and
   `infrastructure/webGenerationGateway.ts`.
6. Current browser migration adapters, runtime integration, and persistence:
   `src/runtime/webDatabase.ts`, `src/features/project/infrastructure/webProjectRepository.ts`,
   `src/features/assets/infrastructure/indexedDbAssetRepository.ts`,
   `src/features/settings/infrastructure/indexedDbSettingsRepository.ts`,
   `gateway/server.mjs`, and `canvas-agent/src/web/`.

## 3. Development Workflow

1. Define the change boundary: UI, node behavior, tool behavior, provider
   mapping, browser persistence, gateway behavior, or performance.
2. Follow the data flow: UI input -> store -> application service -> browser or
   gateway adapter -> persistence. Do not mutate state across layers.
3. Work in small slices. Run the smallest relevant check after each slice.
4. Run a complete Web build before finishing a functional or dependency change.
5. When the user explicitly requests a release, the release command creates the
   version commit, annotated tag, and remote update. Generated notes contain
   only non-empty `## 新增`, `## 优化`, `## 修复`, or equivalent sections.

## 4. Architecture And Boundaries

### 4.1 Dependencies

- Prefer interfaces and data types over concrete cross-module dependencies.
- Use an event bus or explicit service/port for cross-module communication.
- UI components must not call browser storage or Gateway infrastructure
  directly; compose these boundaries through application services.

### 4.2 Responsibilities

- One file should express one business concept. Split a file if that cannot be
  explained in three sentences.
- Tool UI, tool data, and tool execution remain separate.
- Stores coordinate state; business work belongs in application services.

### 4.3 Size Guidelines

- Comfortable range: classes at most 400 lines and scripts at most 300 lines.
- Reassess a file at 800 lines; split non-data files at 1000 lines.

### 4.4 Async Generation

- Generation follows `submit -> poll -> get result` and persists only a safe,
  credential-free task handle when the provider supports resumption.
- A refresh may poll the original stable task only. It must not silently submit
  a new billable request.
- Use `webGenerationGateway.ts`, `webImageApi.ts`, and `webVideoApi.ts` as the
  integration references. Gateway task state is temporary and never owns a
  project, canvas, or long-lived asset.

### 4.5 Node Registry

- Node type, defaults, menu availability, and connection capability belong in
  `domain/nodeRegistry.ts`, not duplicated in `Canvas.tsx` or the store.
- Derive connect-menu candidates from the registry. Internal derived nodes keep
  their connect-menu entries disabled unless the workflow creates them.

### 4.6 Prompt Polish

- Image and upload nodes use the image template; video nodes use the video
  template.
- All polish uses the selected text API configuration. Media nodes trigger
  polish but do not own provider credentials or runtime configuration.
- `textPolishService.ts` owns templates and delegates requests to the browser
  text provider path.

## 5. UI And Interaction

- Reuse primitives from `src/components/ui/primitives.tsx` and design tokens
  from `index.css`.
- Keep controls, toolbars, and dialogs aligned with nodes and preserve existing
  transition behavior.
- Use `nodeControlStyles.ts` for node-bottom controls and
  `nodeToolbarConfig.ts` for toolbar placement.
- Keep keyboard shortcuts inactive in `input`, `textarea`, and content-editable
  contexts.
- Verify light and dark themes and avoid high-saturation blue as the dominant
  focus color.

## 6. Commands And Verification

### 6.1 Development

```bash
# Web app
npm run dev

# Same-origin generation service
npm run gateway:dev

# Local Codex companion with the production Web bundle
npm run canvas:codex

# Release when explicitly requested
npm run release -- patch --notes-file docs/releases/v0.2.1.md
```

### 6.2 Fast Checks

```bash
npx tsc --noEmit
npm run test:web-only
```

### 6.3 Tests

```bash
npx vitest run
npx vitest run gateway
npm run canvas-agent:test
node --test plugins/lumina-canvas/plugin.node-test.mjs
```

### 6.4 Finish

```bash
npm run build
npm run preview
```

For routine work, start with type checking and focused tests. Run the complete
test suite and build when dependencies, entry points, persistence, Gateway, or
published artifacts change.

## 7. Performance

- Do not persist or recalculate expensive work on every drag frame; save after
  the drag ends.
- Keep large image rendering on `previewImageUrl`; use the full source only for
  processing.
- Batch project snapshot writes with idle scheduling and debounce viewport
  writes separately, including normalization and epsilon comparisons.
- Prefer `useMemo` and `useCallback` where they prevent meaningful render work,
  not as blanket decoration.

## 8. Extending Models, Media, And Nodes

### 8.1 Image Models

- Put one model definition in `src/features/canvas/models/image/<provider>/`.
- Declare its display name, provider ID, supported resolution and aspect ratio,
  defaults, and request mapping.

### 8.2 Video Nodes

- `videoSingle` and `videoFrame` create video work; `exportVideo` is the
  workflow-created result node.
- Collect first and last frame inputs by their explicit handles.
- `VideoGenNode` submits and `Canvas.tsx` polls the result node task handle.
- Resolve provider and model routing in the Web provider adapters, never in UI
  components. When a provider needs public input media, prepare a temporary
  Gateway copy from a persisted project asset and release it when the task reaches a
  terminal state.

### 8.3 Tools

1. Declare the capability in `tools/types.ts`.
2. Register it in `tools/builtInTools.ts`.
3. Add the matching editor under `ui/tool-editors/`.
4. Route image work through `runtimeMediaProcessor` and the browser image tool
   processor.
5. Create a derived asset and node rather than overwriting the input.

### 8.4 Nodes

1. Define the node data and any guard in `domain/canvasNodes.ts`.
2. Register default data, capability, and connectivity in `nodeRegistry.ts`.
3. Register the renderer in `nodes/index.ts`.
4. Explicitly choose manual connect-menu behavior; workflow-only derived nodes
   keep it disabled.
5. Verify deletion, ungrouping, edge cleanup, and history when group behavior
   changes.

## 9. Durable Storage And Runtime Ownership

- `projectStore` saves through the configured `RuntimeProjectRepository` and restores the last viewport.
- The installed local Runtime is the only durable owner of project complete snapshots, canvas history, asset metadata, and asset bytes. Chrome and Codex are clients and never receive filesystem paths, roots, directory listings, or arbitrary file access.
- The browser no longer reads, writes, migrates, or interprets legacy IndexedDB project/history/asset records. Those records are intentionally ignored and are not erased. IndexedDB remains scoped to settings until that separate migration is designed and accepted.
- A single Runtime-global editor lease permits either Chrome or Codex to mutate data, never both. Codex ownership requires explicit Chrome handoff and is revoked on disconnect, expiry, failed action, release, or Runtime shutdown. Generation/run approval remains independent.
- Runtime API credentials, lease tokens, delegation tokens, provider credentials, signed URLs, object URLs, and Gateway temporary state are transient and must never be persisted in project data.
- Object URLs are short-lived display leases and must never become persisted facts. Generic media downloads and non-project ZIP output remain browser-owned output flows; project archive import/export is not supported.
- Runtime errors exposed to clients are logical, path-free errors. Runtime asset admission and project publication enforce size, integrity, reference, and managed-path safety.

## 10. Pre-Commit Checklist

- Exercise one main path and one error path for the changed behavior.
- Check drag, zoom, and input responsiveness for a visual change.
- Run `npx tsc --noEmit` and focused tests; run the full suite and build for a
  broad change.
- Update durable architecture or deployment documentation when its behavior
  changes.
- Confirm staged paths are in scope before committing.

## 11. i18n

- Entry: `src/i18n/index.ts`.
- Locales: `src/i18n/locales/zh.json` and `src/i18n/locales/en.json`.
- Use `useTranslation()` and stable modular keys. Add each new key to both
  locales and use interpolation for dynamic values.
- Verify both languages remain readable and no raw translation key is exposed.

## 12. Agent Guidance

### Issue Tracker

Issues and specifications live in `mailwmj/Lumina-web`. Use `gh` with the
explicit `--repo mailwmj/Lumina-web` flag. See `docs/agents/issue-tracker.md`.

### Triage Labels

Use `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and
`wontfix`. See `docs/agents/triage-labels.md`.

### Domain Docs

This is a single-context repository. Read `CONTEXT.md` and relevant
`docs/adr/` files before changing an area. See `docs/agents/domain.md`.

When user instructions conflict with this file, follow the user. When they
conflict with runtime safety, follow safety.
