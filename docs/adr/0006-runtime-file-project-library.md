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
| 运行时身份元数据 | %APPDATA%\Lumina\runtime\ | ~/Library/Application Support/Lumina/runtime/ | installation ID、实际 runtime 路径、注册 Origin、bridge 兼容线，以及只用于定位的项目库 ID/root reference。它不保存项目/资产 ID 或哈希、每 store 归属、`storageModeEpoch`、迁移 selector 或证据、设置、凭据，或任何秘密。每 store 归属、epoch 和迁移绑定仅在 IndexedDB `meta` 协调记录中；完整迁移证据仅在文件项目库中。 |
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
  head.previous.json
  commits/
    <commitId>.json
  migrations/
    <transactionId>.json
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

library.json identifies format lumina-library, version 1 and a libraryId. It contains no project bodies, settings or secrets. `head.json` is the only normal-reader visibility pointer: it names exactly one immutable `commits/<commitId>.json`, that commit's SHA-256, and its previous commit ID. `head.previous.json` is a maintenance-only byte-identical copy of the last durably visible head written before a replacement; normal readers never consult it. It exists solely to restore that validated prior catalog if a host/power failure leaves the new root directory entry absent or unreadable. A commit is a complete catalog, not a delta: it contains the sorted visible `projectId -> projectKey/snapshot manifest/revision/SHA-256` map, the sorted visible `assetId -> assetKey/metadata path/byte path/byteCount/SHA-256` map, and the bounded, unexpired import-reconciliation receipts described below. `migrations/<transactionId>.json` is immutable migration evidence addressed by a `t_` LibraryKey; it is maintenance-only, is never discovered by normal readers, and may contain the complete project/asset fingerprint required below. Readers pin one valid library head before resolving any project, history or asset; they never discover live facts by scanning `projects/`, `assets/`, `migrations/` or `staging/`.

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

The runtime has a mandatory native `DurableFileOps` seam. It exposes `flushFile`, `atomicReplace`, and `syncDirectory`, and it reports `durability_unavailable` before a pointer change when the managed filesystem cannot provide their stated persistence semantics. On Windows, the implementation flushes each file with `FlushFileBuffers`, replaces an existing pointer with `ReplaceFileW` (or a same-volume `MoveFileExW` using `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` when no old pointer exists), and uses the platform's supported native parent/root metadata flush. On macOS, it flushes payload and pointer files with `fcntl(F_FULLFSYNC)` (falling back only to a documented `fsync` capability with the same tested guarantee), uses same-volume `renameat` for replacement, then `fsync`s every affected parent and the library root. The Windows directory/volume helper and the macOS helper are conformance-tested native implementations, not a best-effort JavaScript rename: their successful result means that a subsequent host/power failure leaves either the old valid head or the new valid head recoverable. A filesystem that cannot pass that fault-injection contract is not a writable library root.

The runtime holds its library write lease for final validation and publication, then performs this exact order:

1. Read and validate the current library head. A single-project mutation rechecks that project's expected revision. For a library import, first look up a retained receipt by its `operationId`: an exact request fingerprint returns that receipt without a second publication, while a different fingerprint returns `operation_mismatch`. A new import then requires its complete expected catalog revision to equal that head and allocates all target IDs while holding the lease. A mismatch returns `stale_revision` or `stale_catalog` before the visible catalog changes.
2. Flush all transaction payloads, project snapshots, asset metadata/bytes, the complete immutable catalog and (for an import) its complete reconciliation receipt under staging. Verify every listed checksum and reference closure.
3. Materialize the verified immutable payloads and `commits/<commitId>.json` at their final paths. `DurableFileOps.flushFile` and `syncDirectory` must complete for every new file and each final parent up to the library root before the payload is eligible for a head pointer.
4. Copy the still-valid current `head.json` byte-for-byte to a temporary `head.previous.json`, flush it, atomically replace `head.previous.json`, and synchronize the root. The journal copy must be durable before attempting the new head. For an empty initial library there is no prior catalog, so creation must complete its initial head durability check before any mutation is accepted.
5. Write the new head pointer to a temporary file in the library root, flush it, atomically replace `head.json`, flush the new head, and synchronize the root. This `DurableFileOps` operation is the only visibility event and succeeds only with the old-or-new-head guarantee above. It names the new commit and the previous commit ID; no per-project head is written or consulted.
6. After the new head has been reread and its complete catalog verified, verify that a library-import catalog contains its exact reconciliation receipt, then discard only the transaction's staging control files. The immutable payloads and receipt remain reachable through the new catalog; `head.previous.json` remains until the next serialized publication replaces it.

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

If a response is lost after step 5, the client calls `reconcileLibraryTransaction` with the same operation ID and its original expected catalog. The runtime rereads and validates `head.json` and its catalog: an unexpired matching receipt returns the original `AppliedLibraryImport`, including every mapping, even if later catalog commits have advanced the head. If the receipt is absent while the validated head is still exactly the original expected catalog, `not_published` proves that the import was not visible and the caller may retry the same operation. If the head has advanced and no retained receipt can prove the result, the runtime returns `unknown_outcome`; clients and MCP must never replay that operation automatically. A new import then requires a new explicit authorization and a newly pinned catalog. This protocol, rather than staging-directory inspection, prevents a lost reply from creating a double import.

