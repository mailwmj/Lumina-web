---
status: accepted
---

# 运行时文件项目库与浏览器迁移

> **实施状态（2026-08-23）**：这是已接受的目标架构，不是当前已交付的存储实现。当前仓库仍由固定 Origin 的浏览器 IndexedDB 适配器持有项目、历史、资产和设置。#45 的未来 cutover 只会把项目、历史和资产交给运行时文件项目库；浏览器 settings（包括混合记录）会继续写入，直到 #46 把非秘密偏好和凭据/token 分离到各自目标并冻结 settings store。本文中“迁移源”“cutover”和“运行时客户端”描述该目标交付的行为，不能倒推为当前代码已经切换。

Lumina 已接受的目标是：项目、画布历史和长期资产由安装后的本地运行时管理的一份按用户隔离、文件持久化的 Lumina 项目库持有。届时浏览器画布、Codex 和未来的 MCP App widget 都是该项目库的客户端；它们不再各自以 IndexedDB 决定项目事实。该目标取代 ADR-0002、ADR-0005 和 Issue #33 中浏览器或 Chrome Profile 是长期项目事实源的决策，同时保留浏览器作为画布界面、稳定本地入口以及已有 MCP 授权规则。

## 决定

目标本地运行时拥有一个深模块：它在 ProjectRepository 和 AssetRepository 的既有接口之后处理文件布局、校验、并发、恢复和垃圾回收，并在 #46 后承接 SettingsRepository 的目标偏好/凭据边界。浏览器、Codex、MCP 和未来 widget 都不得接收项目目录或任意文件路径，也不得直接读取这些文件。当前 `webProjectRepository`、`indexedDbAssetRepository` 和 `indexedDbSettingsRepository` 仍是唯一已实现的浏览器数据路径；#45 只把前两类的项目、历史和资产 stores 变成冻结迁移输入，#46 才冻结 settings，而不是形成第二写入端。

项目库不引入 Cowart 的 page、workspace 或调用方 projectDir 概念。它只表示现有 ProjectRecord、保留历史、AssetMetadata 和 Blob 字节所表达的 Lumina 项目事实。GenerationGateway 继续是临时受控边界，不成为项目库。

## 根目录与数据分类

目标运行时将根据安装身份选择以下按用户管理的位置；安装 payload 本身从不成为数据根，也不因用户选择安装目录而改变项目库位置。这些根是 #43-#46 的交付契约，不表示当前安装包已经创建它们。

| 类别 | Windows | macOS | 内容与保留规则 |
| --- | --- | --- | --- |
| 安装 payload | 用户选择的安装目录 | Lumina.app 的安装目标卷 | 只有已签名 runtime 和静态资源；升级或 Repair 可以替换它。 |
| 运行时身份元数据 | %APPDATA%\Lumina\runtime\ | ~/Library/Application Support/Lumina/runtime/ | installation ID、实际 runtime 路径、注册 Origin、bridge 兼容线、项目库 ID、每 store 归属与 `storageModeEpoch`，以及无秘密迁移报告。没有项目、资产或凭据。 |
| Lumina 项目库 | %LOCALAPPDATA%\Lumina\library\ | ~/Library/Application Support/Lumina/library/ | 项目快照、历史、资产、staging 和删除恢复数据。它是项目事实源。 |
| 非秘密偏好 | %LOCALAPPDATA%\Lumina\preferences\ | ~/Library/Application Support/Lumina/preferences/ | 版本化设置快照，排除所有秘密路径。 |
| 凭据库 | Windows Credential Manager，目标名 Lumina/<installationId>/<entryId> | Keychain，service 为 com.lumina.runtime，account 为 <installationId>/<entryId> | provider API key、外部 Agent token 和 WebDAV 凭据；不写入普通文件。 |
| Gateway 临时状态 | %LOCALAPPDATA%\Lumina\gateway\ | ~/Library/Application Support/Lumina/gateway/ | 有界任务映射和临时介质；按 Gateway 现有 TTL 清理，不是项目资产。 |
| 运行日志 | %LOCALAPPDATA%\Lumina\logs\ | ~/Library/Logs/Lumina/ | 受保留期约束的脱敏运行日志。 |

运行时身份元数据可以引用项目库 ID 和已选择的根，但项目库不依赖安装 payload 的绝对路径。普通升级、Repair 和保留数据的重装必须复用这些根。普通卸载保留项目库、非秘密偏好、凭据库和身份元数据；只有明确的“删除所有 Lumina 数据”操作才可删除它们。卸载可移除 payload、过期 Gateway 临时状态和日志，但不得把这些清理伪装成项目删除。

## 版本化项目库布局

所有 JSON 使用 UTF-8，并由 library.json 和每个快照 manifest 的 format、version 与 SHA-256 绑定。逻辑 `projectId`、`assetId`、archive entry path、project name、revision 和所有客户端输入都不是文件系统路径，绝不传给路径构造函数。

每一个物理路径段使用运行时生成的 `LibraryKey`，而不是逻辑 ID。v1 key 由 CSPRNG 生成 128 bit，写入前在库写 lease 下检查唯一性，并严格匹配 `^[pasctrd]_[0-9a-f]{32}$`：`p` project、`a` asset、`s` snapshot、`c` commit、`t` transaction、`r` recovery、`d` deletion。读取磁盘时先以 strict UTF-8 解码并验证该语法，再构造路径；因此非 ASCII、无效 UTF-8 或 Unicode 规范化变化、`.`/`..`、`/`、`\\`、绝对路径、盘符、UNC、冒号和 Windows 保留名都不能成为路径段。该 ASCII 语法也使 NFC/NFD 在 macOS 上没有等价但不同的 key。

