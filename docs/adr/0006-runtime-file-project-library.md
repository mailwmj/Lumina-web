---
status: accepted
---

# 运行时文件项目库与浏览器迁移

Lumina 的项目、画布历史和长期资产改由安装后的本地运行时管理的一份按用户隔离、文件持久化的 Lumina 项目库持有。浏览器画布、Codex 和未来的 MCP App widget 都是该项目库的客户端；它们不再各自以 IndexedDB 决定项目事实。此决定取代 ADR-0002、ADR-0005 和 Issue #33 中浏览器或 Chrome Profile 是项目事实源的条款，同时保留浏览器作为画布界面、稳定本地入口以及已有 MCP 授权规则。

## 决定

本地运行时拥有一个深模块：它在 ProjectRepository、AssetRepository 和 SettingsRepository 的既有接口之后处理文件布局、校验、并发、恢复和垃圾回收。浏览器、Codex、MCP 和未来 widget 都不得接收项目目录或任意文件路径，也不得直接读取这些文件。当前 webProjectRepository、indexedDbAssetRepository 和 indexedDbSettingsRepository 是浏览器迁移源的适配器，不是 cutover 后的第二写入端。

项目库不引入 Cowart 的 page、workspace 或调用方 projectDir 概念。它只表示现有 ProjectRecord、保留历史、AssetMetadata 和 Blob 字节所表达的 Lumina 项目事实。GenerationGateway 继续是临时受控边界，不成为项目库。

## 根目录与数据分类

运行时根据安装身份选择以下按用户管理的位置；安装 payload 本身从不成为数据根，也不因用户选择安装目录而改变项目库位置。

| 类别 | Windows | macOS | 内容与保留规则 |
| --- | --- | --- | --- |
| 安装 payload | 用户选择的安装目录 | Lumina.app 的安装目标卷 | 只有已签名 runtime 和静态资源；升级或 Repair 可以替换它。 |
| 运行时身份元数据 | %APPDATA%\Lumina\runtime\ | ~/Library/Application Support/Lumina/runtime/ | installation ID、实际 runtime 路径、注册 Origin、bridge 兼容线、项目库 ID、storage mode 和无秘密迁移报告。没有项目、资产或凭据。 |
| Lumina 项目库 | %LOCALAPPDATA%\Lumina\library\ | ~/Library/Application Support/Lumina/library/ | 项目快照、历史、资产、staging 和删除恢复数据。它是项目事实源。 |
| 非秘密偏好 | %LOCALAPPDATA%\Lumina\preferences\ | ~/Library/Application Support/Lumina/preferences/ | 版本化设置快照，排除所有秘密路径。 |
| 凭据库 | Windows Credential Manager，目标名 Lumina/<installationId>/<entryId> | Keychain，service 为 com.lumina.runtime，account 为 <installationId>/<entryId> | provider API key、外部 Agent token 和 WebDAV 凭据；不写入普通文件。 |
| Gateway 临时状态 | %LOCALAPPDATA%\Lumina\gateway\ | ~/Library/Application Support/Lumina/gateway/ | 有界任务映射和临时介质；按 Gateway 现有 TTL 清理，不是项目资产。 |
| 运行日志 | %LOCALAPPDATA%\Lumina\logs\ | ~/Library/Logs/Lumina/ | 受保留期约束的脱敏运行日志。 |

运行时身份元数据可以引用项目库 ID 和已选择的根，但项目库不依赖安装 payload 的绝对路径。普通升级、Repair 和保留数据的重装必须复用这些根。普通卸载保留项目库、非秘密偏好、凭据库和身份元数据；只有明确的“删除所有 Lumina 数据”操作才可删除它们。卸载可移除 payload、过期 Gateway 临时状态和日志，但不得把这些清理伪装成项目删除。

## 版本化项目库布局

所有 JSON 使用 UTF-8，并由 library.json 和每个快照 manifest 的 format、version 与 SHA-256 绑定。路径中的 projectId 或 assetId 是运行时生成或已验证的稳定身份，不是调用方给出的文件系统路径。