`stale_catalog` and `rejected` are returned only before the visible pointer replacement in publication step 5, so neither makes a new head visible. A storage failure before that step likewise leaves the old catalog visible. The command never calls `applyProjectMutation` once per imported project: it prepares one `library-import` publish record, materializes one complete next catalog and receipt, and performs the same single `head.json` replacement in publication step 5. Its `applied.catalog` is that newly published catalog revision. This is the all-or-stale multi-project import seam.

The target file adapter routes each ordinary project mutation through `applyProjectMutation`; under the same lease it derives one complete next catalog from the current head. Every non-delete success writes a next project revision into that catalog; `delete` checks the revision before removing the project. `updateViewport` and `rename` receive the same check rather than inheriting `saveSnapshot` semantics by implication. Existing browser-only convenience methods remain current compatibility behavior until those adapters land; they are not evidence of a runtime-wide stale-revision contract.

At startup, the runtime acquires maintenance access and applies this deterministic recovery algorithm before accepting writes:

1. If `library/head.json` and its named catalog validate, that catalog is the only visible state.
2. Otherwise, maintenance validates `head.previous.json` as the exact head-pointer format and validates the complete catalog it names. A valid journal is the only allowed fallback: without replacing that journal, `DurableFileOps` writes it to a temporary current-head file, flushes it, atomically replaces `head.json`, and synchronizes the root. It then records read-only recovery for the interrupted transaction and blocks further writes until the recovery is acknowledged. It does not infer a head by scanning commit or project directories. Thus an undurable new root directory entry restores the last proven head instead of rejecting all valid prior commits.
3. Once a visible head has been established by step 1 or 2, an ordinary staging transaction whose intended commit ID equals it is complete; for a library import, its operation ID, request hash and full mapping must also equal the receipt in that catalog before its remaining staging control files are removed. A missing or different receipt fails catalog validation and retains the control record. An ordinary staging transaction whose intended commit ID is not the visible head was never published: its staging files are removed, and only materialized payloads named by that transaction that are unreachable from the visible catalog, retained commits, recovery data or trash are removed as transaction orphans. They are never promoted by scanning. An unpublished import has no applied mapping to retain.
4. If neither the current head nor the retained prior-head journal validates, the runtime enters read-only recovery and requires an explicit verified .lumina restore or operator repair. It never selects individual project snapshots from an invalid import.

Those generic rules apply to ordinary project mutations and imports. A `migration` staging record and its `migrations/<candidateKey>.json` evidence are excluded from generic promotion and orphan cleanup: only the same `migrationId`/`candidateKey` durable IndexedDB fence or binding may select, retain or clean them under the browser-cutover rules below. This prevents an unbound scan from deleting or activating a different candidate.

Normal crash recovery therefore has two observable outcomes: the old head remains visible and the uncommitted transaction is discarded, or the new head remains visible with its complete reconciliation receipt retained. A conformance test must inject a host/power failure before and after each numbered publication step and each successful `DurableFileOps` primitive for an import containing multiple projects and assets. After remount/restart it must validate and accept the exact old or exact new full catalog, then call `reconcileLibraryTransaction`: it observes either `not_published` against the unchanged expected catalog or the returned complete source-to-target mapping, never a partial import, staged-only mapping, or read-only rejection caused only by a non-durable new directory entry.

After each successful publication, reachability is computed from the visible full catalog, retained commits, active ordinary staging, each unexpired migration report/candidate named by its durable IndexedDB fence or binding, recovery data and trash. Unreachable active assets first become deletion candidates. A later cleanup pass may move still-unreachable candidates to trash, but it must recheck reachability under the write lease. Deleting a project first writes its last validated project snapshots and eligible assets to a `deletionId` trash entry, then removes their references in the next complete catalog. Restore republishes a validated snapshot; if an ID is occupied it applies deterministic restore suffixes and rewrites references like an import. Permanent removal requires a separate explicit empty-trash action.

## Browser migration and cutover

The browser-only IndexedDB implementation is the current durable implementation and is transitional only relative to this accepted target. Migration is a future one-time, user-visible operation, not a background sync mechanism. It has two independently committed stages: #45 moves only project facts, and #46 later separates the mixed browser settings record. There is no whole-database `storageMode` switch.

### Per-store ownership and bound cutover state

The durable control record in the IndexedDB `meta` store is an ownership ledger, not project or settings evidence. It contains the owner/state for each durable data store and a monotonic `storageModeEpoch`. The ledger is written only under the exclusive migration lease; `meta` remains the coordination store so the ledger can describe different owners without pretending that the whole database froze. It is deliberately distinct from runtime identity metadata.

