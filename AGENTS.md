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
6. Current browser migration adapters, runtime integration, and persistence:
   `src/runtime/webDatabase.ts`,
   `src/features/project/infrastructure/webProjectRepository.ts`,
   `src/features/assets/infrastructure/indexedDbAssetRepository.ts`,
   `src/features/settings/infrastructure/indexedDbSettingsRepository.ts`,
   `gateway/server.mjs`, and `canvas-agent/src/web/`.
   For local-runtime or installer changes, also read `runtime/`, `installer/`,
   and their relevant deployment documentation.

## 3. Development Workflow

1. Define the change boundary: UI, node behavior, tool behavior, provider
   mapping, browser persistence, gateway behavior, or performance.
2. Follow the data flow: UI input -> store -> application service -> browser or
   gateway adapter -> persistence. Do not mutate state across layers.
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
- UI components must not call browser storage or Gateway infrastructure
  directly; compose these boundaries through application services.

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
# Web app without generation requests
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

## 9. Durable Storage And Browser Transition

- `projectStore` saves through the configured ProjectRepository and restores the
  last viewport.
- `webProjectRepository`, `indexedDbAssetRepository` and
  `indexedDbSettingsRepository` are the current sole browser storage path for
  durable Lumina product records. Until #45, preserve their current behavior
  and do not claim a cutover has occurred. #45 freezes only the IndexedDB
  project, history, and asset stores; its compatible browser bundle still
  writes the settings store.
- ADR-0006 specifies the accepted target file library, per-store ownership
  fence, and no-dual-writer migration. #46 separately migrates non-secret
  preferences and provider credentials/tokens, then freezes the settings
  store. Those future adapters preserve the repository contracts without
  exposing paths to UI.
- Object URLs are short-lived display leases and must never become persisted facts.
  Current `.lumina` exports remove known sensitive-key fields and temporary
  Gateway-like URLs, and diagnostics exclude provider credentials. That is not
  proof that ordinary exports remove arbitrary credential-bearing URL userinfo,
  fragments, or query values; #46 owns the fail-closed
  `lumina-settings-credential-free-v1` ordinary-export sanitizer.
- The target separates non-secret preferences, provider credentials, Gateway
  state and logs as defined by ADR-0006. Gateway files are temporary operational
  state, never project facts.

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
