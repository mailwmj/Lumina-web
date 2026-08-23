---
status: accepted
---

# 运行时文件项目库与浏览器迁移

> **实施状态（2026-08-23）**：这是已接受的目标架构，不是当前已交付的存储实现。当前仓库仍由固定 Origin 的浏览器 IndexedDB 适配器持有项目、历史、资产和设置；运行时文件项目库、文件适配器、一次迁移和凭据库要在 #43-#45 交付后才会成为实际数据路径。本文中“迁移源”“cutover”和“运行时客户端”描述该目标交付的行为，不能倒推为当前代码已经切换。

Lumina 已接受的目标是：项目、画布历史和长期资产由安装后的本地运行时管理的一份按用户隔离、文件持久化的 Lumina 项目库持有。届时浏览器画布、Codex 和未来的 MCP App widget 都是该项目库的客户端；它们不再各自以 IndexedDB 决定项目事实。该目标取代 ADR-0002、ADR-0005 和 Issue #33 中浏览器或 Chrome Profile 是长期项目事实源的决策，同时保留浏览器作为画布界面、稳定本地入口以及已有 MCP 授权规则。

## 决定

目标本地运行时拥有一个深模块：它在 ProjectRepository、AssetRepository 和 SettingsRepository 的既有接口之后处理文件布局、校验、并发、恢复和垃圾回收。浏览器、Codex、MCP 和未来 widget 都不得接收项目目录或任意文件路径，也不得直接读取这些文件。当前 `webProjectRepository`、`indexedDbAssetRepository` 和 `indexedDbSettingsRepository` 仍是唯一已实现的浏览器数据路径；它们在目标 cutover 时才会成为被冻结的迁移输入，而不是第二写入端。

项目库不引入 Cowart 的 page、workspace 或调用方 projectDir 概念。它只表示现有 ProjectRecord、保留历史、AssetMetadata 和 Blob 字节所表达的 Lumina 项目事实。GenerationGateway 继续是临时受控边界，不成为项目库。

## 根目录与数据分类

目标运行时将根据安装身份选择以下按用户管理的位置；安装 payload 本身从不成为数据根，也不因用户选择安装目录而改变项目库位置。这些根是 #43-#45 的交付契约，不表示当前安装包已经创建它们。

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
  head.json
  commits/
    <commitId>.json
  projects/
    <projectId>/
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

library.json identifies format lumina-library, version 1 and a libraryId. It contains no project bodies, settings or secrets. `head.json` is the only visibility pointer: it names exactly one immutable `commits/<commitId>.json`, that commit's SHA-256, and its previous commit ID. A commit is a complete catalog, not a delta: it contains the sorted visible `projectId -> snapshot manifest/revision/SHA-256` map and the sorted visible `assetId -> metadata path/byte path/byteCount/SHA-256` map. Readers pin one valid library head before resolving any project, history or asset; they never discover live facts by scanning `projects/`, `assets/` or `staging/`.

The v1 pointer and catalog have these required fields; the project and asset arrays contain every visible ID, not only IDs changed by the transaction:

~~~json
{
  "format": "lumina-library-head",
  "version": 1,
  "commitId": "<commit id>",
  "commitSha256": "<catalog SHA-256>",
  "previousCommitId": "<commit id or null>"
}
~~~

~~~json
{
  "format": "lumina-library-commit",
  "version": 1,
  "commitId": "<commit id>",
  "previousCommitId": "<commit id or null>",
  "sequence": 0,
  "projects": [
    { "projectId": "<id>", "revision": "<revision>", "manifestPath": "<path>", "manifestSha256": "<hash>" }
  ],
  "assets": [
    { "assetId": "<id>", "metadataPath": "<path>", "bytesPath": "<path>", "byteCount": 0, "bytesSha256": "<hash>" }
  ]
}
~~~

project.json has the portable project document shape already used by .lumina exports: schemaVersion, id, name, createdAt, updatedAt, nodeCount, revision, nodes, edges and viewport. It maps the current ProjectRecord fields nodesJson, edgesJson and viewportJson to their parsed JSON values. history.json maps historyJson. The snapshot manifest records `recovery` as either the current ProjectRecovery value or null and points to any preserved recovery files. The ProjectSummaryRecord fields are derived from project.json rather than duplicated in a separate index.