~~~text
library/
  library.json
  projects/
    <projectId>/
      head.json
      snapshots/
        <revision>/
          manifest.json
          project.json
          history.json
      recovery/
        <recoveryId>.json
        <recoveryId>-source-project.json
        <recoveryId>-source-history.json
  assets/
    <assetId>/
      metadata.json
      bytes.bin
  staging/
    <transactionId>/
      publish.json
      projects/
      assets/
  trash/
    <deletionId>/
      manifest.json
      projects/
      assets/
~~~

library.json identifies format lumina-library, version 1 and a libraryId. It contains no project bodies, settings or secrets. A project head names exactly one validated immutable snapshot and its checksum. project.json has the portable project document shape already used by .lumina exports: schemaVersion, id, name, createdAt, updatedAt, nodeCount, revision, nodes, edges and viewport. It maps the current ProjectRecord fields nodesJson, edgesJson and viewportJson to their parsed JSON values. history.json maps historyJson. The ProjectSummaryRecord fields are derived from project.json rather than duplicated in a separate index.

Asset metadata.json maps every AssetMetadata field: assetId, projectId, kind, mimeType, byteCount, createdAt, sourceKind, width, height, durationMs, sourceMetadata and lifecycleState. bytes.bin is the corresponding Blob byte sequence; the manifest records its byte count and SHA-256. Object URLs remain process-local display leases and never enter this layout.

Current credential-free stable task handles remain inside nodes and retained history, including generationJobId, generationTaskHandle, generationProviderRequestId and generationRecoveryState. A task handle may retain its validated opaque provider identity and callback shape, but project files never contain an API key, authorization header, Gateway task map, temporary media bytes or a provider response. A handle whose temporary backing state no longer exists becomes interrupted or attention-required and is never resubmitted automatically.

When a project cannot be migrated or validated, recovery records preserve the source project and history bytes, the observed schema version, and one of the existing reasons unsupported_schema or migration_failed. The runtime surfaces the corresponding ProjectRecord recovery state as read-only; export and deletion remain available. No recovery record authorizes a best-effort rewrite of unknown project data.

The .lumina archive remains the portable project format. Its versioned manifest, allowlisted paths, project/history JSON, referenced assets, metadata, byte counts and SHA-256 checks remain the interchange contract. Ordinary .lumina exports contain selected project facts only, not preferences, Credential Manager or Keychain entries, Gateway state, logs, installation metadata, or secret-bearing URLs.

## Publication, concurrency and recovery

The runtime prepares each mutation beneath staging on the same volume as the final project library. It validates project JSON, schema versions, asset byte counts, MIME and metadata, and snapshot hashes before publication. Staging assets use the existing staging lifecycle and are invisible to normal AssetRepository reads, metadata queries, Object URL hydration, deletion-candidate scans and exports.

For a project snapshot, the runtime writes and flushes every new immutable snapshot file and its manifest, then atomically publishes the revision by replacing head.json. It retains the previous validated head until the new head has been read and checksum-verified. A publish record identifies the expected previous revision, intended head, staged assets and checksums. A reader follows only a valid head and never observes a partially written project or history file.

Every mutation carries the ProjectRepository expectedRevision when the caller read one. The runtime serializes mutations per project and checks that expected revision immediately before the head swap. A mismatch returns stale_revision without writing a partial snapshot or replaying a change. Only the runtime holds the write lease; browser tabs, Codex sessions and future widgets are concurrent clients of that lease, not concurrent file writers. The ProjectRepository ownership extension may expose writer, readonly and released state, but it does not replace revision checking.

On start, the runtime validates heads and publish records before accepting writes. Incomplete staging with no committed head is discarded. A fully written snapshot with an uncommitted head remains invisible. A corrupt or missing current head is replaced by the most recent validated prior head and the affected project enters read-only recovery; it is not reconstructed from a partial file. A completed import or snapshot leaves no external transaction journal after the head and active asset set are durable.

Import stages all incoming assets first, verifies the same .lumina checksums and reference closure as the current importer, allocates deterministic conflict IDs only while holding the final publish lease, rewrites projectId and asset references, and then publishes project heads and active assets together. A failure deletes only its own staging records. It never overwrites an existing project or asset ID.

