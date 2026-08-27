# Lumina Canvas plugin

The Lumina desktop Runtime and the Codex plugin are installed and activated separately. Installing Lumina places this plugin bundle inside the Lumina application payload, but the installer does not inspect or modify Codex configuration.

## Import and prerequisites

1. Install or Repair Lumina using the native installer.
2. In Codex's supported local plugin or marketplace import interface, select `Lumina-Codex-Plugin` from the Lumina installation payload. On macOS the default bundle is `/Applications/Lumina.app/Contents/Resources/Lumina-Codex-Plugin`; on Windows it is `Lumina-Codex-Plugin` inside the selected Lumina install directory.
3. Ensure the environment that starts Codex can run Node.js 18 or newer. The Lumina desktop Runtime itself does not require Node.js.
4. Ask Codex to open Lumina. The production plugin opens the Runtime's registered Origin in Codex's in-app browser.

The in-app browser is the official Codex entry for this plugin. The plugin does not use an unpinned `npx` fallback, fall back to connected Chrome, or create a second project library. Project snapshots, history, and assets remain in the installed Runtime's managed library; browser IndexedDB remains limited to settings.

## Startup diagnostics

- `requires Node.js >=18`: install a supported Node.js version and restart Codex.
- `Runtime executable is missing or cannot be accessed`: install or Repair Lumina.
- `Runtime version metadata is missing or invalid`: Repair Lumina.
- `Lumina and the Lumina Canvas plugin are incompatible`: Repair Lumina, then re-import or update the plugin through Codex.
- `Codex's in-app browser is unavailable`: use a Codex session with the built-in browser enabled; do not switch to another browser project.
