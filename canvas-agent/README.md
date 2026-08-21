# Lumina Canvas Agent

`@lumina-web/canvas-agent` is the Web companion used by the Lumina Canvas Codex plugin. It starts a stdio MCP server and a session-local loopback host for a built Lumina Web canvas.

The only supported command is:

```bash
npx -y @lumina-web/canvas-agent@latest web-mcp
```

The companion creates its own `127.0.0.1` origin, returns it through `canvas_open`, and accepts browser bridge traffic only from that exact origin and session. The browser remains the owner of project data, assets, and credentials.

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
