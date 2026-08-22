# Lumina Canvas Agent

`@lumina-web/canvas-agent` contains the bridge modules used by the installed
Lumina runtime. The normal Lumina Canvas plugin invokes the installed runtime
instead of this development command.

For an explicitly isolated development session, the supported command is:

```bash
npx -y @lumina-web/canvas-agent@latest web-mcp
```

This development companion creates its own `127.0.0.1` origin and accepts bridge
traffic only from that exact origin and session. The browser remains the owner
of project data, assets, and credentials. It is not a fallback for a missing
installed runtime or disconnected Chrome.

## Development

From the repository root:

```bash
npm run build
npm run canvas-agent:build
npm run canvas-agent:test
```

Run the production companion against the generated static Web bundle:

```bash
npm run canvas:codex
```

Use the `lumina-canvas` plugin in `plugins/lumina-canvas` to register the MCP server with Codex.

## Tool Boundary

The companion exposes `canvas_open` plus the restricted canvas read, bounded-change, image-import, node-run, status, and preview tools defined by the browser bridge. It does not read IndexedDB, project files, local paths, long-lived media, or AI credentials. Browser writes and generation remain subject to the browser owner’s explicit authorization.
