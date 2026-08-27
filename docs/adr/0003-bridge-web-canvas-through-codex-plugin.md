---
status: superseded by ADR-0007
---

# 通过 Codex 插件桥接 Web 画布

> **入口更新（2026-08-27）**：本文保留 Runtime bridge、权限和协议的历史决策；Codex plugin 的浏览器入口已由 ADR-0007 改为 Codex 内置浏览器。connected Chrome 仅作为手动外部入口，不是插件回退路径。

> **实施状态（2026-08-25）**：插件通过已安装 Runtime 提供受控桥接；项目、历史和资产的持久归属以 ADR-0006 为准。companion 不直接读取 Runtime 存储、长期资产或 AI Key。

Web 版使用可选 Codex 插件提供 stdio MCP 和仅监听 `127.0.0.1` 的 HTTP/SSE companion。插件 MCP manifest 运行打包的 `scripts/launch-installed-runtime.mjs`；启动器按显式开发覆盖、安装器 locator 和受控旧路径解析兼容的已安装 Lumina Runtime。打开 Skill 启动或复用 Runtime，并让 Codex 在用户已连接的 Chrome 中打开或聚焦返回的已登记 Origin。没有连接的 Chrome 时它请求连接并停止，不创建隔离浏览器项目库。

连接使用一次性 URL fragment 引导短期 bootstrap 凭据，页面读取后立即清除 fragment；该时限只约束首次认证连接。认证成功后，会话在浏览器页面保持打开期间持续有效，且可先连接、后选择项目；后续访问受固定 Origin、会话、`projectId` 和画布 revision 约束。项目级显式启用授予受限非计费写权限，生成等计费或外部副作用操作仍需单独授权；过期 revision 必须返回 `stale`，不得覆盖用户的新编辑或自动重放生成。

Web、插件和 companion 在连接时交换协议主次版本、构建版本和能力列表。协议主版本不兼容时关闭全部桥接能力但不影响 Web 独立使用；次版本不同时只开放双方能力交集。无法识别或未声明支持的读取和写入操作一律拒绝；可变的版本标签也不能作为兼容性依据。

发布和桥接验证须在真实 Codex Desktop 与用户已连接 Chrome 中覆盖 loopback 连接、已登记 URL 的打开或聚焦、凭据清理、断线和 token 轮换。