Every committed store transition has one `CutoverBindingV1` in that ledger. It names a random lowercase UUID v4 `migrationId`, one opaque `t_` `candidateKey`, the `RFC8785-JCS-SHA256-v1` digest of that candidate's immutable `staging/<candidateKey>/publish.json`, and the exact target `CatalogRevision` (including its catalog SHA-256). It also records the transition scope, the prepared fence schema version, a finite `recoveryRetainedUntil` Unix epoch milliseconds, and `activation: 'pending' | 'active' | 'recovery_failed'`. A #46 binding additionally copies the prior and target `PreferencesPointerV1` digests and selected vault platform from that immutable candidate, never a pointer body or vault entry reference. A later #46 binding is added alongside the retained #45 binding rather than replacing it. `pending` means the IndexedDB ownership commit has happened but the named target is not yet active; only `active` permits ordinary target attachment; `recovery_failed` is read-only and requires maintenance repair.

The binding contains no project ID, asset ID, setting object, credential, secret-presence bit, or raw secret. The UUID/key are opaque selectors and the two digests are integrity values only. Normal clients, MCP, diagnostics, logs and runtime identity metadata do not expose them. The binding is retained only through `recoveryRetainedUntil`; after the matching report and its named candidate control files have been retired under the maintenance lease, maintenance compacts it to the permanent ownership/epoch evidence and deletes the candidate and catalog digest. Frozen source records themselves are never auto-deleted by that compaction.

| IndexedDB store | Before #45 | After successful #45 | After successful #46 |
| --- | --- | --- | --- |
| `projects`, `history`, `assets` | Browser adapters are the sole normal writer. | Runtime file-library adapters own live project facts. The IndexedDB stores remain retained, frozen read-only recovery evidence. | Unchanged. |
| `settings` | Browser settings adapter owns the live mixed `settings-storage` record. | Still browser-owned and live. #45 neither sanitizes/migrates settings nor transfers any credential or token. | Non-secret preferences are owned by the runtime preferences file and provider credentials/tokens by platform credential storage. The IndexedDB settings store then becomes frozen read-only recovery evidence. |
| `meta` | Browser schema/control records. | Ownership/epoch ledger and migration coordination. | Same coordination role with the next ownership/epoch ledger. |

Each ownership change advances `storageModeEpoch`; #45 records the project/history/asset transition while recording `settings` as browser-live, and #46 records the settings transition. A frozen store is not a normal browser read fallback: its bytes remain only for the bounded maintenance recovery contract below.

### Exclusive stale-tab fence and durable snapshot barrier

Both stages use the same exclusive migration lease. The migration-capable release reserves two strictly monotonic database versions: `fenceSchemaVersion` and a later `cutoverSchemaVersion`. The former is a durable pre-snapshot write barrier, not an advisory BroadcastChannel message. A lease holder announces preparation, rejects new compatible source write work as retryable `migration_in_progress`, and requires each compatible tab to account for every open transaction. A tab either lets an in-flight write commit before acknowledgement or explicitly aborts it and reports that operation as interrupted; it acknowledges only after it closes its IndexedDB connection.

The holder then opens `lumina-web` at `fenceSchemaVersion`. Its schema-version upgrade transaction writes one `migration-fence` record in `meta` containing the `migrationId`, `candidateKey`, exact affected-store scope and `state: 'snapshot-fenced'`. Every compatible `projects`, `history` or `assets` source write transaction must include `meta` in the same `readwrite` IndexedDB transaction, read that record before its first source mutation, and fail with typed retryable `migration_in_progress` with no source-store side effect when its store is fenced. The shared `meta` scope serializes a previously admitted write with the barrier transaction: a write that passed the check commits before the barrier and is in the snapshot; after the barrier commits, every later compatible write sees the fence. This is the required source-write fence even for a deployed compatible bundle that did not receive the in-memory announcement.

A compatible `settings` transaction also verifies the ownership ledger in its transaction, but a #45 fence does not include `settings`: while its ledger owner is browser-live it continues to write the mixed `settings-storage` record. It may be briefly interrupted by `versionchange` and then retries only after reopening at the current compatible schema and confirming that settings is still browser-live. No #45 credential transfer, settings sanitizer, whole-database freeze, or settings write rejection is permitted.

Every compatible connection installs `versionchange` handling that stops new transactions and closes the connection. The fence schema upgrade gives a pre-fence bundle that reopens its prior version `VersionError`; it must surface an upgrade-required state and must not fall back to an unversioned open, recreate/delete the database, choose another Origin, or attempt any direct write. A stale connection that cannot acknowledge/close blocks the fence upgrade. The lease has a bounded deadline; expiry aborts the pending upgrade, so no snapshot starts. A timed-out `onupgradeneeded` rechecks the lease and aborts, so it can never commit later. The source snapshot begins only after the durable fence commits and reads only the stores in its scope.

### Final source commit, activation, and recovery

Once the fenced source snapshot, report and exactly one staged candidate validate, the holder repeats the close acknowledgement and opens `lumina-web` at `cutoverSchemaVersion`. Its single IndexedDB schema-version upgrade transaction retains every source record and atomically writes the complete per-store ownership vector, the next `storageModeEpoch`, and the full `CutoverBindingV1` with `activation: 'pending'`. It verifies that the durable fence has the same `migrationId`, `candidateKey` and scope before doing so. This is the source-side commit point; it does not publish a target by inference or by scanning staging.

