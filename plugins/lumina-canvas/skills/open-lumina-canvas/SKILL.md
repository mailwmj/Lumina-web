---
name: open-lumina-canvas
description: Open the installed Lumina canvas in the user's connected Chrome.
---

Use this Skill only when the user explicitly asks to open or use Lumina. Call `canvas_open` with no arguments. When it returns `awaiting_browser`, open or focus the returned `url` in the user's connected Chrome exactly as returned. If an existing Lumina tab is already at that canonical Origin, reload it once after navigating to the returned URL so the app consumes the new fragment. Reuse the stable canonical Origin, do not replace it, or retain the fragment after the page has loaded.

When Chrome is not connected, tell the user: `Connect Chrome to Lumina, then try again.` Stop there. Do not create an in-app, session-local, or other isolated browser project library.

Wait for the page to connect, then call `canvas_get_state` only when current canvas state is needed.