Asset metadata.json maps every AssetMetadata field: assetId, projectId, kind, mimeType, byteCount, createdAt, sourceKind, width, height, durationMs, sourceMetadata and lifecycleState. bytes.bin is the corresponding Blob byte sequence; the manifest records its byte count and SHA-256. Object URLs remain process-local display leases and never enter this layout.

Current credential-free stable task handles remain inside nodes and retained history, including generationJobId, generationTaskHandle, generationProviderRequestId and generationRecoveryState. A task handle may retain its validated opaque provider identity and callback shape, but project files never contain an API key, authorization header, Gateway task map, temporary media bytes or a provider response. A handle whose temporary backing state no longer exists becomes interrupted or attention-required and is never resubmitted automatically.

When a project cannot be migrated or validated, recovery records preserve the source project and history bytes, the observed schema version, and one of the existing reasons unsupported_schema or migration_failed. The runtime surfaces the corresponding ProjectRecord recovery state as read-only; export and deletion remain available. No recovery record authorizes a best-effort rewrite of unknown project data.

The .lumina archive remains the portable project format. Its versioned manifest, allowlisted paths, project/history JSON, referenced assets, metadata, byte counts and SHA-256 checks remain the interchange contract. Ordinary .lumina exports contain selected project facts only, not preferences, Credential Manager or Keychain entries, Gateway state, logs, installation metadata, or secret-bearing URLs.

## Publication, concurrency and recovery

The following is the target runtime publication contract. It uses one library-level commit for every mutation, including a single-project save, a viewport update, deletion and a multi-project .lumina import. The runtime prepares data beneath staging on the same volume as the final project library. It validates project JSON, schema versions, asset byte counts, MIME and metadata, and snapshot hashes before publication. Staging assets use the existing staging lifecycle and are invisible to normal AssetRepository reads, metadata queries, Object URL hydration, deletion-candidate scans and exports.

Each `staging/<transactionId>/publish.json` is an immutable record with `format: "lumina-library-publish"`, `version: 1`, transaction ID, expected previous library commit ID, affected project expected revisions, new payload paths and checksums, intended full catalog commit ID and its SHA-256. The commit catalog has a monotonic library sequence and no duplicate project or asset IDs; both maps are ordered by the UTF-8 byte order of their stable IDs. The head and commit SHA-256 values use the canonical JSON and digest rules defined in the migration evidence section below.

The runtime holds its library write lease for final validation and publication, then performs this exact order:

1. Read and validate the current library head. Recheck each affected project's expected revision against that head; an import requires either `absent` for a new ID or the exact revision for a replacement permitted by its import policy. A mismatch returns `stale_revision` before the visible catalog changes.
2. Flush all transaction payloads, project snapshots, asset metadata/bytes and the complete immutable catalog under staging. Verify every listed checksum and reference closure.
3. Materialize the verified immutable payloads and `commits/<commitId>.json` at their final paths, flush their containing directories, and leave them unreachable from readers.
4. Atomically replace the single root `library/head.json` with the new head pointer. That replacement is the only visibility event. It names the new commit and the previous commit ID; no per-project head is written or consulted.
5. After the new head has been reread and its complete catalog verified, discard only the transaction's staging control files. The immutable payloads remain reachable through the new catalog.

A reader sees either the prior full catalog or the new full catalog, never a mix. An import therefore cannot expose some imported projects or assets while hiding others, even when it contains many projects. The runtime may prepare work in parallel, but final catalog publication is serialized by the library lease.

The current ProjectRepository does not yet provide this all-mutation guarantee: `expectedRevision` exists only in `saveSnapshot` options; `updateViewport`, `rename` and `delete` have no expected-revision parameter. #43-#45 must add a target runtime command/RPC seam, separate from that legacy compatibility interface:

~~~ts
type ExpectedProjectRevision = string | 'absent';

type RuntimeProjectMutation =
  | { kind: 'saveSnapshot'; record: ProjectRecord }
  | { kind: 'updateViewport'; viewportJson: string }
  | { kind: 'rename'; name: string; updatedAt: number }
  | { kind: 'delete' };

applyProjectMutation({ projectId, expectedRevision, mutation }):
  Promise<
    | { code: 'applied'; revision: string }
    | { code: 'deleted' }
    | { code: 'stale_revision' }
  >;
