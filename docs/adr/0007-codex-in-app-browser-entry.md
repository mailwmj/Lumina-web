---
status: accepted
---

# Codex plugin uses the in-app browser

## Decision

When the Lumina Codex plugin receives `canvas_open`, Codex opens the returned
session URL in Codex's in-app browser. The MCP result identifies this contract
with `browserTarget: "codex-in-app-browser"`. Plugin instructions and skills must
wait for the bridge handshake before reading canvas state.

Connected Chrome remains a supported manual browser entry, but it is not the
Codex plugin target or a fallback when the in-app browser is unavailable. The
plugin must stop with a prerequisite diagnostic rather than opening another
browser context or project library.

## Storage and authorization boundary

This decision changes only the Codex presentation and session-client entry. The
installed Runtime remains the sole durable owner of project snapshots, history,
asset metadata, and asset bytes. Browser IndexedDB remains settings-only. The
existing Runtime editor lease and explicit run authorization contracts remain
unchanged. The in-app browser automatically requests the bounded, non-billing
Runtime editor lease for the active project when the bridge connects; generation
runs still require a separate current approval.
