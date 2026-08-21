# Lumina Canvas MCP

Lumina exposes the currently open Web canvas to Codex through the optional
`lumina-canvas` plugin. The plugin starts the published Web companion; the
browser remains the only owner of project data, canvas state, long-lived assets,
and provider credentials.

## Topology

```text
Codex
  | stdio MCP
@lumina-web/canvas-agent web-mcp
  | session-bound loopback HTTP/SSE
session-local Lumina Web canvas
  | browser-owned IndexedDB and runtime state
project, history, and assets
```

The companion creates its own `127.0.0.1` Origin for each session and returns it
from `canvas_open`. It accepts bridge traffic only from that Origin and session.
It does not read IndexedDB, local files, long-lived media, or AI credentials.

## Plugin Configuration

`plugins/lumina-canvas/.codex-plugin/plugin.json` declares the plugin and
`plugins/lumina-canvas/.mcp.json` starts:

```bash
npx -y @lumina-web/canvas-agent@latest web-mcp
```

The bundled skills guide Codex through `canvas_open`, state reads, bounded
changes, image imports, explicit node runs, status polling, and preview reads.

## Permission Boundary

- Project access is read-only until the browser user explicitly enables the
  current project's limited write access.
- Change sets validate the current project ID, revision, node registry rules,
  and allowed fields before a single mutation is applied.
- Imports and node runs remain separately bounded and require the browser
  owner's authorization. They cannot read arbitrary files or credentials.
- A stale revision is rejected rather than partially applied or replayed.
- Deletion, credential reads, arbitrary result creation, and closed-project
  access remain unavailable.

## Local Verification

```bash
npm run build
npm run canvas-agent:build
npm run canvas-agent:test
node --test plugins/lumina-canvas/plugin.node-test.mjs
npm run canvas:codex
```

Use `canvas_open` first and verify the returned session Origin before invoking
any canvas capability. Companion and browser bridge tests cover origin checks,
token handling, protocol compatibility, disconnect behavior, and restricted
operations.
