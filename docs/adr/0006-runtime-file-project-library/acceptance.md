---
status: accepted
parent: ../0006-runtime-file-project-library.md
---

# 运行时文件项目库：验收与客户端边界

> **权威范围**：ownership epoch 与 runtime revision 的区分、授权、下游客户端和后果 本文中的规范性条款是 ADR-0006 对该主题的唯一权威来源；根 ADR 只保留决定、状态、历史和导航索引。

## Ownership epoch and runtime revision fencing

`storageModeEpoch` fences browser-store ownership and stale tabs; it is not a project or catalog revision. A #45 client coordinates the ownership epoch with the runtime before attaching file adapters, but every project mutation still carries its independent expected project revision and `CatalogRevision` through `applyProjectMutation` or `applyLibraryTransaction`. An epoch mismatch requires adapter teardown and ownership recheck; a stale project or catalog revision rejects the requested runtime mutation before library-head publication. Conversely, the #46 settings epoch transition does not change a project revision or authorize a project mutation. The two fences are therefore coordinated at client attachment and recovery, but neither substitutes for the other.

## Authorization and downstream clients

Changing data location does not relax MCP controls. The current bridge keeps its existing browser-backed authorization behavior until #43-#45 land. #45 changes only project/history/asset ownership; settings remain browser-live until #46 and are not exposed to MCP in either stage. In the target runtime, the bridge resolves project data through the command/interface seam above and does not receive raw filesystem access. Opening or reconnecting remains read-only; write, import and run authorization remain separate explicit grants. MCP change sets must carry projectId and an expected revision and call `applyProjectMutation`; an authorized `.lumina` import calls `applyLibraryTransaction` with its expected catalog revision and one persisted operation ID. On reconnect it calls `reconcileLibraryTransaction`, never a blind import retry. Neither calls the legacy revisionless convenience methods. A stale revision or catalog is rejected before library-head publication, and disconnect, timeout, token rotation, runtime restart and repair never replay a mutation or billable generation.

An MCP App widget is a downstream proof of concept. It may render a client of this runtime-owned project library only after its own host, authorization and lifecycle questions are tested. It is neither a prerequisite for this migration nor an alternative storage owner.

## Consequences

Today, browser IndexedDB and its browser-only tests remain the current durable behavior at the registered Origin. When #43-#45 implement migration, only `projects`, `history`, and `assets` are read sources before the #45 cutover and then freeze as recovery evidence; the browser settings record remains live. #46 separately migrates non-secret preferences and provider credentials/tokens before freezing `settings`. New work must not claim that either cutover has already happened. Once the target ships, upgrade, Repair, reinstall and ordinary uninstall acceptance must prove the managed library, preferences and credential vault preservation independently of a Chrome profile or registered Origin. The stable Origin remains an entry, bridge and compatibility concern; it does not select the target project library.

This ADR specifies the durable architecture only. It does not implement the filesystem module, browser or HTTP adapters, IndexedDB migration, settings vault, installer changes, or MCP App widget.
