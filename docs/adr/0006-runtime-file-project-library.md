---
status: accepted
---

# 运行时文件项目库与浏览器迁移

> **实施状态（2026-08-23）**：这是已接受的目标架构，不是当前已交付的存储实现。当前仓库仍由固定 Origin 的浏览器 IndexedDB 适配器持有项目、历史、资产和设置。#45 的未来 cutover 只会把项目、历史和资产交给运行时文件项目库；浏览器 settings（包括混合记录）会继续写入，直到 #46 把非秘密偏好和凭据/token 分离到各自目标并冻结 settings store。本 ADR 的权威合同中“迁移源”“cutover”和“运行时客户端”描述该目标交付的行为，不能倒推为当前代码已经切换。
>
> **下游实施前提（规范性）**：在 GitHub 上仍然 live 的 Issue #45 和 #46 被分别修订为本 ADR 已接受的 connected-Chrome 唯一浏览器项目库、#45 只迁移 projects/history/assets 且 settings 保持 browser-live、以及 #46 单独迁移 preferences/credentials 并冻结 settings 的 staged-ownership 合同之前，下游实现不得开始。本 ADR 不修改 Issue；该 tracker 修订需要另行获得授权，不能由实现提交或本文档替代。

Lumina 已接受的目标是：项目、画布历史和长期资产由安装后的本地运行时管理的一份按用户隔离、文件持久化的 Lumina 项目库持有。届时浏览器画布、Codex 和未来的 MCP App widget 都是该项目库的客户端；它们不再各自以 IndexedDB 决定项目事实。该目标取代 ADR-0002、ADR-0005 和 Issue #33 中浏览器或 Chrome Profile 是长期项目事实源的决策，同时保留浏览器作为画布界面、稳定本地入口以及已有 MCP 授权规则。

## 决定

目标本地运行时拥有一个深模块：它在 ProjectRepository 和 AssetRepository 的既有接口之后处理文件布局、校验、并发、恢复和垃圾回收，并在 #46 后承接 SettingsRepository 的目标偏好/凭据边界。浏览器、Codex、MCP 和未来 widget 都不得接收项目目录或任意文件路径，也不得直接读取这些文件。当前 `webProjectRepository`、`indexedDbAssetRepository` 和 `indexedDbSettingsRepository` 仍是唯一已实现的浏览器数据路径；#45 只把前两类的项目、历史和资产 stores 变成冻结迁移输入，#46 才冻结 settings，而不是形成第二写入端。

项目库不引入 Cowart 的 page、workspace 或调用方 projectDir 概念。它只表示现有 ProjectRecord、保留历史、AssetMetadata 和 Blob 字节所表达的 Lumina 项目事实。GenerationGateway 继续是临时受控边界，不成为项目库。

## 状态与历史

ADR-0006 的历史决定、接受状态和当前/目标边界只在本文件维护。其规范性合同已按稳定主题拆分到下列文件；根 ADR 不重复那些条款。ADR-0002 和 ADR-0005 保留其浏览器事实源的历史记录，直到相应的未来 cutover 已按这里的合同交付。

## 权威合同索引

| 需要确定的主题 | 唯一权威文件 | 使用时机 |
| --- | --- | --- |
| 根目录、文件布局、路径和规范字节/摘要、导出边界 | [结构与完整性](./0006-runtime-file-project-library/library-schema.md) | 实现或审查文件项目库 schema、内容寻址或摘要。 |
| 原子发布、并发、导入、删除生命周期、隔离、保留和 GC | [发布、导入与保留](./0006-runtime-file-project-library/publication-and-import.md) | 实现 catalog/head、导入、删除或回收。 |
| 浏览器支持范围、per-store 归属、启动、stale-tab fence、#45 snapshot/cutover 与恢复 | [浏览器迁移与 Cutover](./0006-runtime-file-project-library/browser-migration-cutover.md) | 实现或审查 browser-to-runtime transfer、#45 或旧浏览器兼容性。 |
| #46 sanitizer、runtime preferences、platform vault、settings freeze 与恢复 | [设置与凭据库](./0006-runtime-file-project-library/settings-vault.md) | 实现或审查 settings、普通导出或凭据迁移。 |
| ownership epoch、runtime revision、授权、下游客户端和验收后果 | [验收与客户端边界](./0006-runtime-file-project-library/acceptance.md) | 实现客户端、MCP、验收测试或解释跨合同边界。 |

下游文档应链接到能回答其问题的表中条目，而不是复制任何规范性段落。若主题跨越多个文件，按表中列出的文件分别满足各自条款；没有“根 ADR 摘要”可替代其中任一验证条件。