After that transaction commits, only the named candidate is eligible. Under the maintenance lease, startup or the original holder uses the binding to apply this deterministic rule:

1. If the target head is exactly the bound `targetCatalog`, validate the one named candidate and report, atomically mark the same binding `active`, then remove only that candidate's staging control files.
2. If the target head is exactly the candidate record's validated prior catalog and exactly one `staging/<candidateKey>/publish.json` matches every bound ID and digest, publish that candidate once, atomically mark the binding `active`, then remove only its staging control files.
3. A missing, duplicate, malformed or digest-mismatched named candidate/report, or any other target head, marks the binding `recovery_failed`. It neither promotes a different candidate nor revives a browser writer. Unrelated staging transactions remain subject to the normal library recovery rules and are not deleted or selected by this migration recovery path.

Before the final source-side transaction, a crash, validation failure, blocked timeout or explicit cancellation deletes only `staging/<candidateKey>` and `migrations/<candidateKey>.json`, then clears only the matching fence under the lease. Startup observes a matching durable fence with no `CutoverBindingV1` as exactly that pre-commit case: it performs this exact cleanup and never publishes the candidate. Ownership remains browser-live, and the compatible browser adapter resumes source writes; the schema is intentionally not downgraded, so old bundles continue to receive `VersionError`. A crash before the fence transaction leaves the prior database version and ownership intact. After the final source-side transaction, affected stores are frozen even if the process crashes before target publication; recovery follows the three rules above and never rolls back ownership. Recovery may compare, export or make a verified import from frozen evidence, but cannot reattach an affected store as a browser writer.

New compatible clients read the complete ownership vector and exact `storageModeEpoch` inside every transaction and rebuild their adapter after an epoch mismatch or `versionchange`. A requested write to a frozen store returns typed non-retryable `frozen_store_write` with the store and observed epoch, not a retry or a browser fallback. Acceptance tests for each transition must prove an in-flight admitted write is captured, an aborted write is reported interrupted, the durable fence rejects a post-fence stale compatible write, every compatible tab acknowledges and closes, an unresponsive connection times out with no ownership/epoch change, and `versionchange` closes a racing connection. They must inject crashes before the fence, between fence and source commit, and after source commit; verify an old-version reopen gets `VersionError` without a fallback write; and verify a new client gets the typed frozen-store rejection. The #45 case additionally proves compatible settings writes succeed before and after the project/history/assets commit, while the #46 case proves settings freezes only after its own epoch commit.

### #45 project library cutover

The browser-resident `BrowserMigrationCoordinator` is the only migration participant that opens `lumina-web`: it runs at the registered Origin, owns the exclusive lease, `versionchange` close protocol, schema-version fence, `meta` write barrier, and the one multi-store read-only source snapshot. It opens the affected stores through the browser's `IDBFactory`, reads the fenced `ProjectRecord`, history, `AssetMetadata`, and immutable Blob values from that snapshot, and never includes `settings` in #45. The runtime never opens, reads, scans, or otherwise accesses browser IndexedDB directly.

After user approval and the durable source fence, the coordinator requests one authenticated, single-use `BrowserMigrationTransferV1` capability from the local runtime. The capability is bound to the installation ID, exact registered Origin, existing authenticated bridge session, `migrationId`, `candidateKey`, transfer protocol version, scope, and a finite expiry. The runtime accepts frames only from its loopback peer carrying that capability and the exact Origin/bridge proof; it does not expose this route to MCP, another Origin, a different installation, or an unauthenticated local process. Capability values and frame bodies are excluded from logs and diagnostics.

The transfer uses ordered, versioned frames. JSON payloads are RFC 8785 canonical UTF-8; each Blob is sent as raw byte chunks with a fixed `assetId`, offset, total byte count, and raw-byte SHA-256. Every frame has `{ format: 'lumina-browser-migration-frame', version: 1, migrationId, candidateKey, sequence, kind, payloadDescriptor, payloadSha256, previousFrameSha256, frameSha256 }`. `payloadDescriptor` is `{ encoding: 'rfc8785-jcs-json' }` for JSON or `{ encoding: 'raw-bytes', assetId, offset, totalByteCount }` for a Blob chunk. `frameSha256` is the `RFC8785-JCS-SHA256-v1` digest of every header field other than itself, including that descriptor; `payloadSha256` is the digest of the canonical JSON payload or raw Blob chunk. Kinds are `begin`, `project`, `history`, `asset-metadata`, `asset-bytes`, and `complete`. `complete` carries the complete source fingerprint, final chained frame hash, and frame count. After it, the runtime constructs the immutable candidate `publish.json` and report, independently recomputes all frame, candidate, catalog, asset-reference, and report digests, and returns `candidate_ready` with the exact candidate digest, report SHA-256, and target `CatalogRevision`.