~~~

The target file adapter routes every mutation through this command. Every non-delete success writes a next project revision into the next catalog; `delete` checks the revision before removing the project from that catalog. `updateViewport` and `rename` receive the same check rather than inheriting `saveSnapshot` semantics by implication. Multi-project import supplies one expected state per affected existing project and `absent` for each newly allocated ID. Existing browser-only convenience methods remain current compatibility behavior until those adapters land; they are not evidence of a runtime-wide stale-revision contract.

At startup, the runtime acquires maintenance access and applies this deterministic recovery algorithm before accepting writes:

1. If `library/head.json` and its named catalog validate, that catalog is the only visible state. A staging transaction whose intended commit ID equals the head is complete; its remaining staging control files are removed.
2. A staging transaction whose intended commit ID is not the head was never published. Its staging files are removed, and only materialized payloads named by that transaction that are unreachable from the visible catalog, retained commits, recovery data or trash are removed as transaction orphans. They are never promoted by scanning.
3. If the head pointer itself is valid but its named catalog or payload checks fail, the runtime validates the pointer's `previousCommitId`. If it is valid, the runtime atomically restores that complete prior head, records read-only recovery for the failed transaction, and blocks further writes until the recovery is acknowledged. It never selects individual project snapshots from the failed import.
4. If the root head is missing or cannot be parsed, the runtime does not guess from commit files or per-project directories. It enters read-only recovery and requires an explicit verified .lumina restore or operator repair.

Normal crash recovery therefore has two observable outcomes: the old head remains visible and the uncommitted transaction is discarded, or the new head remains visible and the complete transaction is retained. A test must inject a crash before and after each numbered publication step and observe one of those outcomes. There is no partial-import state to repair.

After each successful publication, reachability is computed from the visible full catalog, retained commits, active staging, recovery data and trash. Unreachable active assets first become deletion candidates. A later cleanup pass may move still-unreachable candidates to trash, but it must recheck reachability under the write lease. Deleting a project first writes its last validated project snapshots and eligible assets to a `deletionId` trash entry, then removes their references in the next complete catalog. Restore republishes a validated snapshot; if an ID is occupied it applies deterministic restore suffixes and rewrites references like an import. Permanent removal requires a separate explicit empty-trash action.

## Browser migration and cutover

The browser-only IndexedDB implementation is the current durable implementation and is transitional only relative to this accepted target. Migration is a future one-time, user-visible operation from the existing ProjectRepository, AssetRepository and SettingsRepository contracts; it is not a background sync mechanism.

1. Preflight acquires a maintenance lease, waits for compatible browser clients to settle their writes, and refuses migration until incompatible old tabs are closed or upgraded. The browser source is then read-only for the migration.
2. The runtime reads every ProjectRecord, retained history, referenced AssetMetadata and Blob. It stages the same structure described above and validates it with the .lumina importer/exporter rules: parseable project/history JSON, declared schema/revision, complete asset-reference closure, matching byte counts and SHA-256.
3. Non-secret settings migrate into the versioned preferences snapshot. The exact SETTINGS_SECRET_PATHS values are excluded: openAiImageApi.apiKey, chaomoImageApi.apiKey, additionalImageApis.*.apiKey, customImageApis.*.apiKey, textApis.*.apiKey, videoApis.*.apiKey, externalAgentConnection.token, webDav.username and webDav.password. A user may explicitly approve a one-time transfer of those values into the platform credential vault; declining it leaves the new runtime without those credentials and requires re-entry. Secret values never appear in staging, reports, project files, ordinary exports or logs.
4. The runtime creates the versioned migration report described below under runtime identity metadata, validates it against the staged catalog, and stores the report before cutover. It contains no raw project media or secret values.
5. Only after all staged data, the complete library commit and the migration report validate does the runtime atomically mark storageMode as runtime-file-library and attach clients to the file adapters. The IndexedDB source becomes frozen recovery input and has no normal writer. If the process restarts during cutover, the durable cutover record determines one mode before any client is attached.

### Canonical migration evidence and rollback

