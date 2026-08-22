# Lumina Canvas MCP

Lumina exposes the currently open Web canvas to Codex through the optional
`lumina-canvas` plugin. The plugin starts the installed Lumina runtime; the
connected Chrome profile remains the only owner of project data, canvas state,
long-lived assets, and provider credentials.

## Topology

```text
Codex
  | stdio MCP
installed LuminaRuntime --canvas-mcp
  | bridge endpoint bound to the registered Origin
connected Chrome at the installed Lumina Origin
  | browser-owned IndexedDB and runtime state
project, history, and assets
```

The runtime starts or reuses the registered `http://127.0.0.1:<port>` Origin.
`canvas_open` returns a short-lived bridge URL at that Origin. It accepts bridge
traffic only from the registered Origin and its session. Neither the launcher
nor the bridge reads IndexedDB, local files, long-lived media, or AI credentials.

## Plugin Configuration

`plugins/lumina-canvas/.codex-plugin/plugin.json` declares the plugin and
`plugins/lumina-canvas/.mcp.json` starts its bundled launcher with Codex's local
Node runner. The launcher finds the installed Windows or macOS runtime, checks
the plugin/runtime compatibility line, and executes:

```bash
LuminaRuntime --canvas-mcp
```

The normal path never downloads an unpinned companion and never creates another
browser project library. When `canvas_open` is awaiting a browser, Codex opens
or focuses the returned URL in the user's connected Chrome. If Chrome is not
connected, the Skill requests that connection and stops. The bundled skills then
guide Codex through state reads, bounded changes, image imports, explicit node
runs, status polling, and preview reads.

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
npm run test:local-runtime
```

Use `canvas_open` first and verify the returned registered Origin before
invoking any canvas capability. Runtime, companion, and browser bridge tests
cover origin checks, compatibility, token handling, disconnect behavior, and
restricted operations. `npm run canvas:codex` remains an explicit development
utility and is not a normal-plugin fallback.
