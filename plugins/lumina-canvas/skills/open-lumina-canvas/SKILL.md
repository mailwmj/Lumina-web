---
name: open-lumina-canvas
description: Open the current Lumina canvas in the Codex in-app browser.
---

Call `canvas_open` with no arguments. Open the returned `url` in the Codex in-app browser exactly as returned. Do not replace the canonical Origin, reuse the fragment, or retain the fragment after the page has loaded.

Wait for the page to connect, then call `canvas_get_state` only when current canvas state is needed.
