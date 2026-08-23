---
status: accepted
---

# 通过 Codex 插件桥接 Web 画布

> **实施状态（2026-08-23）**：本 ADR 记录当前浏览器桥接实现。ADR-0006 接受未来运行时文件项目库，但未改写下文的历史浏览器事实源说明；在 #43-#45 交付前，该说明仍是当前实现，companion 也不直接读取 IndexedDB、项目数据、长期资产或 AI Key。

Web 版使用可选 Codex 插件取代原先随 Tauri 安装包分发的 MCP companion。插件通过同一个 Node 包的两个运行模式分别提供 stdio MCP 和仅监听 `127.0.0.1` 的 HTTP/SSE companion；打开 Skill 启动或复用 companion，并让 Codex 在用户已连接的 Chrome 中打开或聚焦返回的已登记 Origin。没有连接的 Chrome 时它请求连接并停止，不创建隔离浏览器项目库。浏览器画布仍是事实源，companion 不读写 IndexedDB、项目数据、长期资产或 AI Key。

连接使用一次性 URL fragment 引导短期 bootstrap 凭据，页面读取后立即清除 fragment；该时限只约束首次认证连接。认证成功后，会话在浏览器页面保持打开期间持续有效，且可先连接、后选择项目；后续访问受固定 Origin、会话、`projectId` 和画布 revision 约束。项目级显式启用授予受限非计费写权限，生成等计费或外部副作用操作仍需单独授权；过期 revision 必须返回 `stale`，不得覆盖用户的新编辑或自动重放生成。

Web、插件和 companion 在连接时交换协议主次版本、构建版本和能力列表。协议主版本不兼容时关闭全部桥接能力但不影响 Web 独立使用；次版本不同时只开放双方能力交集。无法识别或未声明支持的读取和写入操作一律拒绝，尤其不得因 companion 使用 `latest` 而猜测兼容。

插件允许通过 `npx -y` 拉取 companion 的 `latest` 版本。这意味着 companion 可在不更新插件的情况下变化，并会以本机 Node 进程权限运行；该供应链风险已被明确接受，但阶段 0 仍必须在真实 Codex Desktop 与用户已连接 Chrome 中验证 HTTPS 到 loopback 的 PNA、SSE、POST、已登记 URL 的打开或聚焦、凭据清理、断线和 token 轮换。
