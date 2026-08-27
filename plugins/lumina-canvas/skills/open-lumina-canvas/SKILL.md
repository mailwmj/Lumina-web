---
name: open-lumina-canvas
description: Open the installed Lumina canvas in Codex's in-app browser.
---

Use this Skill only when the user explicitly asks to open or use Lumina. Call `canvas_open` with no arguments. When it returns `awaiting_browser`, open the returned `url` in Codex's in-app browser exactly as returned and wait for the bridge handshake. If an existing Lumina tab is already at that canonical Origin, reload it once after navigating to the returned URL so the app consumes the new fragment. Reuse the stable canonical Origin, do not replace it, or retain the fragment after the page has loaded.

Do not open or fall back to connected Chrome. If Codex's in-app browser is unavailable, tell the user that the Codex in-app browser is required and stop. Do not create a session-local or other isolated browser project library.

Wait for the page to connect, then call `canvas_get_state` only when current canvas state is needed.
