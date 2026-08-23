---
name: lumina-canvas
description: Read the current Lumina canvas and make only explicitly authorized bounded changes.
---

Call `canvas_open` first. When it is awaiting a browser, open or focus the returned URL in Codex's in-app browser at its stable canonical Origin. If an existing Lumina tab is already at that canonical Origin, reload it once after navigating to the returned URL so the app consumes the new fragment. If the Codex in-app browser is unavailable, ask the user to open it and stop; never open external Chrome or a separate browser project. Then use `canvas_get_state`, `canvas_get_selection`, and `canvas_get_capabilities` for the currently connected browser project. Reuse the returned project ID and revision for every subsequent request.

The project is read-only until its browser owner enables bounded non-billing writes for this session. After that grant, submit one `canvas_propose_changes` change set at a time. Only allowed create, update, move, and connection operations are available; project deletion, credential reads, arbitrary result-node creation, and arbitrary file reads are unavailable.

Use `canvas_import_images` only for user-provided HTTPS raster images or raster base64 data URLs. Do not request local paths or file URLs. `canvas_run_nodes` always requires a separate, current browser approval. Use `canvas_wait_for_nodes`, `canvas_get_node_images`, and status tools for compact progress and previews.

After a stale revision, disconnect, timeout, close, or token rotation, do not replay a write, import, or run request. Treat the session as unavailable until a new `canvas_open` connection is established.
