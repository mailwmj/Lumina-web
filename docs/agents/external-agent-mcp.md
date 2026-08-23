# Lumina Canvas MCP

Lumina exposes the currently open Web canvas to Codex through the optional
`lumina-canvas` plugin. The plugin starts the installed Lumina runtime; the
current browser IndexedDB library owns project data, canvas state, long-lived
assets, and settings. ADR-0006 assigns only project/history/asset ownership to
the future runtime-managed file library at #45; the live browser settings record
separates into preferences/credentials only at #46. It is not the current plugin path.

## Topology

```text
Codex
  | stdio MCP
installed LuminaRuntime --canvas-mcp
  | bridge endpoint bound to the registered Origin
authorized canvas client
  | current browser ProjectRepository, AssetRepository, and SettingsRepository adapters
registered-Origin IndexedDB project, history, assets, and settings

future #45: runtime adapters -> managed file project library (projects, history, assets)
future #45: browser settings adapter remains live
future #46: runtime preferences + platform credential storage; settings store frozen
```

The runtime starts or reuses the registered `http://127.0.0.1:<port>` Origin.
`canvas_open` returns a short-lived bridge URL at that Origin. It accepts bridge
traffic only from the registered Origin and its session. Today the browser
adapters own durable data; after #43-#45 only the runtime storage module may
read managed files. In either state, the launcher, plugin and bridge never
expose raw paths, long-lived media or AI credentials to MCP callers.

## Plugin Configuration

`plugins/lumina-canvas/.codex-plugin/plugin.json` declares the plugin and
`plugins/lumina-canvas/.mcp.json` starts its bundled launcher with Codex's local
Node runner. The launcher finds the installed Windows or macOS runtime, checks
the plugin/runtime compatibility line, and executes:

```bash
LuminaRuntime --canvas-mcp
```

The normal path never downloads an unpinned companion. Until #43-#45, it must
not claim that a different browser storage context shares the registered-Origin
IndexedDB library. When `canvas_open` is awaiting a canvas client, Codex opens
or focuses the returned URL in an authorized client. If none is connected, the
Skill requests that connection and stops. The bundled skills then guide Codex
through state reads, bounded changes, image imports, explicit node runs, status
polling, and preview reads.

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