Catalog 的 `projectKey`、`snapshotKey`、`assetKey` 和所有 control-record ID 必须通过该验证；`manifestPath`、`metadataPath` 和 `bytesPath` 由这些 key 按下述固定模板生成，读取时必须与生成结果完全相等。实现还必须在 canonical managed root 下解析生成路径、拒绝路径上的 symlink、junction 或 reparse point，并在创建前后验证结果仍在该 root 内。不存在 `join(root, projectId)`、archive path 或任何调用方字符串的合法实现。

~~~text
library/
  library.json
  head.json
  commits/
    <commitId>.json
  projects/
    <projectKey>/
      snapshots/
        <snapshotKey>/
          manifest.json
          project.json
          history.json
      recovery/
        <recoveryId>.json
        <recoveryId>-source-project.json
        <recoveryId>-source-history.json
  assets/
    <assetKey>/
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

library.json identifies format lumina-library, version 1 and a libraryId. It contains no project bodies, settings or secrets. `head.json` is the only visibility pointer: it names exactly one immutable `commits/<commitId>.json`, that commit's SHA-256, and its previous commit ID. A commit is a complete catalog, not a delta: it contains the sorted visible `projectId -> projectKey/snapshot manifest/revision/SHA-256` map, the sorted visible `assetId -> assetKey/metadata path/byte path/byteCount/SHA-256` map, and the bounded, unexpired import-reconciliation receipts described below. Readers pin one valid library head before resolving any project, history or asset; they never discover live facts by scanning `projects/`, `assets/` or `staging/`.

The v1 pointer and catalog have these required fields; the project and asset arrays contain every visible ID, not only IDs changed by the transaction. Angle-bracket values below are illustrative placeholders; `version: 1` is normative.

~~~json
{
  "format": "lumina-library-head",
  "version": 1,
  "commitId": "<runtime c_ key>",
  "commitSha256": "<catalog SHA-256>",
  "previousCommitId": "<runtime c_ key or null>"
}
~~~

~~~json
{
  "format": "lumina-library-commit",
  "version": 1,
  "commitId": "<runtime c_ key>",
  "previousCommitId": "<runtime c_ key or null>",
  "sequence": "<next monotonic safe integer>",
  "projects": [
    { "projectId": "<logical ProjectRecord.id>", "projectKey": "<runtime p_ key>", "snapshotKey": "<runtime s_ key>", "revision": "<logical revision>", "manifestPath": "projects/<p_ key>/snapshots/<s_ key>/manifest.json", "manifestSha256": "<hash>" }
  ],
  "assets": [
    { "assetId": "<logical AssetMetadata.assetId>", "assetKey": "<runtime a_ key>", "metadataPath": "assets/<a_ key>/metadata.json", "bytesPath": "assets/<a_ key>/bytes.bin", "byteCount": "<safe integer>", "bytesSha256": "<hash>" }
  ],
  "completedImports": [
    {
      "operationId": "<client-generated lowercase UUID v4>",
      "requestSha256": "<SHA-256 of the versioned import request fingerprint>",
      "publishedCommitId": "<runtime c_ key>",
      "publishedSequence": "<safe integer>",
      "publishedAt": "<Unix epoch milliseconds>",
      "retainedUntil": "<publishedAt plus 30 days>",
      "projects": [
        { "sourceProjectId": "<archive project ID>", "targetProjectId": "<allocated project ID>", "revision": "<target revision>" }
      ],
      "assets": [
        { "sourceAssetId": "<archive asset ID>", "targetAssetId": "<allocated asset ID>", "sourceProjectId": "<archive owner ID>", "targetProjectId": "<allocated owner ID>" }
      ]
    }
  ]
}
~~~

project.json has the portable project document shape already used by .lumina exports: schemaVersion, id, name, createdAt, updatedAt, nodeCount, revision, nodes, edges and viewport. It maps the current ProjectRecord fields nodesJson, edgesJson and viewportJson to their parsed JSON values. history.json maps historyJson. The snapshot manifest records `recovery` as either the current ProjectRecovery value or null and points to any preserved recovery files. The ProjectSummaryRecord fields are derived from project.json rather than duplicated in a separate index.

Asset metadata.json maps every AssetMetadata field: assetId, projectId, kind, mimeType, byteCount, createdAt, sourceKind, width, height, durationMs, sourceMetadata and lifecycleState. bytes.bin is the corresponding Blob byte sequence; the manifest records its byte count and SHA-256. Object URLs remain process-local display leases and never enter this layout.

Current credential-free stable task handles remain inside nodes and retained history, including generationJobId, generationTaskHandle, generationProviderRequestId and generationRecoveryState. A task handle may retain its validated opaque provider identity and callback shape, but project files never contain an API key, authorization header, Gateway task map, temporary media bytes or a provider response. A handle whose temporary backing state no longer exists becomes interrupted or attention-required and is never resubmitted automatically.

When a project cannot be migrated or validated, recovery records preserve the source project and history bytes, the observed schema version, and one of the existing reasons unsupported_schema or migration_failed. The runtime surfaces the corresponding ProjectRecord recovery state as read-only; export and deletion remain available. No recovery record authorizes a best-effort rewrite of unknown project data.

The .lumina archive remains the portable project format. Its versioned manifest, allowlisted paths, project/history JSON, referenced assets, metadata, byte counts and SHA-256 checks remain the interchange contract. Current `src/features/assets/application/luminaProjectExport.ts` removes named sensitive fields and gateway-like URL values, but it does **not** implement the complete `lumina-settings-credential-free-v1` URL rule. In particular, it is not current evidence that ordinary archives remove arbitrary URL userinfo, fragments, or `api_key`/`key` query values. Current ordinary exports therefore exclude preferences, Credential Manager or Keychain entries, Gateway state, logs and installation metadata, but must not be described as already proving full secret-bearing URL exclusion.

