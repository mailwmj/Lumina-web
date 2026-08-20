# External Agent MCP

Lumina exposes the active canvas to Codex and other standard MCP clients through a bundled native
companion. Tauri owns the companion configuration and lifecycle; the live WebView remains the only
canvas state and mutation authority.

## Installed application

The macOS and Windows packages include `lumina-canvas-agent`. Lumina creates an owner-local config,
starts the companion with the app, stops it on exit, and does not display its bearer token.
End users do not install the repository, Node.js, Bun, or a separate MCP server package.

To connect Codex:

1. Open **Settings > External Agent** in Lumina.
2. Enable external Agent access and save.
3. Copy and run the displayed `codex mcp add lumina -- ...` command once in a terminal.
4. Start a new Codex task so it discovers the Lumina tool inventory.

The generated command contains the absolute executable and config paths for the current Lumina
installation. Moving the `.app` later requires running the newly displayed command again. Remove the
registration with `codex mcp remove lumina`.

## Process topology

```text
Codex or another MCP client
        | stdio MCP
bundled lumina-canvas-agent (mcp mode)
        | bearer-authenticated loopback HTTP
Lumina-managed lumina-canvas-agent (serve mode)
        | fetch-SSE + JSON
Lumina WebView
        |
live Zustand / React Flow canvas
```

## Tool workflow

The lightweight image-production flow uses only existing Lumina nodes:

1. Call `canvas_get_state`, then use its `projectId` and `revision` for the next write.
2. Import all user-provided references in one `canvas_import_images` call. The result maps each
   caller-owned `clientId` to an existing `uploadNode` ID.
3. Read the new canvas revision and submit one `canvas_propose_changes` batch. Create one existing
   `imageNode` per shot, connect its references, and write its complete prompt.
4. Keep reference edges in the same order as the prompt labels: the first connected image is
   `图片 1`, the second is `图片 2`, and so on.
5. Omit `create_node.position` to place new nodes in a stable column to the right of current content.
   Reference uploads, generation nodes, and normal result nodes therefore form a readable
   left-to-right workflow.
6. Wait for the user to inspect the visible nodes and authorize generation. Then call
   `canvas_run_nodes` with only the approved `imageNode` IDs.
7. Read the returned result-node IDs from the submission result. Repeat `canvas_wait_for_nodes` for
   compact progress until all targets are terminal, then use `canvas_get_node_images` for explicit,
   vision-ready result previews.
8. To revise one shot, update only its source `imageNode` prompt or connections with a new
   `canvas_propose_changes` call, then run only that node again.

`canvas_propose_changes`, imports, runs, and image reads return their final result directly when they
finish inside their fast-wait window. Call `canvas_get_change_status` or
`canvas_get_action_status` only when the original request returned `pending`. There is no fixed total
call limit; calls follow clarification, atomic setup, execution, observed progress waves, QA, and
localized rework.

Despite the compatibility-preserving tool and response names, there is no approval queue. Lumina
revalidates the active project and revision, applies the complete change set immediately, and records
one history checkpoint. One canvas undo restores the entire batch. A concurrent canvas mutation makes
the request stale instead of partially applying it.

## CanvasChangeSet

The change-set surface accepts only these operations:

- `create_node`: create a registry-approved manually configurable node using a temporary `clientId`.
- `update_node`: patch fields explicitly listed as writable in `nodeRegistry`.
- `move_node`: set a node position.
- `connect_nodes`: add a connection accepted by Lumina's typed connection validator.

Temporary `clientId` values can be referenced by later operations in the same change set. The apply
result returns their final Lumina node IDs. Upload media is intentionally handled by
`canvas_import_images`, not by writable media fields on `create_node` or `update_node`.

For externally created or updated nodes, `displayName` is a concise canvas title of at most 80
characters. Put the complete generation instruction in `prompt`; an unnamed `imageNode` receives a
stable `AI生图 N` title, and its generated result uses the source title plus `· 结果`.

## Action tools

- `canvas_import_images`: prepare up to 12 absolute local paths, file URLs, HTTP(S) URLs, or raster
  image data URLs in parallel, then create one batch of existing upload nodes.
- `canvas_run_nodes`: submit up to 12 existing image-generation nodes in parallel through the same
  application service used by each node's Generate button.
- `canvas_wait_for_nodes`: long-poll up to 12 explicit target nodes and return only their statuses,
  revision, and batch counts when progress changes or the wait times out.
- `canvas_get_node_images`: return status metadata and compressed WebP previews for up to 12
  explicitly named image nodes.
- `canvas_get_action_status`: poll only a previously returned pending action.

Running nodes creates the same result nodes and provider jobs as manual generation. The MCP bridge
does not create result nodes directly and does not introduce task, photoshoot, or workflow-specific
node types.

## Security and privacy

- External access is disabled until the user enables it in Lumina settings.
- The server binds only to numeric loopback address `127.0.0.1`.
- Every bridge request except the basic `/health` readiness check requires a high-entropy owner-local
  bearer token. `/health` returns active project identity only to authenticated callers.
- API credentials, local paths, original image payloads, and SQLite snapshots are never returned.
- Selection reads may include compressed 320px previews; larger result previews require explicit
  node IDs through `canvas_get_node_images`.
- Imported media uses Lumina's existing project image pipeline and is copied into the active project.
- One client can have only one in-flight proposal or action.
- No active heartbeat returns `NO_ACTIVE_CANVAS`; there is no persisted-state fallback.
- Deletion, arbitrary result-node creation, media-field patching, and closed-project access remain
  unavailable.

Enabling access authorizes compatible writes to the currently open project without an additional
dialog. The operation whitelist, revision check, atomic application, and one-step undo remain enforced.

## Development mode

Browser-only development retains the manual bridge fields:

```bash
npm install --prefix canvas-agent
npm run canvas-agent:build
npm run canvas-agent:config
npm run canvas-agent:start
```

Enter the generated URL and token in the browser settings. Register the source-based MCP entry with:

```bash
codex mcp add lumina -- node /absolute/path/to/Lumina/canvas-agent/dist/index.js mcp
```

Tauri development and production builds use the standalone binary automatically:

```bash
npm run tauri dev
npm run tauri build
```

## Verification

```bash
npm run canvas-agent:test
npm run canvas-agent:sidecar
npm run canvas-agent:sidecar:smoke
TAURI_DEV_HOST=127.0.0.1 npx vitest run
npx tsc --noEmit
cd src-tauri && cargo check
npm run build
```
