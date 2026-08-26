# Lumina

Lumina is a browser-first node canvas for image and video creation. The
installed local Runtime owns durable project snapshots, canvas history, and
long-lived media in its managed file library; the Web app and Codex companion
access it only through the Runtime API. Browser IndexedDB currently owns the
separate settings record. The optional GenerationGateway handles narrowly
scoped provider requests and temporary media, and the optional Codex plugin
opens the registered browser path.

## Architecture

- React, TypeScript, Zustand, `@xyflow/react`, and TailwindCSS render the Web app.
- The local Runtime stores projects, histories, asset metadata, and asset bytes
  in its managed file library. Nodes keep stable asset IDs; Object URLs are
  display leases only. The browser does not read, migrate, or dual-write legacy
  IndexedDB project records. Browser IndexedDB remains the separate settings
  store.
- The Node.js GenerationGateway serves same-origin generation and temporary-media
  routes without becoming a project datastore.
- `@lumina-web/canvas-agent` and `plugins/lumina-canvas` provide the optional
  Codex integration at the same registered browser Origin.
- The production local runtime serves the compiled canvas bundle at the registered
  canonical Origin, proxies its same-origin GenerationGateway route, and binds
  the Agent bridge to that same Origin.

## Development requirements

- Node.js 20+
- npm 10+

These are development and release-workstation requirements. A normal Windows or
macOS Lumina installation ships an already compiled local runtime and does not
require Node.js, npm, Git, a source checkout, or a terminal.

## Development

Install the root and companion dependencies:

```bash
npm ci
npm ci --prefix canvas-agent
```

Check the complete development prerequisites without starting a process:

```bash
npm run dev:check
```

The preflight reports the Node.js version, root and `canvas-agent`
dependencies, production artifacts, and the registered Runtime health state. It
prints the exact install or build command for a missing prerequisite.

Run a UI-only Vite session:

```bash
npm run dev
```

This command does not start the Runtime project API, so project loading and
editing require a separate Runtime-backed session. Use `npm run canvas:runtime`
for the complete local product composition. The terminal preflight labels this
boundary before Vite starts.

For generation development, run the gateway and Vite in separate shells. The
gateway process receives the browser Origin; Vite receives the local gateway
target for its development proxy:

```powershell
# Gateway shell
$env:LUMINA_GATEWAY_ORIGIN = "http://127.0.0.1:5173"
npm run gateway:dev

# Vite shell
$env:LUMINA_GATEWAY_ORIGIN = "http://127.0.0.1:8787"
npm run dev
```

Configure an upstream only on the gateway process. Deployment requirements,
allowlists, retention, and security boundaries are in
[GenerationGateway](./docs/agents/generation-gateway.md).

## Verification

```bash
npx tsc --noEmit
npm run test:web-only
npx vitest run
npx vitest run gateway
npm run canvas-agent:test
node --test plugins/lumina-canvas/plugin.node-test.mjs
npm run build
```

`npm run build` emits the static Web bundle in `dist` and copies it to
`canvas-agent/web-dist` for the companion package. Use `npm run preview` to
serve the production bundle locally.

## Deployment

Deploy `dist` to a static host and reverse-proxy `/api/generation` to the
GenerationGateway on the same Origin. The build workflow uploads the static
bundle, `gateway`, and a complete Codex plugin/companion diagnostic artifact
separately; native tag releases embed the Lumina-owned Codex plugin bundle in
the Windows and macOS installers as described in [GitHub installer
releases](./docs/deployment/github-installers.md).

### Local Production Runtime

For the local production-runtime composition, run:

```bash
npm run canvas:runtime
```

The command builds the Web app and canvas-agent, then the runtime serves only
the packaged `canvas-agent/web-dist` bundle. On the first start, or when source
inputs make those artifacts stale, it builds them once; later starts reuse
valid artifacts. It does not start a development server or serve the Web source
tree.
The runtime proxies `/api/generation` to a loopback GenerationGateway and starts
the controlled bridge with the registered canonical Origin.

Build and start can also be run explicitly:

```bash
npm run canvas:runtime:build
npm run canvas:runtime:start
```

`canvas:runtime`, `canvas:runtime:start`, `dev`, and `gateway:dev` are foreground
processes and their terminals must remain open. The installed plugin manages
the installed Runtime process for its own MCP session; it does not use these
development commands.

The Runtime owns installation metadata and the managed file library for
projects, histories, assets, and their recovery data. The GenerationGateway
owns only bounded temporary operational state. Browser IndexedDB remains the
separate settings store. [ADR-0006](./docs/adr/0006-runtime-file-project-library.md)
defines the Runtime-first project and asset boundary; it intentionally does not
turn settings into Runtime project data.

The managed project library is `%LOCALAPPDATA%\Lumina\library` on Windows and
`~/Library/Application Support/Lumina/library` on macOS. Development,
installed protocol, and Codex MCP entry points all start the same production
Runtime composition and therefore select the same platform root.

For Windows/macOS installer preparation, signing, protocol registration, and
platform-specific release prerequisites, see [local installer delivery](./docs/deployment/local-installer.md).

## Codex Plugin

The plugin manifest lives in `plugins/lumina-canvas` and the native installers
include the same allowlisted bundle under Lumina's application payload. Installing
Lumina does not write to or register a Codex directory. To activate it, use
Codex's supported local plugin/marketplace import flow and let Codex manage its
own copy; this repository intentionally does not guess a Codex path or invent an
installation command. The plugin MCP host currently requires Node.js >=18,
although the Lumina desktop app itself does not require Node.js.
The bundled [plugin README](./plugins/lumina-canvas/README.md) lists the import
boundary and the distinct Node, Runtime, compatibility, and Chrome diagnostics.

In a normal installed product the plugin invokes the local launcher, which validates the installed runtime version line and runs:

```bash
LuminaRuntime --canvas-mcp
```

`canvas_open` returns the registered production Origin and the Skill opens or
focuses the returned URL in the user's connected Chrome. A missing Chrome
connection is a prompt to connect it and stop, not a reason to create an
in-app or other isolated browser project library.

For an explicitly isolated companion development session, run:

```bash
npm run canvas:codex
```

The development utility is not used by the installed plugin. See
[Lumina Canvas MCP](./docs/agents/external-agent-mcp.md).

## Project Layout

```text
src/
  features/                 # Canvas, projects, assets, settings, and media
  runtime/                  # Browser Runtime client and local Runtime services
  stores/                   # UI state and persistence scheduling
runtime/fileProjectLibrary/ # Managed project, history, and asset storage
gateway/                    # Same-origin generation service
canvas-agent/               # Web companion package
plugins/lumina-canvas/      # Codex plugin manifest and skills
docs/                       # Architecture and operational guidance
```

## Extension Points

- Image models and provider metadata live under `src/features/canvas/models/`.
- Browser provider requests live in `webImageApi.ts`, `webTextApi.ts`, and
  `webVideoApi.ts`.
- Node types, defaults, and connection capabilities have one source of truth in
  `src/features/canvas/domain/nodeRegistry.ts`.
- New user-facing strings must be added to both locale files through
  `useTranslation()` keys.

See [provider and model extension](./docs/development-guides/provider-and-model-extension.md)
and [gateway media handling](./docs/development-guides/tos-media-storage.md).
