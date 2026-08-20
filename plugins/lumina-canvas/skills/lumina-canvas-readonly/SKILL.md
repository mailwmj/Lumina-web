---
name: lumina-canvas-readonly
description: Read the current Lumina canvas without changing projects, files, settings, or generation state.
---

Use `canvas_get_state`, `canvas_get_selection`, and `canvas_get_capabilities` only after `canvas_open` has connected the current browser canvas. Treat a disconnected or incompatible session as unavailable. Do not request canvas writes, image imports, generation, local files, credentials, or another project.
