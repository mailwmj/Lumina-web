---
name: open-lumina-canvas
description: Open the installed Lumina canvas in the user's connected Chrome.
---

Use this Skill only when the user explicitly asks to open or use Lumina. Call `canvas_open` with no arguments. When it returns `awaiting_browser`, open or focus the returned `url` in the user's connected Chrome exactly as returned. Reuse the stable canonical Origin, do not replace it, reuse the fragment, or retain the fragment after the page has loaded.

When Chrome is not connected, tell the user: `Connect Chrome to Lumina, then try again.` Stop there. Do not open another browser, start a session-local canvas, or create a separate project library.

Wait for the page to connect, then call `canvas_get_state` only when current canvas state is needed.
