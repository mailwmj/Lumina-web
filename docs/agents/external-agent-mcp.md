# Lumina Canvas MCP

Lumina exposes the currently open Web canvas to Codex through the optional
`lumina-canvas` plugin. The plugin starts the installed Lumina runtime; the
Runtime-owned managed file library holds project data, canvas history, and
long-lived assets. Browser IndexedDB remains the separate settings store. The
plugin reaches project data only through the Runtime service and never receives
filesystem paths, raw project-library access, or provider credentials.

## Topology

```text
Codex
  | stdio MCP
installed LuminaRuntime --canvas-mcp
  | bridge endpoint bound to the registered Origin
authorized canvas client
  | RuntimeProjectClient and bounded bridge requests
installed Runtime project service
  | managed logical project and asset operations
managed file library: projects, history, asset metadata, asset bytes

browser IndexedDB: separate settings record
```

The runtime starts or reuses the registered `http://127.0.0.1:<port>` Origin.
`canvas_open` returns a short-lived bridge URL at that Origin. It accepts bridge
traffic only from the registered Origin and its session. The Runtime storage
module is the only component that reads managed files. The launcher, plugin,
and bridge never expose raw paths, long-lived media, or AI credentials to MCP
callers.

## Plugin Configuration

The native Windows/macOS installers include a Lumina-owned `Lumina-Codex-Plugin`
bundle containing `.codex-plugin/plugin.json`, `.mcp.json`, the installed-runtime
launcher, and skills. This bundle is a source for Codex's supported local
plugin/marketplace import flow; the Lumina installer does not write Codex
configuration, scan for `CODEX_HOME`, or guess a Codex installation directory.
After an explicit import, Codex owns its installed copy and should use its own
official update/remove controls. The repository intentionally does not claim a
universal Codex registration command because no such contract is present here.

The plugin's `.mcp.json` starts the launcher with Codex's local Node runner. The
Codex MCP host therefore needs Node.js >=18; this is separate from the Lumina
desktop installer, which does not require Node.js. The launcher finds the
installed Windows or macOS runtime through `LUMINA_RUNTIME_PATH` or Lumina's
runtime locator, checks the plugin/runtime compatibility line, and executes:

```bash
LuminaRuntime --canvas-mcp
```

The normal path never downloads an unpinned companion. When `canvas_open` is
awaiting a canvas client, Codex opens or focuses the returned registered Origin
in the user's connected Chrome. If Chrome is not connected, the Skill requests
that connection and stops. The bundled skills then guide Codex through state
reads, bounded changes, image imports, explicit node runs, status polling, and
preview reads.

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