For each accepted frame the runtime durably stages only that named candidate and returns `{ migrationId, candidateKey, sequence, frameSha256, status: 'accepted' | 'already_accepted' }`. A retry of the same sequence and hash returns `already_accepted`; a different hash, gap, duplicate with a different payload, expired capability, or mismatched binding rejects that one candidate without selecting another. The coordinator persists the acknowledged sequence and source fingerprint in its matching `migration-fence` record, so after a crash it reconnects with the same migration ID/candidate, obtains the runtime's highest acknowledged frame, and retransmits only identical missing frames. Once `candidate_ready` is acknowledged, the coordinator recomputes the fenced source fingerprint, confirms the runtime's exact candidate/catalog/report digests, and alone performs the final IndexedDB ownership upgrade. A pre-binding crash follows the exact fence/candidate cleanup rule; a post-binding crash follows the pending-binding activation rule. This handoff is therefore retryable and idempotent without granting the runtime an IndexedDB read path or a source-store write path.

1. While the ownership ledger marks `projects`, `history`, and `assets` as browser-live, their IndexedDB adapters are their only writers. Preflight makes the BrowserMigrationCoordinator acquire the exclusive lease, install the durable fence above, and take a read-only snapshot of only those stores. The #45 runtime never writes that source. The live settings record is outside this snapshot and remains browser-writable after the fence ends.
2. The BrowserMigrationCoordinator transfers every ProjectRecord, retained history, referenced AssetMetadata, and Blob through `BrowserMigrationTransferV1`; the runtime stages the received values and validates them with the .lumina importer/exporter rules: parseable project/history JSON, declared schema/revision, complete asset-reference closure, matching byte counts and SHA-256.
3. The runtime creates the project-library migration report described below at `migrations/<candidateKey>.json`, validates the unpublished catalog candidate against it, and stores no raw project media, settings object, credential, token, or secret-derived value. The one immutable `staging/<candidateKey>/publish.json` must name the same `migrationId`, report path and report SHA-256, and its exact prior/target `CatalogRevision`; its candidate digest is the RFC 8785 hash of that immutable record and is copied into the binding before the source-side commit. No other candidate can satisfy that binding.
4. Only after the staged target, immutable unpublished catalog candidate, and report validate does the final schema-version upgrade atomically persist the #45 ownership vector, `storageModeEpoch`, and its `pending` binding. The runtime then uses the activation rule above before attaching project/history/asset clients to file adapters. The corresponding browser stores remain frozen recovery evidence for the one compatibility release required by #45; `settings` remains live in IndexedDB.

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

The non-secret settings hash is therefore the hash of `{ format: 'lumina-migration-settings-v1', sanitization: 'lumina-settings-credential-free-v1', settings: <sanitized SettingsExport.settings or null>, version: <effective SettingsExport.version or null> }`. A preferences snapshot contains only that accepted sanitized non-secret export; no unsanitized source settings object, secret value, secret-presence flag or secret-derived hash enters a preferences snapshot, report, fingerprint, or migration hash.

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

The migration report persists the complete fingerprint object verbatim at the named `migrations/<candidateKey>.json` file-library path. It is immutable candidate evidence, not runtime identity metadata and not a normal-reader file. Its complete project/asset identifier and hash manifest stays inside the managed library; the matching IndexedDB binding holds only the opaque migration selector and integrity digests described above. The report uses the same catalog revision shape as the publication command:

~~~ts
type MigrationReportV1 = {
  format: 'lumina-indexeddb-migration-report';
  version: 1;
  canonicalization: 'RFC8785-JCS-SHA256-v1';
  migrationId: string;
  candidateKey: string;
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
    expectedStorageModeEpoch: number;
    storeOwnership: {
      projects: 'runtime-file-library-frozen-recovery';
      history: 'runtime-file-library-frozen-recovery';
      assets: 'runtime-file-library-frozen-recovery';
      settings: 'browser-indexeddb-live';
    };
    indexedDbRecovery: {
      mode: 'frozen-readonly';
      frozenStores: readonly ['projects', 'history', 'assets'];
      compatibilityRelease: string;
      retainedUntil: number;
    };
  };
};
~~~

The actual committed epoch, `pending`/`active`/`recovery_failed` state and candidate/catalog digests live only in the matching `CutoverBindingV1`; it must have the same `migrationId`, `candidateKey`, target catalog and expected epoch before maintenance can use this report. The following is only an illustrative placeholder shape; every angle-bracket value must be replaced by the conditional value observed in that migration, not by `null`, `active`, `0`, or a current code constant:

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
    "expectedStorageModeEpoch": "<next durable epoch>",
    "storeOwnership": {
      "projects": "runtime-file-library-frozen-recovery",
      "history": "runtime-file-library-frozen-recovery",
      "assets": "runtime-file-library-frozen-recovery",
      "settings": "browser-indexeddb-live"
    },
    "indexedDbRecovery": {
      "mode": "frozen-readonly",
      "frozenStores": ["projects", "history", "assets"],
      "compatibilityRelease": "<the one compatibility release recorded at cutover>",
      "retainedUntil": "<finite Unix epoch milliseconds no earlier than the named compatibility release>"
    }
  }
}
~~~