After each successful publication, reachability is computed from current heads, retained histories, active staging, recovery data and trash. Unreachable active assets first become deletion candidates. A later cleanup pass may move still-unreachable candidates to trash, but it must recheck reachability under the write lease. Deleting a project moves its last validated project snapshots and eligible assets into a deletionId trash entry instead of immediately erasing them. Restore republishes a validated snapshot; if an ID is occupied it applies deterministic restore suffixes and rewrites references like an import. Permanent removal requires a separate explicit empty-trash action.

## Browser migration and cutover

The browser-only IndexedDB implementation is transitional. Migration is a one-time, user-visible operation from the existing ProjectRepository, AssetRepository and SettingsRepository contracts; it is not a background sync mechanism.

1. Preflight acquires a maintenance lease, waits for compatible browser clients to settle their writes, and refuses migration until incompatible old tabs are closed or upgraded. The browser source is then read-only for the migration.
2. The runtime reads every ProjectRecord, retained history, referenced AssetMetadata and Blob. It stages the same structure described above and validates it with the .lumina importer/exporter rules: parseable project/history JSON, declared schema/revision, complete asset-reference closure, matching byte counts and SHA-256.
3. Non-secret settings migrate into the versioned preferences snapshot. The exact SETTINGS_SECRET_PATHS values are excluded: openAiImageApi.apiKey, chaomoImageApi.apiKey, additionalImageApis.*.apiKey, customImageApis.*.apiKey, textApis.*.apiKey, videoApis.*.apiKey, externalAgentConnection.token, webDav.username and webDav.password. A user may explicitly approve a one-time transfer of those values into the platform credential vault; declining it leaves the new runtime without those credentials and requires re-entry. Secret values never appear in staging, reports, project files, ordinary exports or logs.
4. The runtime creates a migration report under the runtime identity metadata. It records migration ID, source and target format versions, project IDs and revisions, asset counts and hashes, settings-redaction result, validation result, timestamps and the first file-library head. It contains no raw project media or secret values.
5. Only after all staged data and the migration report validate does the runtime atomically mark storageMode as runtime-file-library and attach clients to the file adapters. The IndexedDB source becomes frozen recovery input and has no normal writer. If the process restarts during cutover, the durable cutover record determines one mode before any client is attached.

Before the durable cutover mark, failure removes only the staged file-library candidate and leaves IndexedDB as the sole writer. After cutover but before the first file-library mutation, an explicit rollback may reactivate the unchanged IndexedDB source after validating the migration report and source fingerprint; it first disables file-library writes. After any post-cutover file-library mutation, automatic rollback is forbidden because IndexedDB is stale. Recovery must use the last validated file snapshot or a verified .lumina export, never silently revive a second writer.

Migration acceptance evidence compares project IDs, names, timestamps, node counts, schema versions, revisions, canonical project/history hashes, asset metadata and byte hashes, recovery state, and every retained credential-free task handle. It records an intentional interrupted result when a task handle cannot safely resume. A passing migration proves there was one cutover and no dual-writer interval; it does not prove a public release, installer signature or widget implementation.

## Authorization and downstream clients

Changing data location does not relax MCP controls. The bridge resolves project data through the runtime interfaces and does not receive raw filesystem access. Opening or reconnecting remains read-only; write, import and run authorization remain separate explicit grants. Every change set carries projectId and expected revision, stale revisions are rejected before publication, and disconnect, timeout, token rotation, runtime restart and repair never replay a mutation or billable generation.

An MCP App widget is a downstream proof of concept. It may render a client of this runtime-owned project library only after its own host, authorization and lifecycle questions are tested. It is neither a prerequisite for this migration nor an alternative storage owner.

## Consequences

Browser IndexedDB and its browser-only tests remain supported migration behavior until the runtime adapters ship, but new product work must not add browser-owned source-of-truth assumptions. Upgrade, Repair, reinstall and ordinary uninstall acceptance must prove the managed library, preferences and credential vault preservation independently of a Chrome profile or registered Origin. The stable Origin remains an entry, bridge and compatibility concern; it no longer selects the project library.

This ADR specifies the durable architecture only. It does not implement the filesystem module, browser or HTTP adapters, IndexedDB migration, settings vault, installer changes, or MCP App widget.
