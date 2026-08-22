# Lumina

Lumina is a browser-first node canvas for image and video creation. Projects,
canvas history, settings, and long-lived media stay in the browser at the
canonical Origin. The optional GenerationGateway handles narrowly scoped
provider requests and temporary media; the optional Codex plugin opens the
same Web canvas at the registered browser Origin.

## Architecture

- React, TypeScript, Zustand, `@xyflow/react`, and TailwindCSS render the Web app.
- IndexedDB stores projects, histories, settings, and browser assets. Nodes keep
  stable asset IDs; Object URLs are display leases only.
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

Run the Web app:

```bash
npm run dev
```

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
bundle, `gateway`, and the Codex plugin/companion artifacts separately; a tag
release also builds unsigned beta local installers as described in [GitHub installer
releases](./docs/deployment/github-installers.md).

### Local Production Runtime

For the local production-runtime composition, run:

```bash
npm run canvas:runtime
```

The command builds the Web app and canvas-agent, then the runtime serves only
the packaged `canvas-agent/web-dist` bundle. It does not start a development
server or serve the Web source tree.
The runtime proxies `/api/generation` to a loopback GenerationGateway and starts
the controlled bridge with the registered canonical Origin.

The runtime owns installation metadata and temporary Gateway state only. The
Chrome profile at that Origin remains the owner of IndexedDB projects, history,
assets, settings, and provider credentials; restarting the runtime does not
read, copy, or delete those browser facts.

For Windows/macOS installer preparation, signing, protocol registration, and
platform-specific release prerequisites, see [local installer delivery](./docs/deployment/local-installer.md).

## Codex Plugin

The plugin manifest lives in `plugins/lumina-canvas`. In a normal installed
product it invokes the local launcher, which validates the installed runtime
version line and runs:

```bash
LuminaRuntime --canvas-mcp
```

`canvas_open` returns the registered production Origin and the Skill navigates
or focuses it in the user's connected Chrome. A missing Chrome connection is a
prompt to connect Chrome, not a fallback browser or a second project library.

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
  runtime/                  # Browser composition and IndexedDB access
  stores/                   # UI state and persistence scheduling
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
