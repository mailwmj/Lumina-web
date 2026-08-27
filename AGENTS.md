# AGENTS.md

## 1. Project Goal And Stack

- Product: a node canvas for media upload, AI image and video creation/editing,
  prompt polish, and storyboard workflows.
- Web app: React, TypeScript, Zustand, `@xyflow/react`, and TailwindCSS.
- Current durable data: the installed local Runtime owns project snapshots,
  canvas history, asset metadata, and asset bytes through its managed file
  library. The Web app and Codex companion use its logical API and never see
  filesystem roots or paths. Browser IndexedDB currently owns only settings;
  it is not a fallback, migration source, or dual writer for project data.
- Generation service: the Node.js GenerationGateway provides constrained
  same-origin provider and temporary-media routes.
- Optional integration: the Codex plugin and `@lumina-web/canvas-agent` expose
  a session-local bridge at the registered Origin. `canvas_open` opens its
  returned URL in Codex's in-app browser. Connected Chrome may remain a manual
  external entry, but is not a Codex plugin fallback; the plugin must never
  create another browser library.
- Core principles: decoupling, extensibility, regression coverage, automatic
  persistence, and responsive interaction.

## 2. Codebase Reading Order

Read the following sequence when understanding a change:

1. Entry and state:
   `src/main.tsx`, `src/App.tsx`, `src/stores/projectStore.ts`,
   `src/stores/projectStoreCore.ts`, and `src/stores/canvasStore.ts`.
2. Canvas flow:
   `src/features/canvas/Canvas.tsx`,
   `src/features/canvas/domain/canvasNodes.ts`,
   `src/features/canvas/domain/nodeRegistry.ts`, and
   `src/features/canvas/NodeSelectionMenu.tsx`.
3. Nodes and overlays:
   `src/features/canvas/nodes/`,
   `src/features/canvas/ui/SelectedNodeOverlay.tsx`,
   `src/features/canvas/ui/NodeActionToolbar.tsx`,
   `src/features/canvas/ui/NodeToolDialog.tsx`,
   `src/features/canvas/ui/nodeControlStyles.ts`, and
   `src/features/canvas/ui/nodeToolbarConfig.ts`.
4. Tools and browser media:
   `src/features/canvas/tools/`,
   `src/features/media/infrastructure/browserImageToolProcessor.ts`, and
   `src/runtime/mediaRuntime.ts`.
5. Models and providers:
   `src/features/canvas/models/`,
   `src/features/canvas/infrastructure/webImageApi.ts`,
   `src/features/canvas/infrastructure/webTextApi.ts`,
   `src/features/canvas/infrastructure/webVideoApi.ts`, and
   `src/features/canvas/infrastructure/webGenerationGateway.ts`.
6. Runtime integration and persistence:
   `src/runtime/runtimeProjectClient.ts`,
   `src/features/project/application/createProjectRepository.ts`,
   `src/features/project/infrastructure/runtimeProjectRepository.ts`,
   `src/features/assets/infrastructure/runtimeAssetRepository.ts`,
   `src/runtime/mediaRuntime.ts`,
   `src/features/settings/infrastructure/indexedDbSettingsRepository.ts`,
   `runtime/productionRuntime.mjs`, `runtime/runtimeProjectService.mjs`,
   `runtime/fileProjectLibrary/`, `gateway/server.mjs`, and
   `canvas-agent/src/web/`.
   For local-runtime or installer changes, also read `runtime/`, `installer/`,
   and their relevant deployment documentation.

## 3. Development Workflow

1. Define the change boundary: UI, node behavior, tool behavior, provider
   mapping, browser persistence, gateway behavior, or performance.
2. Follow the data flow: UI input -> store -> application service -> Runtime
   client or Gateway adapter -> persistence. Settings remain on their separate
   browser storage boundary. Do not mutate state across layers.
3. Work in small slices. Run the smallest relevant check after each slice.
4. Run a complete Web build before finishing a functional or dependency change.
5. When the user explicitly requests a release, `npm run release` requires a
   clean, non-detached branch; it synchronizes version files, creates the version
   commit and annotated tag, then pushes the branch and tag. Generated notes may
   include `## 新增`, `## 优化`, `## 修复`, `## 其他`, and `## 完整提交` sections.

## 4. Architecture And Boundaries

### 4.1 Dependencies

- Prefer interfaces and data types over concrete cross-module dependencies.
- Use an event bus or explicit service/port for cross-module communication.
- UI components must not call the Runtime client, browser storage, or Gateway
  infrastructure directly; compose these boundaries through application
  services.

### 4.2 Responsibilities

- One file should express one business concept. Split a file if that cannot be
  explained in three sentences.
- Tool UI, tool data, and tool execution remain separate.
- Stores coordinate state; business work belongs in application services.

### 4.3 Size Guidelines

- Use the comfortable range as a target for new or substantially expanded
  files: classes at most 400 lines and scripts at most 300 lines.
- Reassess a file at 800 lines and prefer splitting non-data files at 1000
  lines when the scoped work benefits; do not introduce unrelated refactors
  solely to reduce an existing exception.

### 4.4 Async Generation

- Generation follows `submit -> poll -> get result` and persists only a safe,
  credential-free task handle when the provider supports resumption.
- A refresh may poll the original stable task only. It must not silently submit
  a new billable request.
- Use `src/features/canvas/infrastructure/webGenerationGateway.ts`,
  `src/features/canvas/infrastructure/webImageApi.ts`, and
  `src/features/canvas/infrastructure/webVideoApi.ts` as the integration
  references. Gateway task state is temporary and never owns a project, canvas,
  or long-lived asset.

### 4.5 Node Registry