Before the #45 source-side commit, the runtime recomputes the complete project/asset fingerprint with this same versioned algorithm and requires it to equal `source.fingerprint`; it also verifies the staged catalog against every report entry and writes the three `validation` values only after those checks pass. A failure before the durable ownership/epoch transaction uses the exact-candidate cleanup and fence-clear rule above, leaving every browser store under its prior ownership.

After the #45 ownership/epoch transaction commits, the report makes the frozen project/history/asset recovery window mechanically testable, but it does not authorize a return to browser-backed writes for those stores. A read-only recovery use is eligible only while `now <= cutover.indexedDbRecovery.retainedUntil`, the running runtime still recognizes `cutover.indexedDbRecovery.compatibilityRelease`, and all of the following are true under the maintenance lease: the report validates at its named library path; the matching `CutoverBindingV1` is `active`, has the report's migration/key/catalog/expected epoch, matching `recoveryRetainedUntil`, and frozen ownership; the current library head and catalog equal all three fields of `target.initialCatalog` plus `initialHeadSha256`; and a fresh v1 source-fingerprint computation against the frozen project/asset stores exactly equals `source.fingerprint`. A recovery action first disables file-library writes, then exposes only those frozen stores for comparison, export, or a verified import into a file-library recovery catalog; it never reattaches them as normal writers. `settings` remains on its normal browser path until #46. Any failed comparison refuses recovery without attaching a second writer. The first library head that differs from `target.initialCatalog.commitId` is a post-cutover mutation; from that point recovery must use the last validated file snapshot or a verified .lumina export, never the stale IndexedDB evidence. When retention expires, maintenance may remove only the named report and its matching binding digests after recording the permanent frozen ownership/epoch evidence; it never auto-deletes the frozen records, whose deletion remains an explicit user action.

The #45 migration acceptance evidence compares project IDs, names, timestamps, node counts, schema versions, revisions, canonical project/history hashes, asset metadata and byte hashes, recovery state, and every retained credential-free task handle. It records an intentional interrupted result when a task handle cannot safely resume. A passing #45 migration proves one fenced project/history/asset cutover and no dual-writer interval for those stores; it does not prove a settings migration, public release, installer signature, or widget implementation.

### #46 settings separation and freeze

#46 begins from the current ownership ledger, where `settings` is still browser-live even if #45 has frozen the other three stores. It obtains a new exclusive migration lease and applies the same durable fence with `scope: ['settings']` before reading the one mixed `settings-storage` record. Its source evidence is `SourceSettingsEvidenceV1`, not an amendment to the #45 project/asset fingerprint or report. While that #46 fence is active, a compatible settings write returns retryable `migration_in_progress`; before its final ownership commit, an aborted attempt removes that exact fence and the compatible browser settings adapter resumes.

The #46 flow has one versioned preference pointer, not an inferred live file. It prepares a fail-closed credential-free snapshot with `lumina-settings-credential-free-v1` at `preferences/staging/<candidateKey>.json`, validates it, then durably materializes the immutable but unreachable `preferences/candidates/<candidateKey>.json`. `preferences/head.json` is the only ordinary-client pointer and `preferences/head.previous.json` is its maintenance-only prior-pointer journal; both use the `DurableFileOps` old-or-new publication rule. A `PreferencesPointerV1` contains `{ format: 'lumina-runtime-preferences-head', version: 1, migrationId, candidateKey, preferencesPath: 'candidates/<candidateKey>.json', preferencesFormat: 'lumina-runtime-preferences', preferencesVersion, preferencesSha256 }`. Its IDs are opaque selectors, its digest covers the complete preference bytes, and it contains no setting object or secret. Ordinary preference clients must resolve it only when the matching ownership binding is `active`.

With explicit one-time user approval, the coordinator transfers provider credentials, external-Agent tokens, and other `SETTINGS_SECRET_PATHS` values to one selected-OS-vault collection marked by the same `(migrationId, candidateKey)`. That collection has a value-free private control marker with state `prepared` or `active`; the marker and each vault entry remain inside Credential Manager or Keychain. The runtime can probe a collection by the exact pair and platform without returning a value, entry ID, count, source path, or source-presence information. Declining a transfer requires re-entry in the new target. Raw secrets, raw settings, secret-presence flags, and secret-derived hashes never enter staging, project files, ordinary exports, diagnostics, reports, fingerprints, or logs.

The #46 candidate's one immutable `staging/<candidateKey>/publish.json` binds the same `migrationId`, report SHA-256, exact current `CatalogRevision`, target preferences version/SHA-256, SHA-256 of the exact prior preferences pointer (or the versioned empty-pointer marker), SHA-256 of the target `PreferencesPointerV1`, and a value-free candidate-scoped vault validation result. The target preference SHA-256 is over the complete versioned preference-file bytes; the vault result says only that the candidate-scoped platform operation completed and can be resolved by the selected OS vault. No pointer may name that candidate until the matching pending IndexedDB binding exists. A failed sanitizer, provisional/final preferences write, credential-storage write, or validation uses the exact-candidate cleanup rule: it removes only that candidate's staging and immutable preferences files, its marked vault collection, `staging/<candidateKey>`, and `migrations/<candidateKey>.json`, then clears only the matching fence. Startup applies that same cleanup when it finds the matching settings fence with no binding; it never promotes those prewritten targets. Settings remains browser-live; the runtime must not attach a mixed fallback preferences/credential adapter.

