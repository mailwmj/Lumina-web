# Runtime startup baseline and entry matrix

Recorded on 2026-08-26 on macOS arm64 with Node.js 22.22.3. Timings use a local `git archive` of commit `00ec88c1`, an existing npm cache, and no warm-process reuse; they are diagnostic baselines, not cross-machine performance guarantees.

> **入口决策更新（2026-08-27）**：本文的启动耗时仍有效，但 Codex plugin 行已被 ADR-0007 supersede。Codex 正式浏览器目标为 Codex 内置浏览器；connected Chrome 仅作为手动外部入口。

## Baseline timings

| Operation | Result | Wall time |
| --- | --- | ---: |
| Fresh root `npm ci` plus `npm ci --prefix canvas-agent` | Dependencies installed | 9.02 s |
| First `npm run build` plus `npm run canvas-agent:build` | Web and companion artifacts built | 14.85 s |
| Old `npm run dev` until the Vite URL returned HTTP 200 | UI became available without Runtime API | 0.85 s |
| Existing artifacts followed by old `npm run canvas:runtime` | Rebuilt both artifact sets, then failed with `invalid_root` | 11.65 s |
| Old plugin launcher with a missing Runtime path | Exited with only the combined “not installed or incomplete” message | 0.04 s |

The baseline failure happened only after the repeated build. The stack entered `productionRuntime.mjs` and `createFileProjectLibrary()` before reporting that no managed root could be selected on macOS. The file-library tests also failed beneath `os.tmpdir()` because `/tmp` resolved through a symlink ancestor; this was test fixture path safety, not damaged project data.

## Entry matrix

| User | Install/preflight | Entry | Project API and durable owner | Browser target | Process lifecycle |
| --- | --- | --- | --- | --- | --- |
| Source developer, complete product | `npm ci`, `npm ci --prefix canvas-agent`, `npm run dev:check` | `npm run canvas:runtime` | Runtime API; managed file library | Registered local Origin in Chrome | Foreground; keep terminal open. Builds only missing, invalid, or stale artifacts. |
| Source developer, UI only | Root dependencies; preflight runs automatically | `npm run dev` | No Runtime project API | Vite URL | Foreground; keep terminal open. Terminal explicitly labels the missing project API. |
| Source developer, generation split | Root dependencies | `npm run gateway:dev` plus `npm run dev` | Gateway only; still no Runtime project API | Vite URL | Two foreground terminals. |
| Desktop installation | Signed native installer; no Node.js required | `lumina://open` or installed launcher | Installed Runtime; `%LOCALAPPDATA%\Lumina\library` or `~/Library/Application Support/Lumina/library` | Registered local Origin | Runtime-managed background process. |
| Codex plugin | Desktop installation, explicit Codex import, Node.js >=18, Codex in-app browser | `canvas_open` through the plugin MCP | Same installed Runtime and managed library | Codex's in-app browser | Codex manages the MCP process; user does not run source commands. |

## Platform verification status at baseline

| Check | macOS arm64 | Windows x64 |
| --- | --- | --- |
| Production Runtime health | Blocked by `invalid_root` before this change | Automated contracts only; real package pending |
| Create project and restart restore | Blocked by `invalid_root` before this change | Automated contracts only; real package pending |
| Plugin import and MCP launch | Source/plugin tests only | Source/plugin tests only |
| Node.js and Runtime compatibility diagnostics | Runtime compatibility existed; explicit Node precheck missing | Same source behavior |
| Signed installation, protocol, Repair, plugin connection | Not performed in this source baseline | Not performed in this source baseline |

Real signed-package observations remain release evidence. A source test or an unsigned staging payload cannot be relabeled as Windows or macOS installation acceptance.