#46 must make the target ordinary-export path apply the same versioned `lumina-settings-credential-free-v1` sanitizer to every serializable `baseUrl` or `url` property in project JSON, retained history and asset source metadata before archive hashes are calculated. The target rejects an unparseable such value with `ordinary_export_sanitization_failed` and emits no archive; it never falls back to serializing the original string. Its acceptance fixtures must put userinfo, fragments, duplicate mixed-case `api_key`, `apikey`, `key`, `token`, `access_token`, `password` and `secret` query parameters in those fields, then decode every archive entry and assert that only the v1-sanitized URLs remain. A malformed `baseUrl` or `url` fixture must fail closed, and the resulting archive bytes, manifest hashes and error/report payloads must contain no source secret.

### Path-key verification

#43-#45 must test the path-key interface before any filesystem adapter is accepted. The tests construct paths only through the key validator and managed-root resolver, never through a test-only unsafe join.

- On Windows and macOS, valid `p_`, `a_`, `s_`, `c_`, `t_`, `r_`, and `d_` keys produce their exact fixed relative paths under one managed root; logical project and asset IDs with arbitrary text cannot alter those paths.
- On both platforms, reject `.` and `..`, embedded or leading `/` and `\\`, `../`, `%2e%2e`, POSIX-rooted paths, Windows drive paths, UNC paths, `file:` paths, NUL/control characters, colon/alternate-data-stream syntax, trailing-dot or trailing-space segments, invalid UTF-8, non-ASCII input, and NFC/NFD-distinct Unicode input before any path is constructed.
- On Windows, reject every reserved basename and extension variant (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`) and verify no case-folded or trailing-dot/space spelling can bypass the key grammar.
- On macOS, assert that composed and decomposed forms of the same non-ASCII name are both rejected rather than normalized into one directory, and that an absolute or separator-bearing name cannot escape the root.
- On both platforms, place a symlink, junction, or reparse point in an existing candidate path and verify the resolver rejects it; a successful write and read must resolve beneath the canonical managed root. Archive entry paths continue to be validated by the `.lumina` importer and are never repurposed as library paths.

## Publication, concurrency and recovery

The following is the target runtime publication contract. It uses one library-level commit for every mutation, including a single-project save, a viewport update, deletion and a multi-project .lumina import. The runtime prepares data beneath staging on the same volume as the final project library. It validates project JSON, schema versions, asset byte counts, MIME and metadata, and snapshot hashes before publication. Staging assets use the existing staging lifecycle and are invisible to normal AssetRepository reads, metadata queries, Object URL hydration, deletion-candidate scans and exports.

Each `staging/<transactionId>/publish.json` is an immutable record with `format: "lumina-library-publish"`, `version: 1`, a runtime `transactionId`, operation kind (`project-mutation`, `library-import` or `migration`), its expected prior catalog revision, affected project expected revisions when applicable, new payload paths and checksums, and the intended full catalog commit ID, sequence and SHA-256. A `library-import` record additionally carries its client `operationId`, runtime-computed request fingerprint and complete source-to-target mappings, but that staging copy is never the authoritative reconciliation record: the identical bounded receipt is part of the published full catalog. The commit catalog has a monotonic library sequence and no duplicate project or asset IDs; its project map, asset map and active import receipts are ordered by the UTF-8 byte order of their stable IDs. The head and commit SHA-256 values use the canonical JSON and digest rules defined in the migration evidence section below.

The runtime holds its library write lease for final validation and publication, then performs this exact order:

1. Read and validate the current library head. A single-project mutation rechecks that project's expected revision. For a library import, first look up a retained receipt by its `operationId`: an exact request fingerprint returns that receipt without a second publication, while a different fingerprint returns `operation_mismatch`. A new import then requires its complete expected catalog revision to equal that head and allocates all target IDs while holding the lease. A mismatch returns `stale_revision` or `stale_catalog` before the visible catalog changes.
2. Flush all transaction payloads, project snapshots, asset metadata/bytes, the complete immutable catalog and (for an import) its complete reconciliation receipt under staging. Verify every listed checksum and reference closure.
3. Materialize the verified immutable payloads and `commits/<commitId>.json` at their final paths, flush their containing directories, and leave them unreachable from readers.
4. Atomically replace the single root `library/head.json` with the new head pointer. That replacement is the only visibility event. It names the new commit and the previous commit ID; no per-project head is written or consulted.
5. After the new head has been reread and its complete catalog verified, verify that a library-import catalog contains its exact reconciliation receipt, then discard only the transaction's staging control files. The immutable payloads and receipt remain reachable through the new catalog.

A reader sees either the prior full catalog or the new full catalog, never a mix. An import therefore cannot expose some imported projects or assets while hiding others, even when it contains many projects. The runtime may prepare work in parallel, but final catalog publication is serialized by the library lease.

The current ProjectRepository does not yet provide this all-mutation guarantee: `expectedRevision` exists only in `saveSnapshot` options; `updateViewport`, `rename` and `delete` have no expected-revision parameter. #43-#45 must add a target runtime command/RPC seam, separate from that legacy compatibility interface:

~~~ts
type ExpectedProjectRevision = string | 'absent';

type CatalogRevision = Readonly<{
  commitId: string;
  sequence: number;
  commitSha256: string;
}>;

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

type ImportOperationId = string;

type RuntimeLibraryTransactionReconciliation = {
  operationId: ImportOperationId;
  expectedCatalog: CatalogRevision;
};

type RuntimeImportedProjectMapping = {
  sourceProjectId: string;
  targetProjectId: string;
  revision: string;
};

type RuntimeImportedAssetMapping = {
  sourceAssetId: string;
  targetAssetId: string;
  sourceProjectId: string;
  targetProjectId: string;
};

type AppliedLibraryImport = {
  code: 'applied';
  operationId: ImportOperationId;
  requestSha256: string;
  catalog: CatalogRevision;
  retainedUntil: number;
  projects: readonly RuntimeImportedProjectMapping[];
  assets: readonly RuntimeImportedAssetMapping[];
};

type RuntimeLibraryTransaction = {
  kind: 'importLuminaArchive';
  /** Generated once by the caller and retained until reconciliation completes. */
  operationId: ImportOperationId;
  expectedCatalog: CatalogRevision;
  archive: Blob;
};

applyLibraryTransaction(transaction: RuntimeLibraryTransaction):
  Promise<
    | AppliedLibraryImport
    | { code: 'stale_catalog'; actualCatalog: CatalogRevision }
    | { code: 'operation_mismatch'; operationId: ImportOperationId }
    | { code: 'rejected'; reason: LuminaProjectImportErrorCode | 'authorization_denied' }
  >;

reconcileLibraryTransaction(query: RuntimeLibraryTransactionReconciliation):
  Promise<
    | AppliedLibraryImport
    /** The validated head still equals expectedCatalog, so this operation was not published. */
    | { code: 'not_published'; catalog: CatalogRevision }
    /** Evidence is no longer retained or cannot prove an advanced head's outcome; never replay automatically. */
    | { code: 'unknown_outcome'; actualCatalog: CatalogRevision }
  >;
~~~

`CatalogRevision` is the exact value pinned from one validated `head.json` and its named catalog: all three fields must equal under the write lease. `applyLibraryTransaction` is the sole target bulk command. The caller generates one lowercase UUID v4 `operationId` before its first submission and persists it with the pending archive until reconciliation ends; it is single-use and is never reused for a fresh import, including after receipt expiry. That logical ID is never a filesystem path. The runtime computes `requestSha256` as `RFC8785-JCS-SHA256-v1` over `{ format: 'lumina-library-import-request-v1', operationId, expectedCatalog, archiveSha256 }`, where `archiveSha256` is SHA-256 of the raw archive bytes. Reusing an `operationId` with a different archive or expected catalog returns `operation_mismatch` before publication.

Its archive must contain the full project and asset set to import; the command re-runs the existing `.lumina` verifier/preparer and requires exactly that verified set. Under the write lease it allocates the complete source-project-ID -> target-project-ID map and source-asset-ID -> target-asset-ID map before any target asset metadata is written to staging or validated. Every imported `AssetMetadata.projectId` is resolved through the former map before its final metadata is staged, validated or published. A missing manifest owner is `invalid_manifest`; if any owner project is rejected for schema or content validation, the entire command is `rejected` and no project, asset or mapping is published. The final target metadata is a complete `AssetMetadata`, not a partial copy: `assetId` and `projectId` are the two allocated target IDs; `kind`, `mimeType`, `byteCount`, `sourceKind` and `sourceMetadata` come from the verified archive bytes/manifest; and `createdAt`, `width`, `height`, `durationMs` and `lifecycleState` receive the explicitly validated v1 import values (one transaction import timestamp, `null`, `null`, `null` and `active`). A later archive schema that carries any of those values must version and validate them rather than silently discarding them. Target tests must cover a missing owner and a rejected owner project with no staged or published asset, then read every persisted metadata field and assert that the returned asset map and the stored owner mapping agree for every imported asset.

After successful publication, the full catalog contains an immutable `completedImports` receipt keyed by `operationId`, with the exact request hash, new catalog commit ID/sequence, retention time, and complete project and asset mappings. Every later full catalog copies each unexpired receipt byte-for-byte; the receipt is retained for 30 days from `publishedAt` and may be removed only by a later serialized catalog publication after `retainedUntil`. Staging cleanup must never delete the only mapping. This is bounded reconciliation evidence rather than an unbounded operation log.

If a response is lost after step 4, the client calls `reconcileLibraryTransaction` with the same operation ID and its original expected catalog. The runtime rereads and validates `head.json` and its catalog: an unexpired matching receipt returns the original `AppliedLibraryImport`, including every mapping, even if later catalog commits have advanced the head. If the receipt is absent while the validated head is still exactly the original expected catalog, `not_published` proves that the import was not visible and the caller may retry the same operation. If the head has advanced and no retained receipt can prove the result, the runtime returns `unknown_outcome`; clients and MCP must never replay that operation automatically. A new import then requires a new explicit authorization and a newly pinned catalog. This protocol, rather than staging-directory inspection, prevents a lost reply from creating a double import.

`stale_catalog` and `rejected` are returned only before publication step 4, so neither makes a new head visible. A storage failure before that step likewise leaves the old catalog visible. The command never calls `applyProjectMutation` once per imported project: it prepares one `library-import` publish record, materializes one complete next catalog and receipt, and performs the same single `head.json` replacement in publication step 4. Its `applied.catalog` is that newly published catalog revision. This is the all-or-stale multi-project import seam.

The target file adapter routes each ordinary project mutation through `applyProjectMutation`; under the same lease it derives one complete next catalog from the current head. Every non-delete success writes a next project revision into that catalog; `delete` checks the revision before removing the project. `updateViewport` and `rename` receive the same check rather than inheriting `saveSnapshot` semantics by implication. Existing browser-only convenience methods remain current compatibility behavior until those adapters land; they are not evidence of a runtime-wide stale-revision contract.

At startup, the runtime acquires maintenance access and applies this deterministic recovery algorithm before accepting writes:

1. If `library/head.json` and its named catalog validate, that catalog is the only visible state. A staging transaction whose intended commit ID equals the head is complete; for a library import, its operation ID, request hash and full mapping must also equal the receipt in that catalog before its remaining staging control files are removed. A missing or different receipt fails catalog validation and follows step 3 rather than deleting the only reconciliation evidence.
2. A staging transaction whose intended commit ID is not the head was never published. Its staging files are removed, and only materialized payloads named by that transaction that are unreachable from the visible catalog, retained commits, recovery data or trash are removed as transaction orphans. They are never promoted by scanning. An unpublished import has no applied mapping to retain.
3. If the head pointer itself is valid but its named catalog or payload checks fail, the runtime validates the pointer's `previousCommitId`. If it is valid, the runtime atomically restores that complete prior head, records read-only recovery for the failed transaction, and blocks further writes until the recovery is acknowledged. It never selects individual project snapshots from the failed import.
4. If the root head is missing or cannot be parsed, the runtime does not guess from commit files or per-project directories. It enters read-only recovery and requires an explicit verified .lumina restore or operator repair.

Normal crash recovery therefore has two observable outcomes: the old head remains visible and the uncommitted transaction is discarded, or the new head remains visible with its complete reconciliation receipt retained. A test must inject a crash before and after each numbered publication step for an import containing multiple projects and assets, then call `reconcileLibraryTransaction`: it observes either `not_published` against the unchanged expected catalog or the returned complete source-to-target mapping, never a partial import or a staged-only mapping.

After each successful publication, reachability is computed from the visible full catalog, retained commits, active staging, recovery data and trash. Unreachable active assets first become deletion candidates. A later cleanup pass may move still-unreachable candidates to trash, but it must recheck reachability under the write lease. Deleting a project first writes its last validated project snapshots and eligible assets to a `deletionId` trash entry, then removes their references in the next complete catalog. Restore republishes a validated snapshot; if an ID is occupied it applies deterministic restore suffixes and rewrites references like an import. Permanent removal requires a separate explicit empty-trash action.

## Browser migration and cutover

The browser-only IndexedDB implementation is the current durable implementation and is transitional only relative to this accepted target. Migration is a future one-time, user-visible operation, not a background sync mechanism. It has two independently committed stages: #45 moves only project facts, and #46 later separates the mixed browser settings record. There is no whole-database `storageMode` switch.

### Per-store ownership

The durable control record in the IndexedDB `meta` store is an ownership ledger, not project or settings evidence. It contains the owner/state for each durable data store and a monotonic `storageModeEpoch`. The ledger is written only under the exclusive migration lease; `meta` remains the coordination store so the ledger can describe different owners without pretending that the whole database froze.

| IndexedDB store | Before #45 | After successful #45 | After successful #46 |
| --- | --- | --- | --- |
| `projects`, `history`, `assets` | Browser adapters are the sole normal writer. | Runtime file-library adapters own live project facts. The IndexedDB stores remain retained, frozen read-only recovery evidence. | Unchanged. |
| `settings` | Browser settings adapter owns the live mixed `settings-storage` record. | Still browser-owned and live. #45 neither sanitizes/migrates settings nor transfers any credential or token. | Non-secret preferences are owned by the runtime preferences file and provider credentials/tokens by platform credential storage. The IndexedDB settings store then becomes frozen read-only recovery evidence. |
| `meta` | Browser schema/control records. | Ownership/epoch ledger and migration coordination. | Same coordination role with the next ownership/epoch ledger. |

Each ownership change advances `storageModeEpoch`; #45 records the project/history/asset transition while recording `settings` as browser-live, and #46 records the settings transition. A frozen store is not a normal browser read fallback: its bytes remain only for the bounded maintenance recovery contract below.

### Exclusive stale-tab fence

Both stages use the same exclusive migration lease. A lease holder first announces a prepare fence to compatible tabs, rejects new ordinary write work as retryable `migration_in_progress`, and requires each tab to account for every open transaction. A compatible tab either lets an in-flight write commit before its acknowledgement or explicitly aborts it, reports that operation as interrupted rather than successful, then acknowledges only after it has closed its IndexedDB connection. The source snapshot starts only after the required acknowledgements; a write that committed before acknowledgement is in that snapshot, and an aborted write is not silently retried by the fence.

Every compatible connection installs `versionchange` handling that stops new transactions and closes the connection. The final cutover opens `lumina-web` at the next monotonic schema version. Its single IndexedDB schema-version upgrade transaction retains all source records and atomically writes the complete per-store ownership vector plus the next `storageModeEpoch` to `meta`. If a tab races the acknowledgement protocol, `versionchange` closes its existing connection before the upgrade can commit. An incompatible or unresponsive tab blocks the upgrade; the lease has a bounded deadline, and expiry invalidates the attempt. If `onupgradeneeded` runs after that deadline, it must recheck the lease and abort its version-upgrade transaction, so a timed-out request can never commit later.

The schema-version transaction is the source-side commit point. Before it commits, a crash, abort, validation failure, blocked timeout, or process restart leaves the prior ownership ledger and database version intact; the browser remains the only writer for the stores that were about to move, and the validated runtime candidate remains unreachable or is discarded under the lease. After it commits, the frozen stores have no browser writer even if a crash occurs before the runtime publishes its already-validated catalog head. Startup then finishes that publication from the durable candidate or enters read-only target recovery; it never rolls the ownership ledger back or revives a browser writer. Thus rollback is allowed only before the source-side commit point. After #45 or #46 commits, recovery may compare, export, or import frozen evidence into the active target, but cannot switch an affected store back to browser-backed writes.

An old bundle reopening its prior schema version receives `VersionError`. It must surface an upgrade-required state and must not fall back to an unversioned open, recreate/delete the database, choose another Origin, or attempt any direct write. A new compatible client reads the ownership vector and exact `storageModeEpoch` before every transaction; it rebuilds its adapter after a mismatch or `versionchange`. A requested write to a frozen store returns a typed non-retryable `frozen_store_write` rejection with the store and observed epoch, not a retry or a browser fallback. The #45 bundle may continue browser settings writes after its post-cutover epoch check; only a migration fence can temporarily interrupt such a write, after which it may be retried against the current browser-live settings ownership.

Acceptance tests for each ownership transition must prove an in-flight write that drains is included, an aborted write is reported interrupted, every compatible tab acknowledges and closes, an unresponsive connection reaches the timeout with no schema/epoch change, and `versionchange` closes a racing connection. They must also inject crashes before and after the source-side commit point, verify an old-version reopen gets `VersionError` without a fallback write, and verify a new client rejects a frozen-store write with the typed non-retryable result while #45 settings writes still succeed. The #46 variant verifies that the same settings write becomes frozen only after its own epoch commit.

### #45 project library cutover

1. While the ownership ledger marks `projects`, `history`, and `assets` as browser-live, their IndexedDB adapters are their only writers. Preflight acquires the exclusive lease, completes the stale-tab fence, and takes a read-only snapshot of only those stores. The #45 runtime never writes that source. The live settings record is outside this snapshot and remains browser-writable after the fence ends.
2. The runtime reads every ProjectRecord, retained history, referenced AssetMetadata and Blob. It stages the same structure described above and validates it with the .lumina importer/exporter rules: parseable project/history JSON, declared schema/revision, complete asset-reference closure, matching byte counts and SHA-256.
3. The runtime creates the project-library migration report described below under runtime identity metadata, validates the unpublished catalog candidate against it, and stores no raw project media, settings object, credential, token, or secret-derived value.
4. Only after the staged target, immutable unpublished catalog candidate, and report validate does the final schema-version upgrade atomically persist the #45 ownership vector and `storageModeEpoch`. The runtime then publishes the validated catalog head and attaches project/history/asset clients to file adapters. The corresponding browser stores remain frozen recovery evidence for the one compatibility release required by #45; `settings` remains live in IndexedDB.

### #45 canonical project migration evidence and recovery

All migration hashes use `RFC8785-JCS-SHA256-v1`: parse the logical JSON value, reject duplicate object member names, non-finite numbers and values RFC 8785 cannot serialize, serialize it with RFC 8785 JSON Canonicalization Scheme, UTF-8 encode the result, then calculate SHA-256 as lowercase hexadecimal. Hashes never use the original JSON string bytes or host object-key order.

For each ProjectRecord, the project hash is the hash of this exact normalized value. Missing `schemaVersion` normalizes to `1`, missing `revision` to `"r0"`, and `recovery` is the actual `ProjectRecovery` value when present or `null`; the migration never substitutes an illustrative recovery state:

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

### #46 settings sanitizer and evidence

#45 does not invoke a settings sanitizer, create a preferences file, or transfer a credential. The redaction transform named `lumina-settings-credential-free-v1` is the compatibility baseline for the later #46 settings migration. It is the semantic behavior of the current `createCredentialFreeSettingsExport` in `src/features/settings/application/settingsRepository.ts`, covered by the SettingsRepository contract and browser diagnostics tests. It deep-clones the snapshot, removes every current `SETTINGS_SECRET_PATHS` entry (`openAiImageApi.apiKey`, `chaomoImageApi.apiKey`, `additionalImageApis.*.apiKey`, `customImageApis.*.apiKey`, `textApis.*.apiKey`, `videoApis.*.apiKey`, `externalAgentConnection.token`, `webDav.username`, and `webDav.password`), and recursively sanitizes every string property named `baseUrl` or `url`.

For a URL that the current WHATWG `URL` parser accepts, v1 removes username, password and fragment, then removes every query parameter whose case-insensitive name is `api_key`, `apikey`, `key`, `token`, `access_token`, `password` or `secret`; if it changed, its serialized `URL.toString()` value is retained. The current fallback strips `http(s)` userinfo when parsing fails. #46 preserves that compatibility transform, then adds a fail-closed admission check: an unparseable `baseUrl` or `url` causes `settings_sanitization_failed` instead of persisting or hashing a value that cannot prove the complete URL rule. `createCredentialFreeBrowserSettingsExport` remains the browser diagnostics wrapper: it applies this same v1 sanitizer and additionally omits `downloadPresetPaths`; #46 reports store no settings object at all, only the v1 metadata and its sanitized-output hash. #46 must test every secret query name case-insensitively (including duplicates), userinfo, fragments, nested `baseUrl`/`url` values, and the parser-failure rejection; each test asserts that preferences, report payloads, fingerprint inputs and hash inputs contain no source secret.

The non-secret settings hash is therefore the hash of `{ format: 'lumina-migration-settings-v1', sanitization: 'lumina-settings-credential-free-v1', settings: <sanitized SettingsExport.settings or null>, version: <effective SettingsExport.version or null> }`. No raw setting, secret value, secret-presence flag or secret-derived hash participates in a preferences snapshot, report, fingerprint, or migration hash.

The following types are the normative v1 evidence schema. They have no implicit `null`, `active` or `0` defaults. `ProjectRecovery` is the current `{ reason: 'unsupported_schema' | 'migration_failed' }` union; `AssetLifecycleState` is the current `'active' | 'deletion-candidate' | 'staging'` union. The #45 project-library fingerprint contains only the project and asset evidence below; `SourceSettingsEvidenceV1` is reserved for the separate #46 report. Any future change to either union or to the sanitizer requires a new evidence version rather than silently reinterpreting v1 evidence.

~~~ts
type SourceProjectEvidenceV1 = {
  id: string;
  schemaVersion: number;
  revision: string;
  recovery: ProjectRecovery | null;
  projectSha256: string;
  historySha256: string;
  assetIds: readonly string[];
};

type SourceAssetEvidenceV1 = {
  assetId: string;
  projectId: string;
  metadataSha256: string;
  bytesSha256: string;
  byteCount: number;
  lifecycleState: AssetLifecycleState;
};

type SourceSettingsEvidenceV1 = {
  observedStoredVersion: number | null;
  effectiveExportVersion: number | null;
  sha256: string;
  sanitization: 'lumina-settings-credential-free-v1';
  excludedSecretPaths: readonly string[];
  secretQueryParameterNames: readonly string[];
};

type IndexedDbSourceFingerprintV1 = {
  format: 'lumina-indexeddb-source-fingerprint';
  version: 1;
  canonicalization: 'RFC8785-JCS-SHA256-v1';
  sourceDatabase: {
    name: 'lumina-web';
    observedSchemaVersion: number;
    observedMetaSchemaVersion: number | null;
  };
  projects: readonly SourceProjectEvidenceV1[];
  assets: readonly SourceAssetEvidenceV1[];
};
~~~

For #45, `sourceDatabase.observedSchemaVersion` is the `IDBDatabase.version` opened before its ownership upgrade; `observedMetaSchemaVersion` is the validated source `meta.schemaVersion` value when present. For #46, `observedStoredVersion` is the original settings snapshot version before the settings migration, while `effectiveExportVersion` is the version on the sanitized `SettingsExport` used for target preferences and its hash. The current code constants are database version 2 and settings schema version 31, but each report records observed values rather than treating either as a v1 literal.

Preflight first resolves every IndexedDB import staging record deterministically. It captures every source AssetMetadata record with its exact lifecycle state and every asset ID recursively referenced from parsed nodes or retained history by the current `.lumina` exporter rules (`assetId`, `previewAssetId` and `lastFrameAssetId`). `active` and `deletion-candidate` records can enter the target candidate. A remaining `staging` record is included in failed preflight evidence with `lifecycleState: 'staging'` and rejects migration unless its owning import can be deterministically completed or discarded; it is never silently rewritten as `active`. A referenced ID without complete metadata and bytes fails validation. Project IDs, asset IDs and each project's asset ID list are sorted by UTF-8 byte order before hashing.

The #45 source fingerprint is the SHA-256 of the RFC 8785 canonical form of the complete `IndexedDbSourceFingerprintV1` object. `projects` and `assets` are the complete sorted capture, not samples or aggregate counts. It deliberately contains no setting or credential evidence.

The migration report persists the complete fingerprint object verbatim and uses the same catalog revision shape as the publication command:

~~~ts
type MigrationReportV1 = {
  format: 'lumina-indexeddb-migration-report';
  version: 1;
  canonicalization: 'RFC8785-JCS-SHA256-v1';
  migrationId: string;
  source: {
    adapter: 'lumina-web-indexeddb';
    capturedAt: number;
    fingerprint: string;
    fingerprintManifest: IndexedDbSourceFingerprintV1;
  };
  target: {
    libraryId: string;
    libraryFormatVersion: 1;
    initialCatalog: CatalogRevision;
    initialHeadSha256: string;
  };
  validation: {
    sourceFingerprintVerified: boolean;
    targetCatalogVerified: boolean;
    assetReferenceClosureVerified: boolean;
  };
  cutover: {
    storageModeEpoch: number;
    completedAt: number;
    storeOwnership: {
      projects: 'runtime-file-library-frozen-recovery';
      history: 'runtime-file-library-frozen-recovery';
      assets: 'runtime-file-library-frozen-recovery';
      settings: 'browser-indexeddb-live';
    };
    indexedDbRecovery: {
      mode: 'frozen-readonly';
      frozenStores: readonly ['projects', 'history', 'assets'];
      retainedThroughRuntimeVersion: string;
    };
  };
};
~~~

The following is only an illustrative placeholder shape; every angle-bracket value must be replaced by the conditional value observed in that migration, not by `null`, `active`, `0`, or a current code constant:

~~~json
{
  "source": {
    "capturedAt": "<observed Unix epoch milliseconds>",
    "fingerprint": "<SHA-256 of the full source manifest>",
    "fingerprintManifest": {
      "sourceDatabase": { "observedSchemaVersion": "<opened IDBDatabase.version>", "observedMetaSchemaVersion": "<validated number or null>" },
      "projects": [{ "schemaVersion": "<effective ProjectRecord schema version>", "recovery": "<ProjectRecovery object or null, exactly observed>" }],
      "assets": [{ "lifecycleState": "<active | deletion-candidate | staging, exactly observed>" }]
    }
  },
  "target": { "initialCatalog": "<CatalogRevision from the first published catalog>" },
  "cutover": {
    "storageModeEpoch": "<next durable epoch>",
    "completedAt": "<Unix epoch milliseconds>",
    "storeOwnership": {
      "projects": "runtime-file-library-frozen-recovery",
      "history": "runtime-file-library-frozen-recovery",
      "assets": "runtime-file-library-frozen-recovery",
      "settings": "browser-indexeddb-live"
    },
    "indexedDbRecovery": {
      "mode": "frozen-readonly",
      "frozenStores": ["projects", "history", "assets"],
      "retainedThroughRuntimeVersion": "<the one compatibility-release endpoint recorded at cutover>"
    }
  }
}
~~~

Before the #45 source-side commit, the runtime recomputes the complete project/asset fingerprint with this same versioned algorithm and requires it to equal `source.fingerprint`; it also verifies the staged catalog against every report entry and writes the three `validation` values only after those checks pass. A failure before the durable ownership/epoch transaction removes only the staged file-library candidate and leaves all browser stores under their prior ownership.

After the #45 ownership/epoch transaction commits, the report makes the frozen project/history/asset recovery window mechanically testable, but it does not authorize a return to browser-backed writes for those stores. A read-only recovery use is eligible only while `cutover.indexedDbRecovery.retainedThroughRuntimeVersion` has not passed and all of the following are true under the maintenance lease: the report validates, runtime identity still names `target.initialCatalog`, the current library head and catalog equal all three fields of that revision plus `initialHeadSha256`, and a fresh v1 source-fingerprint computation against the frozen project/asset stores exactly equals `source.fingerprint`. A recovery action first disables file-library writes, then exposes only those frozen stores for comparison, export, or a verified import into a file-library recovery catalog; it never reattaches them as normal writers. `settings` remains on its normal browser path until #46. Any failed comparison refuses recovery without attaching a second writer. The first library head that differs from `target.initialCatalog.commitId` is a post-cutover mutation; from that point recovery must use the last validated file snapshot or a verified .lumina export, never the stale IndexedDB evidence. Passing the recorded compatibility-release endpoint stops normal recovery use but never auto-deletes the frozen records; deletion remains an explicit user action.

The #45 migration acceptance evidence compares project IDs, names, timestamps, node counts, schema versions, revisions, canonical project/history hashes, asset metadata and byte hashes, recovery state, and every retained credential-free task handle. It records an intentional interrupted result when a task handle cannot safely resume. A passing #45 migration proves one fenced project/history/asset cutover and no dual-writer interval for those stores; it does not prove a settings migration, public release, installer signature, or widget implementation.

### #46 settings separation and freeze

#46 begins from the current ownership ledger, where `settings` is still browser-live even if #45 has frozen the other three stores. It obtains a new exclusive migration lease and repeats the stale-tab fence before reading the single mixed `settings-storage` record. Its source evidence is `SourceSettingsEvidenceV1`, not an amendment to the #45 project/asset fingerprint or report.

The #46 flow first produces the fail-closed credential-free preferences snapshot with `lumina-settings-credential-free-v1`, then writes it to the versioned runtime preferences file. With explicit one-time user approval, it transfers provider credentials, external-Agent tokens, and other `SETTINGS_SECRET_PATHS` values to platform credential storage only in this #46 flow; declining a transfer requires re-entry in the new target. Raw secrets, raw settings, secret-presence flags, and secret-derived hashes never enter staging, project files, ordinary exports, diagnostics, reports, fingerprints, or logs. A failed sanitizer, preferences write, credential-storage write, or validation leaves the settings store browser-live; it is not partially frozen and the runtime must not attach a mixed fallback preferences/credential adapter.

After both target destinations validate, #46 performs the next IndexedDB schema-version upgrade transaction. That one transaction advances `storageModeEpoch` and changes only `settings` from browser-live to frozen recovery evidence; it retains the settings record without exposing it to ordinary clients. A #46 settings report records the sanitized settings evidence, target preferences version, credential-vault validation without values or source-presence data, validation result, ownership vector, and committed epoch. It contains no raw settings object. A crash or timeout before this transaction commits leaves settings browser-live; after it commits, a recovery path can use the frozen record only under the maintenance contract and can never restore settings writes to IndexedDB. Normal clients then receive the same non-retryable `frozen_store_write` rejection for settings writes.

### Ownership epoch and runtime revision fencing

`storageModeEpoch` fences browser-store ownership and stale tabs; it is not a project or catalog revision. A #45 client coordinates the ownership epoch with the runtime before attaching file adapters, but every project mutation still carries its independent expected project revision and `CatalogRevision` through `applyProjectMutation` or `applyLibraryTransaction`. An epoch mismatch requires adapter teardown and ownership recheck; a stale project or catalog revision rejects the requested runtime mutation before library-head publication. Conversely, the #46 settings epoch transition does not change a project revision or authorize a project mutation. The two fences are therefore coordinated at client attachment and recovery, but neither substitutes for the other.

## Authorization and downstream clients

Changing data location does not relax MCP controls. The current bridge keeps its existing browser-backed authorization behavior until #43-#45 land. #45 changes only project/history/asset ownership; settings remain browser-live until #46 and are not exposed to MCP in either stage. In the target runtime, the bridge resolves project data through the command/interface seam above and does not receive raw filesystem access. Opening or reconnecting remains read-only; write, import and run authorization remain separate explicit grants. MCP change sets must carry projectId and an expected revision and call `applyProjectMutation`; an authorized `.lumina` import calls `applyLibraryTransaction` with its expected catalog revision and one persisted operation ID. On reconnect it calls `reconcileLibraryTransaction`, never a blind import retry. Neither calls the legacy revisionless convenience methods. A stale revision or catalog is rejected before library-head publication, and disconnect, timeout, token rotation, runtime restart and repair never replay a mutation or billable generation.

An MCP App widget is a downstream proof of concept. It may render a client of this runtime-owned project library only after its own host, authorization and lifecycle questions are tested. It is neither a prerequisite for this migration nor an alternative storage owner.

## Consequences

Today, browser IndexedDB and its browser-only tests remain the current durable behavior at the registered Origin. When #43-#45 implement migration, only `projects`, `history`, and `assets` are read sources before the #45 cutover and then freeze as recovery evidence; the browser settings record remains live. #46 separately migrates non-secret preferences and provider credentials/tokens before freezing `settings`. New work must not claim that either cutover has already happened. Once the target ships, upgrade, Repair, reinstall and ordinary uninstall acceptance must prove the managed library, preferences and credential vault preservation independently of a Chrome profile or registered Origin. The stable Origin remains an entry, bridge and compatibility concern; it does not select the target project library.

This ADR specifies the durable architecture only. It does not implement the filesystem module, browser or HTTP adapters, IndexedDB migration, settings vault, installer changes, or MCP App widget.