`SettingsMigrationReportV1` is the mechanically testable #46 evidence file at `migrations/<candidateKey>.json`. It contains no raw settings object:

~~~ts
type SettingsMigrationReportV1 = {
  format: 'lumina-settings-migration-report';
  version: 1;
  migrationId: string;
  candidateKey: string;
  source: SourceSettingsEvidenceV1;
  target: {
    preferences: {
      format: 'lumina-runtime-preferences';
      version: number;
      sha256: string;
    };
    credentials: {
      format: 'lumina-platform-credential-vault-validation';
      version: 1;
      platform: 'windows-credential-manager' | 'macos-keychain';
      result: 'validated';
    };
  };
  cutover: {
    expectedStorageModeEpoch: number;
    storeOwnership: {
      settings: 'runtime-preferences-and-platform-credentials-frozen-recovery';
    };
    recovery: {
      compatibilityRelease: string;
      retainedUntil: number;
      maintenanceEndpoint: 'lumina.runtime.maintenance.getSettingsMigrationReportV1';
    };
  };
};
~~~

After both provisional destinations validate, #46 performs the next `cutoverSchemaVersion` IndexedDB upgrade transaction. It advances `storageModeEpoch`, changes only `settings` from browser-live to frozen recovery evidence, retains the record without exposing it to ordinary clients, and atomically writes its full `pending` `CutoverBindingV1`. The pending binding must match the report, candidate digest, current catalog, expected epoch, source fence, prior/target preference-pointer digests, and selected vault platform. This is the only point after which a candidate pointer may be published and browser settings writes may not resume.

Under the maintenance lease, activation is always ordered as follows: validate the exact pending binding and all targets; durably publish the named `PreferencesPointerV1`; activate the same candidate-scoped vault collection; then write only that binding as `active` in IndexedDB `meta`. Each step is idempotent and ordinary clients attach neither preferences nor credentials until the final active binding is reread. Startup and the original holder must resolve every observable crash state with this table; they never select a file or vault collection by directory scan.

| Durable observation for the one bound `(migrationId, candidateKey)` | Required validation and action | Result |
| --- | --- | --- |
| Matching settings fence, no binding | The staged preference bytes, immutable candidate, prepared vault collection, candidate publish record, and report all have the exact ID/key before cleanup. Delete only those named objects and clear only that fence. | Settings remains browser-live; retry starts a new preparation. |
| `pending`; current preference pointer is the bound prior pointer; vault is `prepared` | Validate binding/report/candidate/catalog/epoch, frozen source hash, preference format/version/SHA-256, target-pointer digest, and exact vault probe. Publish only the target pointer with `DurableFileOps`, then continue. | Resume at the next row's vault activation. |
| `pending`; current pointer is the exact target pointer; vault is `prepared` | Revalidate the same predicates, activate only that vault collection, then atomically mark only that binding `active`. | Runtime preferences and credentials become attachable. |
| `pending`; current pointer is the exact target pointer; vault is `active` | Revalidate the same predicates, then atomically mark only that binding `active`. | Resume completes without a second pointer or vault write. |
| `active`; current pointer is the exact target pointer; vault is `active` | Revalidate report/binding/source predicates and remove only candidate transfer/staging control files. Retain the immutable preference target, active vault collection, report, and binding for their stated retention. | Ordinary target remains active. |
| Any other pointer, vault state, missing/mismatched report or candidate, wrong catalog/epoch/source hash, or extra object claiming the same migration ID while a matching binding exists | Mark only that binding `recovery_failed`, keep settings frozen, and expose no preferences or credentials. | Terminal maintenance repair; no browser writer or fallback is restored. |

The exact validation set in every non-cleanup row is: the immutable report and publish record have the same migration ID/candidate key/report SHA/candidate digest; the pending or active binding has the same scope, catalog, ownership, epoch, retention, and pointer digests; the frozen `settings-storage` record recomputes to `source.sha256`; `preferences/candidates/<candidateKey>.json` has the report's exact format/version/SHA-256; `preferences/head.json` is either the bound prior pointer or the exact target pointer; and the selected OS vault validates precisely that candidate in the stated `prepared` or `active` state without returning secret material. No partial pointer publication falls outside these branches: a pointer to a candidate with no matching pending/active binding is an invariant failure. It enters an unbound read-only maintenance state, does not synthesize or select a binding, and never permits ordinary attachment; operator repair must first prove the pointer's predecessor or preserve the evidence for manual repair.

