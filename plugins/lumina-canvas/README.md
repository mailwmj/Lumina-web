# Lumina Canvas plugin

The Lumina desktop Runtime and the Codex plugin are installed and activated separately. Installing Lumina places this plugin bundle inside the Lumina application payload, but the installer does not inspect or modify Codex configuration.

## Import and prerequisites

1. Install or Repair Lumina using the native installer.
2. In Codex's supported local plugin or marketplace import interface, select `Lumina-Codex-Plugin` from the Lumina installation payload. On macOS the default bundle is `/Applications/Lumina.app/Contents/Resources/Lumina-Codex-Plugin`; on Windows it is `Lumina-Codex-Plugin` inside the selected Lumina install directory.
3. Ensure the environment that starts Codex can run Node.js 18 or newer. The Lumina desktop Runtime itself does not require Node.js.
4. Connect Chrome to Codex before asking it to open Lumina. The production plugin opens or focuses the Runtime's registered Origin in that connected Chrome.

The plugin does not use an unpinned `npx` fallback, create a second project library, or open Lumina in an isolated Codex browser. Project snapshots, history, and assets remain in the installed Runtime's managed library; browser IndexedDB remains limited to settings.

## Startup diagnostics

- `requires Node.js >=18`: install a supported Node.js version and restart Codex.
- `Runtime executable is missing or cannot be accessed`: install or Repair Lumina.
- `Runtime version metadata is missing or invalid`: Repair Lumina.
- `Lumina and the Lumina Canvas plugin are incompatible`: Repair Lumina, then re-import or update the plugin through Codex.
- `Connect Chrome to Lumina, then try again.`: connect Chrome and repeat the request; do not switch to another browser project.
