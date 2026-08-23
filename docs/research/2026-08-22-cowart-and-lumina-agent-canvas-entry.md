# Cowart 与 Lumina Agent 画布入口调研

日期：2026-08-22  
范围：只检查 Cowart 仓库和当前 Lumina 工作区的一手源码、配置与技能说明；未运行 Cowart，也未使用第三方评测或文章。  
Cowart 快照：[`c40d2544363335f6380c8e2d919942fc78810ff0`](https://github.com/zhongerxin/Cowart/tree/c40d2544363335f6380c8e2d919942fc78810ff0)。  
Lumina 快照：本工作区 `f3425bd85edec2b30bfb6fc901c02bffbd563475`。

> **后续决策说明（2026-08-23）**：本文是该快照上的历史调研。文中关于 Codex in-app browser 的插件路径仅描述该快照，不是当前入口；当前 MCP 指令和安装 Skill 在用户已连接的 Chrome 中打开或聚焦返回 URL，连接缺失时请求连接并停止。浏览器 IndexedDB 数据归属描述当时以及当前实现。ADR-0006 此后接受运行时文件项目库作为目标，但它尚未由 #43-#45 实现；不得将本文的浏览器结论当作未来存储架构，也不得将 ADR-0006 当作已上线实现。

## 结论

Cowart 的关键体验不是“Agent 打开一个浏览器页面后操作它”，而是 **Codex 原生 MCP App widget**：Agent 调用一个 `render_cowart_canvas_widget` 工具，返回 `ui://widget/...` 输出模板，Codex 直接渲染内联 tldraw 画布。[C1][C2] 正常路径没有 localhost 页面，也没有浏览器自动化；本地 Vite 服务只是开发 fallback。[C1][C3]

在该快照中，Lumina 的已发布插件同样不会要求终端用户每次手动启动服务：Codex 通过插件配置执行 `npx -y @lumina-web/canvas-agent@latest web-mcp`。[L1] 但其 `canvas_open` 返回一个含一次性 bootstrap 的会话本地 URL，技能明确要求 Agent 在 Codex in-app browser 中打开它。[L2][L3] 因此当时真正的产品差异是 **host 内嵌 widget** 与 **Agent 代为导航到受会话保护的浏览器画布**，不是“有无 MCP”或“有无本地进程”。

Lumina 的产品决策是：一台电脑上的手动 URL 入口和 Codex Agent 入口必须访问同一份浏览器项目库。因此现有会话本地浏览器路径不能成为普通用户路径；它会以独立 browser context 和动态 Origin 形成另一份 IndexedDB。直接照搬 Cowart 的文件存储同样不合适；短期方向应是让 Agent 打开或聚焦用户已连接浏览器中的固定 Lumina URL，并保留浏览器 IndexedDB 与项目级授权边界。

## Cowart 的技术方案

### 入口、部署与每次使用

Cowart 是一个 Codex plugin：`mcp.json` 用 stdio 启动 Node 脚本；启动器在插件自身目录检查依赖，缺失时执行 `npm install`，随后加载 MCP server。[C4][C5] 用户的一次性动作是把 Git marketplace 和插件加入 Codex，并完全重启 Codex；首次 MCP 启动还可能需要 Node、npm 与网络来补依赖。[C1]

每个项目的常规动作是对 Agent 说“Open the Cowart canvas for this project.”。其 Open skill 让 Agent 调用 render 工具，并把活动工作区作为 `projectDir`；不启动开发服务器，也不打开 localhost URL。[C3] render 工具注册 `ui://widget/cowart/canvas.html` 资源，声明 `openai/outputTemplate`，默认全屏；静态 Vite 构建被内联为 widget HTML 并缓存在临时目录。[C2][C6]

这意味着 Cowart 仍有安装、重启和一次「打开画布」意图，优势是这些前置步骤之后用户看不到端口、URL 或终端命令。它不是可直接给任意浏览器客户端访问的 hosted Web app。

### UI 与 Agent 协作

Widget 用 `@modelcontextprotocol/ext-apps` 建立 host bridge。它可向当前 Codex 对话发送后续用户消息，也能调用 Cowart MCP server tools；这是一条 host/widget MCP 通道，不是 Playwright、CDP 或网页点击自动化。[C7] Cowart 的技能以 MCP 工具读取选择、保存状态、插入图像或 HTML；图像生成本身由 Codex 的 imagegen 能力完成，再由 `insert_cowart_image` 落回画布。[C8][C9]

画布本体是 tldraw。用户在 widget 中编辑，前端对画布快照作 500ms 防抖保存，选择与视图状态分别周期同步；widget 模式下还以 1600ms 拉取 MCP 存储的远端快照。[C10] 这给了 Agent 可见的选择状态和确定的插入锚点，但不是 Lumina 那种节点注册表、异步生成任务与项目 revision 协议。

### 数据归属与持久化

Cowart 将数据写入调用方给出的 `projectDir` 下的 `canvas/`：每页一个 `cowart-canvas.json` 和 `assets/`，并另存 selection 与 view state JSON。[C1][C11] 画布快照通过临时文件加 rename 原子落盘；保存时会拒绝未确认的已有图片 shape 丢失。[C12] 资源文件名和子路径有清理与目录边界检查，页面资源限定为图片或 HTML。[C13]

这与 Lumina 的浏览器项目库不同：Lumina 把项目、历史、长期资产和提供商凭据保留在画布浏览器的 IndexedDB/runtime，companion 不读取它们。[L4] Cowart 的项目文件对同一工作区的普通 Git/文件流很友好；Lumina 则优先获得浏览器本地 Blob 生命周期、离线数据库和凭据隔离。

### 会话与安全边界

Cowart 的工具输入接受可选 `projectDir`/`canvasDir`，并直接解析为文件系统路径，默认回退到进程工作目录。[C11] 在已选定 canvas 根目录内，它确实做资源路径穿越防护、文件名清理、MIME 限制和快照校验。[C12][C13]

**范围受限的源码审阅推断，不是完整安全审计：** 在该固定版本中，Cowart 的 render/state/image 工具没有 Lumina 那样的会话 token、绑定 project ID、revision 或浏览器所有者写授权参数；选择哪个项目目录由 MCP 调用方传入。因此它的权限模型主要依赖 Codex plugin/MCP 进程本身的本地文件权限和 Agent 指令，而非每个项目的运行时能力授权。[C2][C9][C11] 这适合 project-local 文件画布，但不应直接移植到含 provider key、计费生成和浏览器项目事实的 Lumina。

Cowart 还包含可配置的 GA4 通路：配置 API secret 后，MCP tool 会向 Google Measurement Protocol 提交枚举的产品事件和匿名 client ID；widget 代码会在 localStorage 保存该 ID，默认将 analytics storage 设为 granted。此项是 Cowart 的显式产品遥测行为，不是实现 widget 所必需的模式。[C14][C15]

## 与当前 Lumina 的差异

| 维度 | Cowart | 当前 Lumina Codex 插件 | 结论 |
| --- | --- | --- | --- |
| 呈现 | `ui://widget` 原生 Codex widget，正常路径没有浏览器导航。[C2] | 该快照的 `canvas_open` 返回会话 URL，Agent 在 in-app browser 打开。[L2][L3] | 该快照的 Lumina 路径会建立独立 browser context，不能满足两个入口共享项目库的产品目标。 |
| 启动 | plugin stdio + 插件目录首次 `npm install`；静态 widget 按需构建。[C4][C6] | plugin 自动执行 published package 的 `npx -y ... web-mcp`。[L1] | 两者都应由 Agent 客户端代为启动，终端不应暴露给终端用户。 |
| 数据事实源 | 项目目录内 JSON、图片和 HTML assets。[C1][C11] | 浏览器 IndexedDB/runtime；companion 不读项目、资产或 credentials。[L4] | 不能把 Cowart 的文件存储替换进 Lumina 而不改变产品架构。 |
| Agent 写入 | MCP 工具可保存整份 tldraw snapshot、插入本地 bitmap/HTML；工具元数据标示 destructive，但该版本没有项目 revision/浏览器授权协议。[C9][C16] | 读默认可用；写入需浏览器显式 grant，且每次带 project ID/revision，独立授权 import/run，stale 时不重放。[L5][L6] | Lumina 的安全和计费控制更适合生产生成工作流。 |
| 会话与网络 | widget host bridge 直接消息/调用工具；资源 CSP 允许 Google 相关域名，并含可选 GA4。[C7][C14] | 32-byte one-time bootstrap token、5 分钟 TTL、精确 loopback origin CORS、capability negotiation 和 session-bound project。[L6][L7] | Lumina 的会话隔离更强，但需要浏览器连接完成。 |
| 跨 Agent 客户端 | 依赖支持 MCP Apps `ui://widget` 的 Codex host。[C2][C7] | 依赖可打开会话 URL 的浏览器 host；更接近“Agent client 自己打开浏览器”。[L2][L3] | 若目标包含非 Codex Agent，浏览器路径应保留。 |

## 建议的 Lumina 体验路线

### 1. 先消除交互摩擦，同时维持单一项目库

把用户意图定义成「打开或继续当前 Lumina 画布」：用户明确要求打开或使用 Lumina 时，插件 skill/Agent 打开或聚焦用户已连接浏览器中的固定 Lumina URL，而不是创建会话本地 in-app browser 页面。若共享浏览器不可用，产品应提示连接浏览器，不能静默退回独立画布。这样用户不需要复制 URL、运行 `npm run canvas:codex` 或再输入一条命令，同时两个入口保持同一份项目、历史和资产。

验收应是：安装完成后，用户明确说一次打开或使用 Lumina；Agent 自动打开或聚焦同一浏览器项目库；用户在手动 URL 入口的编辑立即可由 Agent 读取，反向亦然；刷新/断线后 Agent 只重新建立桥接，不重放写入或生成。后半条必须保持，因为当前协议明确将 token rotation、超时和 stale revision 视为不可重放状态。[L5]

### 2. 把「首次安装」产品化

终端命令不应成为用户路径，但「安装一次 plugin」无法凭空消失。应通过 Codex plugin/marketplace UI 或一个可批准的一键安装流程完成插件安装；后续由 `.mcp.json` 启动 published companion。不要把开发命令 `npm run canvas:codex` 暴露为正常使用说明。[L1]

当前工作区登记的 Lumina marketplace 来源是 `local` personal source，而不是可供新用户发现和安装的远程来源。[L8] 因此“每次无需终端”虽已具备技术链路，“新用户无需研究安装命令”仍是待产品化的分发问题；在确认远程 marketplace 发布物和安装链路前，不应把它描述为已解决。

同时固定或审查 companion 版本策略。当前 `npx -y ...@latest` 有便利性，也意味着客户端每次可取得新包；任何改为更自动的入口都应保留协议版本协商和失败关闭能力。[L1][L6]

### 3. 不把 Cowart widget 直接搬入 Lumina

若只面向支持 MCP Apps 的 Codex，可另做一个小型 **Lumina host widget POC**，目标仅验证「由 host 渲染现有画布入口」能否减少导航，而不是复制 Cowart 的文件读写工具。POC 必须先回答：widget 的稳定 origin/IndexedDB 归属、能否继续使用当前 session-local loopback bridge、页面关闭后的持久化、PNA/CORS 与 explicit write grant 是否仍正确。

只有在这些答案为真时才评估将正式画布作为 widget。否则保留浏览器承载画布，使用一条 MCP tool + host navigation 的无感入口。无论呈现方式如何，项目 ID/revision、一次性 token、capability intersection、浏览器授权、禁止任意文件与凭据读取都必须留在 Lumina 现有 bridge 中。[L5][L6][L7]

## Sources

### Cowart primary sources (fixed commit `c40d2544363335f6380c8e2d919942fc78810ff0`)

- [C1: README.en.md, installation, normal use, and project storage](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/README.en.md#L11-L82)
- [C2: MCP widget resource and render tool](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/mcp/server.mjs#L1030-L1112)
- [C3: Cowart Open Canvas skill](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/skills/cowart-open-canvas/SKILL.md#L1-L25)
- [C4: stdio MCP configuration](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/mcp.json#L1-L13)
- [C5: dependency-installing MCP startup script](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/scripts/start-mcp.mjs#L1-L53)
- [C6: static widget build and temporary cache](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/mcp/lib/cowart-static-widget.mjs#L9-L101)
- [C7: MCP Apps host bridge](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/mcp/lib/widget-resource.mjs#L173-L355)
- [C8: image generation skill](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/skills/cowart-image-gen/SKILL.md#L1-L120)
- [C9: state and image MCP tools](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/mcp/server.mjs#L1185-L1601)
- [C10: widget persistence/synchronization timings](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/src/App.jsx#L5842-L6063)
- [C11: project/canvas directory resolution and state paths](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/mcp/lib/canvas-storage.mjs#L23-L80)
- [C12: atomic snapshots and image-loss guard](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/mcp/lib/canvas-storage.mjs#L480-L693)
- [C13: asset directory, type and path controls](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/mcp/lib/canvas-storage.mjs#L117-L120)
  and [page asset operations](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/mcp/lib/canvas-storage.mjs#L559-L638)
- [C14: GA4 MCP delivery path](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/mcp/lib/ga4-analytics.mjs#L5-L88)
- [C15: widget analytics ID and default consent](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/src/analytics.js#L1-L140)
- [C16: local bitmap insertion behavior](https://github.com/zhongerxin/Cowart/blob/c40d2544363335f6380c8e2d919942fc78810ff0/mcp/server.mjs#L1555-L1601)

### Lumina primary sources (worktree commit `f3425bd85edec2b30bfb6fc901c02bffbd563475`)

- [L1: plugin MCP startup configuration](../../plugins/lumina-canvas/.mcp.json) and [plugin manifest](../../plugins/lumina-canvas/.codex-plugin/plugin.json)
- [L2: MCP instructions and `canvas_open` URL result](../../canvas-agent/src/web/mcp.ts)
- [L3: open-canvas skill](../../plugins/lumina-canvas/skills/open-lumina-canvas/SKILL.md)
- [L4: companion ownership boundary](../../canvas-agent/README.md)
- [L5: restricted canvas skill and non-replay rule](../../plugins/lumina-canvas/skills/lumina-canvas/SKILL.md)
- [L6: session token, project binding, write authorization and capability checks](../../canvas-agent/src/web/session.ts)
- [L7: session-local loopback runtime, static host and exact-origin CORS](../../canvas-agent/src/web/runtime.ts), [local host](../../canvas-agent/src/readonly/localCanvasHost.ts), and [HTTP bridge](../../canvas-agent/src/web/http.ts)
- [L8: current personal marketplace registration](../../.agents/plugins/marketplace.json)