- Node type, defaults, menu availability, and connection capability belong in
  `src/features/canvas/domain/nodeRegistry.ts`, not duplicated in
  `src/features/canvas/Canvas.tsx` or the store.
- Derive connect-menu candidates from the registry. Internal derived nodes keep
  their connect-menu entries disabled unless the workflow creates them.

### 4.6 Prompt Polish

- Image, storyboard, and video nodes use the selected image polish text API
  configuration; text-generation nodes use the selected text polish configuration.
  Upload nodes do not provide prompt polish.
- `src/features/canvas/infrastructure/webTextApi.ts` selects fallback templates
  and applies custom templates. Video polish prefers the selected video API's
  `polishPrompt` or `defaultPolishPrompt` when available.
- `src/features/canvas/infrastructure/textPolishService.ts` validates and
  prepares requests, then delegates to the browser text provider path; it does
  not own prompt templates or credentials.

## 5. UI And Interaction

- Reuse primitives from `src/components/ui/primitives.tsx` and design tokens
  from `src/index.css`.
- Keep controls, toolbars, and dialogs aligned with nodes and preserve existing
  transition behavior.
- Use `src/features/canvas/ui/nodeControlStyles.ts` for node-bottom controls and
  `src/features/canvas/ui/nodeToolbarConfig.ts` for toolbar placement.
- Keep keyboard shortcuts inactive in `input`, `textarea`, and content-editable
  contexts.
- Verify light and dark themes and avoid high-saturation blue as the dominant
  focus color.

## 6. Commands And Verification

### 6.1 Development

```powershell
# UI-only Vite session. The Runtime project API is not started by this command.
npm run dev

# Generation development: run the Gateway and Vite in separate shells.
# Gateway shell: use the canonical browser Origin.
$env:LUMINA_GATEWAY_ORIGIN = "http://127.0.0.1:5173"
npm run gateway:dev

# Vite shell: use the local Gateway proxy target.
$env:LUMINA_GATEWAY_ORIGIN = "http://127.0.0.1:8787"
npm run dev
```

Configure upstream providers only on the Gateway process. See
`docs/agents/generation-gateway.md` for the same-origin boundary and operational
requirements.

```bash
# Local production runtime composition
npm run canvas:runtime

# Explicitly isolated Codex companion development utility
npm run canvas:codex

# Release only when explicitly requested; an optional --notes-file must exist.
npm run release -- patch
```

Use `npm run canvas:runtime` for a complete local product session with the
Runtime project service. The Vite/Gateway pair is useful for Web and generation
endpoint development, but does not provide the Runtime project API.

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
suite and build when dependencies, entry points, persistence, Gateway, or
published artifacts change. Match boundary changes to their relevant contracts:
`npm run test:adr-0006` for storage-migration rules, `npm run test:local-runtime`
and `npm run test:production-runtime` for runtime behavior, and
`npm run test:installer` or `npm run test:github-installers` for delivery work.
For automated release-contract verification, use
`npm run verify:web-release -- --channel beta` and
`npm run verify:local-release -- --channel beta`; `complete` additionally
requires the corresponding recorded manual evidence.

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
- `VideoGenNode` submits work and creates the generated-video result node.
  `src/features/canvas/Canvas.tsx` wires in
  `src/features/canvas/hooks/useVideoGenerationPolling.ts`, which polls
  `exportVideo` jobs through their persisted task handles.
- Resolve provider and model routing in the Web provider adapters, never in UI
  components. When a provider needs public input media, prepare a temporary
  Gateway copy from a persisted project asset and release it when the task
  reaches a terminal state.

### 8.3 Tools

1. Declare the capability in `src/features/canvas/tools/types.ts`.
2. Register it in `src/features/canvas/tools/builtInTools.ts`.
3. Add the matching editor under `src/features/canvas/ui/tool-editors/`.
4. Route image work through `runtimeMediaProcessor` from
   `src/runtime/mediaRuntime.ts` and the browser image tool processor.
5. Create a derived asset and node rather than overwriting the input.

### 8.4 Nodes

1. Define the node data and any guard in
   `src/features/canvas/domain/canvasNodes.ts`.
2. Register default data, capability, and connectivity in
   `src/features/canvas/domain/nodeRegistry.ts`.
3. Register the renderer in `src/features/canvas/nodes/index.ts`.
4. Explicitly choose manual connect-menu behavior; workflow-only derived nodes
   keep it disabled.
5. Verify deletion, ungrouping, edge cleanup, and history when group behavior
   changes.

## 9. Durable Storage And Runtime Boundary

- `projectStore` saves through `createProjectRepository()`, whose Runtime
  repository delegates to `runtimeProjectClient`; it restores the last viewport
  from the Runtime-owned project snapshot.
- `runtimeProjectRepository` and `runtimeAssetRepository` are the current
  durable path for projects, history, asset metadata, and asset bytes. The
  browser must not open, migrate, fallback-read, or dual-write legacy IndexedDB
  project/history/asset records.
- `indexedDbSettingsRepository` remains the separate browser-owned settings
  path. Do not use it for project facts or assets, and do not infer a settings
  migration from the Runtime project service.
- The Runtime owns managed-root validation, atomic project publication, asset
  integrity, and recovery. Browser, plugin, and Gateway callers use logical
  identifiers and bounded API requests only; never expose storage paths or
  path-bearing errors to UI or MCP.
- Object URLs are short-lived display leases, not persisted facts. Provider
  credentials, signed URLs, Runtime sessions, editor leases, Codex delegations,
  and GenerationGateway temporary state must not enter project snapshots,
  history, asset metadata, or recovery logs.
- `docs/adr/0006-runtime-file-project-library.md` is the active storage
  decision. Its historical detailed migration and maintenance contracts are
  superseded and must not be used to reintroduce browser project ownership or
  unsupported archive/revision behavior.

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
