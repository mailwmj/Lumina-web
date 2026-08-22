---
status: superseded by ADR-0005
---

# Codex 画布使用会话级本地 Origin

Codex 只读画布桥接不依赖公网域名或固定常见端口。启动器先将本地前端绑定到 `127.0.0.1:0`，再将操作系统分配的精确 `http://127.0.0.1:<port>` Origin 传给 companion；`canvas_open` 只返回该 Origin，且 CORS/PNA 只接受它。会话关闭即关闭前端 host 和 companion 并使 bootstrap 失效；`localhost` 别名、任意 Origin 和浏览器提交的 Origin 覆盖一律拒绝。这一决定取代 ADR 0003 中对 Codex 打开路径使用固定生产站点的约束，不改变浏览器作为项目事实源的归属。