All migration hashes use `RFC8785-JCS-SHA256-v1`: parse the logical JSON value, reject duplicate object member names, non-finite numbers and values RFC 8785 cannot serialize, serialize it with RFC 8785 JSON Canonicalization Scheme, UTF-8 encode the result, then calculate SHA-256 as lowercase hexadecimal. Hashes never use the original JSON string bytes or host object-key order.

For each ProjectRecord, the project hash is the hash of this exact normalized value, where missing `schemaVersion` is `1`, missing `revision` is `"r0"`, and missing `recovery` is `null`:

~~~ts
const projectCanonicalValue = {
  format: 'lumina-migration-project-v1',
  project: {
    schemaVersion: record.schemaVersion ?? 1,
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
    revision: record.revision ?? 'r0',
    recovery: record.recovery ?? null,
    nodes: JSON.parse(record.nodesJson),
    edges: JSON.parse(record.edgesJson),
    viewport: JSON.parse(record.viewportJson),
  },
};
~~~

The history hash is the hash of `{ format: 'lumina-migration-history-v1', history: JSON.parse(record.historyJson) }`. The asset metadata hash is the hash of this exact object; the asset byte hash is SHA-256 of the raw Blob byte sequence:

~~~ts
const assetMetadataCanonicalValue = {
  format: 'lumina-migration-asset-metadata-v1',
  metadata: {
    assetId: metadata.assetId,
    projectId: metadata.projectId,
    kind: metadata.kind,
    mimeType: metadata.mimeType,
    byteCount: metadata.byteCount,
    createdAt: metadata.createdAt,
    sourceKind: metadata.sourceKind,
    width: metadata.width,
    height: metadata.height,
    durationMs: metadata.durationMs,
    sourceMetadata: metadata.sourceMetadata,
    lifecycleState: metadata.lifecycleState,
  },
};
~~~

The non-secret settings hash is the hash of `{ format: 'lumina-migration-settings-v1', settings: <credential-free SettingsExport.settings>, version: <SettingsExport.version> }`, after exactly the SETTINGS_SECRET_PATHS redaction in this ADR. No secret value, secret-presence flag or secret-derived hash participates in any migration hash.

Preflight first cleans incomplete IndexedDB import staging and then captures every active or deletion-candidate AssetMetadata record whose projectId is being migrated, plus every asset ID recursively referenced from parsed nodes or retained history by the current .lumina exporter rules (`assetId`, `previewAssetId` and `lastFrameAssetId`). A referenced ID without complete metadata and bytes fails validation. Project IDs, asset IDs and each project's asset ID list are sorted by UTF-8 byte order before hashing.

The source fingerprint is the SHA-256 of the RFC 8785 canonical form of this exact manifest:

~~~json
{
  "format": "lumina-indexeddb-source-fingerprint",
  "version": 1,
  "canonicalization": "RFC8785-JCS-SHA256-v1",
  "projects": [
    { "id": "<projectId>", "revision": "<normalized revision>", "projectSha256": "<hash>", "historySha256": "<hash>", "recovery": null, "assetIds": ["<assetId>"] }
  ],
  "assets": [
    { "assetId": "<assetId>", "projectId": "<projectId>", "metadataSha256": "<hash>", "bytesSha256": "<hash>", "byteCount": 0, "lifecycleState": "active" }
  ],
  "settings": {
    "version": 0,
    "sha256": "<credential-free settings hash>",
    "excludedSecretPaths": ["openAiImageApi.apiKey", "chaomoImageApi.apiKey", "additionalImageApis.*.apiKey", "customImageApis.*.apiKey", "textApis.*.apiKey", "videoApis.*.apiKey", "externalAgentConnection.token", "webDav.username", "webDav.password"],
    "redactionVerified": true,
    "credentialTransfer": "approved|declined|not-requested"
  }
}
~~~

`projects` and `assets` contain the complete sorted capture, not samples or aggregate counts. The migration report must persist that manifest's fields and the following values so a later implementation can evaluate rollback mechanically:

