# Lumina Canvas 插件

Lumina 桌面 Runtime 与 Codex 插件需要分别安装和启用。安装 Lumina 时会把插件包放入 Lumina 的应用目录，但安装器不会检查或修改 Codex 配置。

## 在 Codex 中安装

安装本插件前，请先安装或执行 Repair 修复 Lumina。插件包目录名为
`Lumina-Codex-Plugin`：macOS 的默认位置是
`/Applications/Lumina.app/Contents/Resources/Lumina-Codex-Plugin`；Windows 位于所选 Lumina 安装目录中。

运行 Codex 的环境需要 Node.js 18 或更高版本，以启动本插件的 MCP 主机。Lumina 本身不需要 Node.js、npm、Git、源码 checkout 或终端。

### 通过个人 Marketplace 安装

当 Plugins 页面没有本地文件夹导入入口时，使用这个 Codex 官方支持的流程。它会让 Codex 管理插件副本；不要自行把文件复制到 Codex 缓存目录。

1. 创建一个本地 Marketplace 目录，完整复制 `Lumina-Codex-Plugin`，并将其放在 `plugins/lumina-canvas` 下：

   ```text
   <marketplace-root>/
     .agents/plugins/marketplace.json
     plugins/lumina-canvas/
       .codex-plugin/plugin.json
       .mcp.json
       scripts/
       skills/
   ```

2. 在 `<marketplace-root>/.agents/plugins/marketplace.json` 写入以下内容：

   ```json
   {
     "name": "lumina-installed",
     "interface": {
       "displayName": "Lumina Installed"
     },
     "plugins": [
       {
         "name": "lumina-canvas",
         "source": {
           "source": "local",
           "path": "./plugins/lumina-canvas"
         },
         "policy": {
           "installation": "AVAILABLE",
           "authentication": "ON_INSTALL"
         },
         "category": "Productivity"
       }
     ]
   }
   ```

3. 在可以运行 `codex` 命令的终端中，登记并安装该 Marketplace 条目：

   ```bash
   codex plugin marketplace add <marketplace-root>
   codex plugin add lumina-canvas@lumina-installed
   codex plugin list
   ```

   最后一条命令必须显示 `lumina-canvas@lumina-installed` 为 `installed, enabled`。

4. 新建一个 Codex 任务并让它打开 Lumina。插件会启动或复用已安装的 Runtime，并在 Codex 内置浏览器中打开已登记的 Origin。

如果 Codex 提供支持本地插件或 Marketplace 导入界面，请选择 `Lumina Installed` 来源并在那里安装 `Lumina Canvas`，无需运行第二条命令。无论使用哪种方式，安装后都要新建任务，Codex 才会加载随插件附带的 Skill 与 MCP 工具。

当前 Marketplace 格式和 CLI 命令见 [Codex 官方插件文档](https://developers.openai.com/plugins/build/plugins)。

### Lumina 修复或升级后更新插件

Marketplace 保存的是插件包副本。因此 Lumina 替换 `Lumina-Codex-Plugin` 后，请按以下步骤更新：

1. 运行 `codex plugin remove lumina-canvas@lumina-installed` 删除已安装的 Codex 插件。
2. 用新插件包替换 Marketplace 中的 `plugins/lumina-canvas`。
3. 运行 `codex plugin marketplace upgrade lumina-installed`，再运行 `codex plugin add lumina-canvas@lumina-installed`。
4. 新建一个 Codex 任务。

普通安装版使用时，不要用 `npx`、`npm run canvas:codex` 或源码 checkout。这些都是开发工具，不能替代已安装的 Runtime 或其管理的项目库。

Codex 内置浏览器是本插件的正式入口。插件不会使用未固定版本的 `npx` 回退，不会回退到已连接的 Chrome，也不会创建第二个项目库。项目快照、历史记录和资产始终保存在已安装 Runtime 的管理项目库中；浏览器 IndexedDB 仅保存独立设置。

## 启动诊断

- `requires Node.js >=18`：安装受支持的 Node.js 版本后重启 Codex。
- `Runtime executable is missing or cannot be accessed`：安装或 Repair 修复 Lumina。
- `Runtime version metadata is missing or invalid`：Repair 修复 Lumina。
- `Lumina and the Lumina Canvas plugin are incompatible`：Repair 修复 Lumina，再通过 Codex 更新插件。
- `Codex's in-app browser is unavailable`：使用启用了内置浏览器的 Codex 任务；不要切换到其他浏览器项目。
