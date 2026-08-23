---
status: accepted
---

# 通过 Codex 插件桥接 Web 画布

> **实施状态（2026-08-23）**：本 ADR 记录当前浏览器桥接实现。ADR-0006 接受未来运行时文件项目库，但未改写下文的历史浏览器事实源说明；在 #43-#45 交付前，该说明仍是当前实现，companion 也不直接读取 IndexedDB、项目数据、长期资产或 AI Key。

Web 版使用可选 Codex 插件取代原先随 Tauri 安装包分发的 MCP companion。插件通过同一个 Node 包的两个运行模式分别提供 stdio MCP 和仅监听 `127.0.0.1` 的 HTTP/SSE companion；打开 Skill 启动或复用 companion，并让 Codex 在用户已连接的 Chrome 中打开或聚焦返回的已登记 Origin。没有连接的 Chrome 时它请求连接并停止，不创建隔离浏览器项目库。浏览器画布仍是事实源，companion 不读写 IndexedDB、项目数据、长期资产或 AI Key。

连接使用一次性 URL fragment 引导短期 bootstrap 凭据，页面读取后立即清除 fragment；该时限只约束首次认证连接。认证成功后，会话在浏览器页面保持打开期间持续有效，且可先连接、后选择项目；后续访问受固定 Origin、会话、`projectId` 和画布 revision 约束。项目级显式启用授予受限非计费写权限，生成等计费或外部副作用操作仍需单独授权；过期 revision 必须返回 `stale`，不得覆盖用户的新编辑或自动重放生成。

Web、插件和 companion 在连接时交换协议主次版本、构建版本和能力列表。协议主版本不兼容时关闭全部桥接能力但不影响 Web 独立使用；次版本不同时只开放双方能力交集。无法识别或未声明支持的读取和写入操作一律拒绝；可变的版本标签也不能作为兼容性依据。

> **历史实现说明（2026-08-24）**：早期原型中通过 `npx -y` 拉取 companion `latest` 的规则已经废止，不能再描述为当前插件路径。当前仓库中的 plugin MCP manifest 运行其打包的 `scripts/launch-installed-runtime.mjs`，由该启动器按显式开发覆盖、安装器 locator 和受控旧路径解析兼容的已安装 Lumina runtime；它不下载或执行一个 `@latest` companion。发布/桥接验证仍须在真实 Codex Desktop 与用户已连接 Chrome 中覆盖 loopback 连接、已登记 URL 的打开或聚焦、凭据清理、断线和 token 轮换。