~~~json
{
  "format": "lumina-indexeddb-migration-report",
  "version": 1,
  "canonicalization": "RFC8785-JCS-SHA256-v1",
  "migrationId": "<stable id>",
  "source": {
    "adapter": "lumina-web-indexeddb",
    "databaseSchemaVersion": 0,
    "capturedAt": 0,
    "fingerprint": "<source manifest SHA-256>",
    "projects": [
      { "id": "<projectId>", "revision": "<normalized revision>", "projectSha256": "<hash>", "historySha256": "<hash>", "recovery": null, "assetIds": ["<assetId>"] }
    ],
    "assets": [
      { "assetId": "<assetId>", "projectId": "<projectId>", "metadataSha256": "<hash>", "bytesSha256": "<hash>", "byteCount": 0, "lifecycleState": "active" }
    ],
    "settings": {
      "version": 0,
      "sha256": "<credential-free settings hash>",
      "excludedSecretPaths": ["openAiImageApi.apiKey", "chaomoImageApi.apiKey", "additionalImageApis.*.apiKey", "customImageApis.*.apiKey", "textApis.*.apiKey", "videoApis.*.apiKey", "externalAgentConnection.token", "webDav.username", "webDav.password"],
      "redactionVerified": true,
      "credentialTransfer": "approved|declined|not-requested"
    }
  },
  "target": {
    "libraryId": "<library id>",
    "libraryFormatVersion": 1,
    "initialCommitId": "<commit id>",
    "initialCommitSha256": "<catalog SHA-256>",
    "initialHeadSha256": "<head SHA-256>"
  },
  "validation": {
    "sourceFingerprintVerified": true,
    "targetCatalogVerified": true,
    "assetReferenceClosureVerified": true,
    "settingsRedactionVerified": true
  },
  "cutover": { "storageModeEpoch": 0, "completedAt": 0 }
}
~~~

Before cutover, the runtime recomputes the source fingerprint with this same versioned algorithm and requires it to equal `source.fingerprint`; it also verifies the staged catalog against every report entry and writes the four `validation` values only after those checks pass. An explicit rollback is eligible only before any post-cutover target mutation, meaning all of the following are true under the maintenance lease: the report validates, runtime identity still names its `initialCommitId`, the current library head and hashes equal all three `target` values, and a fresh v1 source-fingerprint computation against the frozen IndexedDB source exactly equals `source.fingerprint`. The runtime first disables file-library writes, then atomically switches storageMode back to IndexedDB and reattaches clients. Any failed comparison refuses rollback without attaching a second writer. The first library head that differs from `initialCommitId` is a post-cutover mutation; from that point automatic and explicit rollback to IndexedDB are forbidden because it is stale.

Before the durable cutover mark, failure removes only the staged file-library candidate and leaves IndexedDB as the sole writer. After any post-cutover file-library mutation, recovery must use the last validated file snapshot or a verified .lumina export, never silently revive a second writer.

Migration acceptance evidence compares project IDs, names, timestamps, node counts, schema versions, revisions, canonical project/history hashes, asset metadata and byte hashes, recovery state, and every retained credential-free task handle. It records an intentional interrupted result when a task handle cannot safely resume. A passing migration proves there was one cutover and no dual-writer interval; it does not prove a public release, installer signature or widget implementation.

## Authorization and downstream clients

Changing data location does not relax MCP controls. The current bridge keeps its existing browser-backed authorization behavior until #43-#45 land. In the target runtime, the bridge resolves project data through the command/interface seam above and does not receive raw filesystem access. Opening or reconnecting remains read-only; write, import and run authorization remain separate explicit grants. MCP change sets must carry projectId and an expected revision and must call `applyProjectMutation`, not the legacy revisionless convenience methods. A stale revision is rejected before library-head publication, and disconnect, timeout, token rotation, runtime restart and repair never replay a mutation or billable generation.

An MCP App widget is a downstream proof of concept. It may render a client of this runtime-owned project library only after its own host, authorization and lifecycle questions are tested. It is neither a prerequisite for this migration nor an alternative storage owner.

## Consequences

Today, browser IndexedDB and its browser-only tests remain the current durable behavior at the registered Origin. They are a supported migration source only after #43-#45 ship the target adapters and cutover; new work must not claim that cutover has already happened. Once the target ships, upgrade, Repair, reinstall and ordinary uninstall acceptance must prove the managed library, preferences and credential vault preservation independently of a Chrome profile or registered Origin. The stable Origin remains an entry, bridge and compatibility concern; it does not select the target project library.

This ADR specifies the durable architecture only. It does not implement the filesystem module, browser or HTTP adapters, IndexedDB migration, settings vault, installer changes, or MCP App widget.
