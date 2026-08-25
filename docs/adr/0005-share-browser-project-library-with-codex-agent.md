---
status: superseded
---

# Codex 与 Chrome 的 Runtime 画布边界

Lumina 的唯一持久事实源是已安装本机 Runtime。Chrome 是正常画布编辑器，Codex 通过受控 Web bridge 操作同一画布；两者都不是项目数据库，也不直接接触文件系统。

## 当前决定

- Runtime 持有项目 complete snapshot、画布 history、asset metadata 和 asset bytes。
- 浏览器旧 IndexedDB project/history/assets 记录被刻意忽略：不读取、不迁移、不 fallback、不 dual-write，也不自动删除。IndexedDB settings 是独立范围。
- Runtime API 只暴露逻辑 project/asset ID 和 path-free errors。任何客户端都不会获得文件根目录、原始路径、目录列表或通用文件操作。
- Runtime 只有一个全局 editor lease。Chrome 或 Codex 只能有一个 durable writer；打开不同项目也不能绕过该限制。
- Codex 写权限只能由 Chrome 明确批准并完成 handoff。每个 Codex action 使用 action-bound、短期、一次性 delegation；断线、过期、失败 action、release 或 Runtime shutdown 会撤销 authority。
- generation/run approval 与 editor lease 独立。生成轮询产生的后续资产和快照写入仍须通过原 action 的 authority，authority 失效时 fail closed。
- Object URL、签名 URL、provider credential、Runtime session/lease/delegation token 和 GenerationGateway 临时介质只存在于短期运行内，不能进入项目数据。

## 结果

项目 repository 和 asset repository 是 Runtime client adapters。文件布局、原子发布、恢复、引用保护、大小限制和 managed-path 防护全部由 Runtime 内部负责。项目 archive/import/export、caller-visible revision、expected-revision/OCC、merge 和 collaboration 不属于产品边界。

旧版浏览器共享项目库和 Codex 连续性决策仅作为历史记录保留，不再描述当前实现或目标实现。