`recovery_failed` is terminal for normal startup. Maintenance may retry the same candidate only after every failed predicate becomes true, or explicitly abandon exactly that candidate. Abandoning first restores the bound prior pointer through `DurableFileOps` only when its journal and bound prior digest validate, then deletes only that candidate's vault collection, preference candidate/staging files, publish control file, and report. It records permanent frozen-settings failure/ownership evidence and leaves `settings` frozen; a later user-approved repair prepares a new candidate from frozen evidence and never reenables an IndexedDB settings writer. If the prior pointer cannot be proved, maintenance preserves the named evidence for operator repair rather than guessing or deleting another candidate.

`lumina.runtime.maintenance.getSettingsMigrationReportV1(migrationId)` is a local maintenance-only endpoint, unavailable to MCP and ordinary settings clients. With the maintenance lease it returns `eligible` only when all of these predicates hold: the named immutable report validates; the matching binding is `active` with the same migration/key/candidate digest/catalog/epoch, pointer digests, matching `recoveryRetainedUntil`, and frozen `settings` ownership; the active preference pointer and target file have the report's exact format/version/SHA-256; an OS-vault probe re-validates the same active candidate without returning values or source-presence data; a fresh sanitized hash of the frozen `settings-storage` record equals `source.sha256`; the running runtime recognizes `recovery.compatibilityRelease`; and `now <= recovery.retainedUntil`. Its `unavailable` result identifies only the failed predicate class (`binding`, `report`, `pointer`, `preferences`, `vault`, `source_hash`, `compatibility`, or `retention`) and contains no settings, secret, vault-entry or source-presence data. These predicates, report fields, pointer, vault validation, and binding are the frozen-settings ownership evidence required for a recovery test.

Acceptance tests must inject a crash after each preparation write, after the pending ownership commit, after preference-pointer publication, after vault activation, and after the active-binding write. Each restart must take exactly one table branch, resume idempotently or clean only its one candidate, and prove no ordinary client can read a partial target or write frozen settings. They must also fabricate a candidate pointer without a binding and prove the unbound maintenance state attaches no target. A crash or timeout before the final #46 transaction leaves settings browser-live after exact cleanup; after it commits, settings cannot regain an IndexedDB writer. A settings recovery action may compare the frozen record, rebuild a new candidate, or perform a user-approved credential re-entry through the platform vault, but it never attaches the frozen record as the normal settings adapter or silently retransfers a credential. Normal clients then receive the same non-retryable `frozen_store_write` rejection for settings writes. At the report's expiry, the same maintenance cleanup/compaction rule as #45 removes only its named report and binding digests; it does not delete frozen settings evidence.

### Ownership epoch and runtime revision fencing

`storageModeEpoch` fences browser-store ownership and stale tabs; it is not a project or catalog revision. A #45 client coordinates the ownership epoch with the runtime before attaching file adapters, but every project mutation still carries its independent expected project revision and `CatalogRevision` through `applyProjectMutation` or `applyLibraryTransaction`. An epoch mismatch requires adapter teardown and ownership recheck; a stale project or catalog revision rejects the requested runtime mutation before library-head publication. Conversely, the #46 settings epoch transition does not change a project revision or authorize a project mutation. The two fences are therefore coordinated at client attachment and recovery, but neither substitutes for the other.

## Authorization and downstream clients

Changing data location does not relax MCP controls. The current bridge keeps its existing browser-backed authorization behavior until #43-#45 land. #45 changes only project/history/asset ownership; settings remain browser-live until #46 and are not exposed to MCP in either stage. In the target runtime, the bridge resolves project data through the command/interface seam above and does not receive raw filesystem access. Opening or reconnecting remains read-only; write, import and run authorization remain separate explicit grants. MCP change sets must carry projectId and an expected revision and call `applyProjectMutation`; an authorized `.lumina` import calls `applyLibraryTransaction` with its expected catalog revision and one persisted operation ID. On reconnect it calls `reconcileLibraryTransaction`, never a blind import retry. Neither calls the legacy revisionless convenience methods. A stale revision or catalog is rejected before library-head publication, and disconnect, timeout, token rotation, runtime restart and repair never replay a mutation or billable generation.

An MCP App widget is a downstream proof of concept. It may render a client of this runtime-owned project library only after its own host, authorization and lifecycle questions are tested. It is neither a prerequisite for this migration nor an alternative storage owner.

## Consequences

Today, browser IndexedDB and its browser-only tests remain the current durable behavior at the registered Origin. When #43-#45 implement migration, only `projects`, `history`, and `assets` are read sources before the #45 cutover and then freeze as recovery evidence; the browser settings record remains live. #46 separately migrates non-secret preferences and provider credentials/tokens before freezing `settings`. New work must not claim that either cutover has already happened. Once the target ships, upgrade, Repair, reinstall and ordinary uninstall acceptance must prove the managed library, preferences and credential vault preservation independently of a Chrome profile or registered Origin. The stable Origin remains an entry, bridge and compatibility concern; it does not select the target project library.

This ADR specifies the durable architecture only. It does not implement the filesystem module, browser or HTTP adapters, IndexedDB migration, settings vault, installer changes, or MCP App widget.
