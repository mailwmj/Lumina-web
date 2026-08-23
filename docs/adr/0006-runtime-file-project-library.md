---
status: accepted
---

# 运行时文件项目库与浏览器迁移

> **实施状态（2026-08-23）**：这是已接受的目标架构，不是当前已交付的存储实现。当前仓库仍由固定 Origin 的浏览器 IndexedDB 适配器持有项目、历史、资产和设置。#45 的未来 cutover 只会把项目、历史和资产交给运行时文件项目库；浏览器 settings（包括混合记录）会继续写入，直到 #46 把非秘密偏好和凭据/token 分离到各自目标并冻结 settings store。本文中“迁移源”“cutover”和“运行时客户端”描述该目标交付的行为，不能倒推为当前代码已经切换。
>
> **下游实施前提（规范性）**：在 GitHub 上仍然 live 的 Issue #45 和 #46 被分别修订为本 ADR 已接受的 connected-Chrome 唯一浏览器项目库、#45 只迁移 projects/history/assets 且 settings 保持 browser-live、以及 #46 单独迁移 preferences/credentials 并冻结 settings 的 staged-ownership 合同之前，下游实现不得开始。本 ADR 不修改 Issue；该 tracker 修订需要另行获得授权，不能由实现提交或本文档替代。

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
| 凭据库 | Windows Credential Manager，目标名 `Lumina/v1/<collectionDigest>/<suffix>` | Keychain，service 为 `com.lumina.runtime.credentials.v1.<collectionDigest>`，account 为 `<suffix>` | provider API key、外部 Agent token 和 WebDAV 凭据；#46 定义的 v1 collection 是唯一权威命名空间，不写入普通文件。 |
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
  quarantine/
    <transactionId>/
      manifest.json
      cleanup.json
  trash/
    <deletionId>/
      manifest.json
      projects/
      assets/
~~~

library.json identifies format lumina-library, version 1 and a libraryId. It contains no project bodies, settings or secrets. `head.json` is the only normal-reader visibility pointer: it names exactly one immutable `commits/<commitId>.json`, that commit's SHA-256, and its previous commit ID. `head.previous.json` is a maintenance-only byte-identical copy of the last durably visible head written before a replacement; normal readers never consult it. It exists solely to restore that validated prior catalog if a host/power failure leaves the new root directory entry absent or unreadable. A commit is a complete catalog, not a delta: it contains the sorted visible `projectId -> projectKey/snapshot manifest/revision/SHA-256` map, the sorted visible `assetId -> assetKey/metadata path/byte path/byteCount/SHA-256` map, and the bounded, unexpired import-reconciliation receipts described below. `migrations/<transactionId>.json` is immutable migration evidence addressed by a `t_` LibraryKey; it is maintenance-only, is never discovered by normal readers, and may contain the complete project/asset fingerprint required below. `quarantine/<transactionId>/` contains a failed-publication manifest and later cleanup receipt; it is maintenance-only, never a recovery reader or promotion source. Readers pin one valid library head before resolving any project, history or asset; they never discover live facts by scanning `projects/`, `assets/`, `migrations/`, `staging/` or `quarantine/`.

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

### Canonical bytes and digest preimages

`RFC8785-JCS-SHA256-v1` is a normative byte algorithm, not a label for an implementation's usual JSON serializer. It means: strictly UTF-8 decode one JSON value; reject a BOM, invalid UTF-8, duplicate object-member names, non-finite numbers, unpaired surrogate code units, and any value RFC 8785 cannot represent; apply only the field-specific defaults stated in this ADR; serialize with RFC 8785 JSON Canonicalization Scheme; UTF-8 encode that result with no BOM or trailing newline; then compute SHA-256 and render lowercase hexadecimal. No NFC/NFD, case, locale, timestamp, revision, path, or array normalization is implicit. A parser must detect duplicate names before constructing a host-language object, and an implementation must reject rather than silently use a last-member-wins parser.

Every file-library JSON document that carries or is named by an integrity digest (`head.json`, `head.previous.json`, commits, snapshot manifests, recovery records, publish records, migration reports, completed-import receipts, quarantine manifests and cleanup receipts, preference candidates, and preference pointers) is stored as those exact canonical UTF-8 bytes. On read, its original bytes must equal a fresh canonical serialization of the parsed value; otherwise it is corrupt. Portable `.lumina` input and current IndexedDB JSON strings are parsed as logical values and then written in this canonical target form. Blob bytes, archive bytes, and transfer chunk bytes instead use `raw-bytes-sha256`: SHA-256 of their exact byte sequence without decoding or normalization.

Arrays remain semantic order, so their order is part of every preimage. Where this ADR requires an order, IDs are ordered by their strict UTF-8 byte sequence with no Unicode normalization: project and asset evidence by ID, per-project owned asset IDs by asset ID, `completedImports` by operation ID, and source-to-target mappings by source ID. `CatalogRevision` always serializes all three fields in this order-independent canonical object: `commitId`, `sequence`, and `commitSha256`; an omitted field is not equivalent to a default.

| Digest field | Exact preimage |
| --- | --- |
| `commitSha256` | The full `lumina-library-commit` value stored at `commits/<commitId>.json`. The commit does not contain a self-hash field. |
| `initialHeadSha256` | The full target `lumina-library-head` value stored at `head.json` for the initial catalog, including its `commitSha256` and `previousCommitId`. |
| `catalogDigest` | `{ format: 'lumina-library-catalog-revision', version: 1, catalog: <all three CatalogRevision fields> }`. It is distinct from the catalog file's `commitSha256`; every candidate, report, binding material, and reconciliation response that names a catalog carries both values. |
| `candidateDigest` | The full immutable `lumina-library-publish` `staging/<candidateKey>/publish.json` value. The publish record contains no candidate self-hash. |
| `reportSha256` | The full immutable migration or settings report value at `migrations/<candidateKey>.json`. The report contains no report self-hash. |
| `bindingSha256` | The `binding` value of the durable IndexedDB `lumina-cutover-binding-record` envelope. The envelope stores `{ format, version, binding, bindingSha256 }`; `bindingSha256` hashes only `binding`, never itself or envelope metadata. |
| `preferencesSha256` and preference-pointer digest | Respectively the full versioned preference-candidate value and the full `PreferencesPointerV1` value. The versioned empty-pointer marker is `{ format: 'lumina-runtime-preferences-empty-pointer', version: 1 }`. |
| `requestSha256`, `manifestSha256`, source fingerprint, frame header/payload hashes, and every admitted project/history/metadata hash | The exact versioned logical value stated at its use site, using this algorithm; a frame payload uses canonical JSON bytes or `raw-bytes-sha256` according to its descriptor. `requestSha256` and `manifestSha256` are never calculated from a raw archive/project/history/metadata value before `lumina-project-migration-admission-v1` has accepted or redacted it. |

An implementation must preserve the exact digested values in the immutable record that names them and recompute them before use. It must never calculate a digest from pretty-printed file bytes, a host object iteration order, an unversioned subset, a digest string with different casing, or a value after a second migration/default pass. A report or binding whose catalog revision and `catalogDigest` disagree is invalid before any source ownership change.

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
    | { code: 'rejected'; reason: LuminaProjectImportErrorCode | 'authorization_denied' | 'project_secret_admission_failed' }
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

`CatalogRevision` is the exact value pinned from one validated `head.json` and its named catalog: all three fields must equal under the write lease. `applyLibraryTransaction` is the sole target bulk command. The caller generates one lowercase UUID v4 `operationId` before its first submission and persists it with the pending archive until reconciliation ends; it is single-use and is never reused for a fresh import, including after receipt expiry. That logical ID is never a filesystem path. The runtime must run `lumina-project-migration-admission-v1` over every imported project/history/AssetMetadata value before it creates a receipt, staging entry, canonical digest, or target file. It then computes `admittedImportSha256` over the complete RFC 8785 value `{ format: 'lumina-admitted-project-import', version: 1, admission: 'lumina-project-migration-admission-v1', archive: { format: 'lumina-project-export', version: <admitted archive version> }, projects: <UTF-8-ID-sorted { sourceProjectId, revision, projectSha256, historySha256 }[]>, assets: <UTF-8-ID-sorted { sourceAssetId, sourceProjectId, metadataSha256, bytesSha256, byteCount, lifecycleState }[]> }`, where the project/history/metadata digests are the admitted canonical values and only `bytesSha256` is `raw-bytes-sha256`. `requestSha256` is the digest of `{ format: 'lumina-library-import-request-v1', version: 1, operationId, expectedCatalog, admittedImportSha256 }`. No raw archive/text/metadata hash or raw archive-entry digest is stored in the receipt, staging, report, or request preimage. Reusing an `operationId` with a different admitted payload or expected catalog returns `operation_mismatch` before publication.

Its archive must contain the full project and asset set to import; the command re-runs the existing `.lumina` verifier/preparer, applies that admission rule, and requires exactly that admitted set. Under the write lease it allocates the complete source-project-ID -> target-project-ID map and source-asset-ID -> target-asset-ID map before any target asset metadata is written to staging or validated. Every imported `AssetMetadata.projectId` is resolved through the former map before its final metadata is staged, validated or published. A missing manifest owner is `invalid_manifest`; a failed admission or any owner project rejected for schema/content validation rejects the entire command and publishes no project, asset, mapping, receipt, or candidate. The final target metadata is a complete `AssetMetadata`, not a partial copy: `assetId` and `projectId` are the two allocated target IDs; `kind`, `mimeType`, `byteCount`, `sourceKind` and `sourceMetadata` come from the admitted archive projection; and `createdAt`, `width`, `height`, `durationMs` and `lifecycleState` receive the explicitly validated v1 import values (one transaction import timestamp, `null`, `null`, `null` and `active`). A later archive schema that carries any of those values must version and validate them rather than silently discarding them. Target tests must cover a missing owner, a failed secret admission, and a rejected owner project with no staged or published asset, then read every persisted metadata field and assert that the returned asset map and the stored owner mapping agree for every imported asset.

After successful publication, the full catalog contains an immutable `completedImports` receipt keyed by `operationId`, with the exact request hash, new catalog commit ID/sequence, retention time, and complete project and asset mappings. Every later full catalog copies each unexpired receipt byte-for-byte; the receipt is retained for 30 days from `publishedAt` and may be removed only by a later serialized catalog publication after `retainedUntil`. Staging cleanup must never delete the only mapping. This is bounded reconciliation evidence rather than an unbounded operation log.

If a response is lost after step 5, the client calls `reconcileLibraryTransaction` with the same operation ID and its original expected catalog. The runtime rereads and validates `head.json` and its catalog: an unexpired matching receipt returns the original `AppliedLibraryImport`, including every mapping, even if later catalog commits have advanced the head. If the receipt is absent while the validated head is still exactly the original expected catalog, `not_published` proves that the import was not visible and the caller may retry the same operation. If the head has advanced and no retained receipt can prove the result, the runtime returns `unknown_outcome`; clients and MCP must never replay that operation automatically. A new import then requires a new explicit authorization and a newly pinned catalog. This protocol, rather than staging-directory inspection, prevents a lost reply from creating a double import.

`stale_catalog` and `rejected` are returned only before the visible pointer replacement in publication step 5, so neither makes a new head visible. A storage failure before that step likewise leaves the old catalog visible. The command never calls `applyProjectMutation` once per imported project: it prepares one `library-import` publish record, materializes one complete next catalog and receipt, and performs the same single `head.json` replacement in publication step 5. Its `applied.catalog` is that newly published catalog revision. This is the all-or-stale multi-project import seam.

The target file adapter routes each ordinary project mutation through `applyProjectMutation`; under the same lease it derives one complete next catalog from the current head. Every non-delete success writes a next project revision into that catalog; `delete` checks the revision before removing the project. `updateViewport` and `rename` receive the same check rather than inheriting `saveSnapshot` semantics by implication. Existing browser-only convenience methods remain current compatibility behavior until those adapters land; they are not evidence of a runtime-wide stale-revision contract.

At startup, the runtime acquires maintenance access and applies this deterministic recovery algorithm before accepting writes:

1. If `library/head.json` and its named catalog validate, that catalog is the only visible state.
2. Otherwise, maintenance validates `head.previous.json` as the exact head-pointer format and validates the complete catalog it names. A valid journal is the only allowed fallback: without replacing that journal, `DurableFileOps` writes it to a temporary current-head file, flushes it, atomically replaces `head.json`, and synchronizes the root. It then records read-only recovery for the interrupted transaction and blocks further writes until the recovery is acknowledged. It does not infer a head by scanning commit or project directories. Thus an undurable new root directory entry restores the last proven head instead of rejecting all valid prior commits.
3. Once a visible head has been established by step 1 or 2, an ordinary staging transaction whose intended commit ID equals it is complete; for a library import, its operation ID, request hash and full mapping must also equal the receipt in that catalog before its remaining staging control files are removed. A missing or different receipt fails catalog validation and retains the control record. An ordinary staging transaction whose intended commit ID is not the visible head was never published: maintenance first writes and durably flushes its exact failed-publication quarantine manifest, then releases only that transaction's active staging control. It retains every named materialized payload, publish record, report, and mapping in place or under that quarantine; it does not remove an unreachable payload at this point and never promotes one by scanning. An unpublished import has no applied mapping to return.
4. If neither the current head nor the retained prior-head journal validates, the runtime enters read-only recovery and requires an explicit verified .lumina restore or operator repair. It never selects individual project snapshots from an invalid import.

Those generic rules apply to ordinary project mutations and imports. A `migration` staging record and its `migrations/<candidateKey>.json` evidence are excluded from generic promotion and orphan cleanup: only the same `migrationId`/`candidateKey` durable IndexedDB fence or binding may select it for publication or place it in its own failed-publication quarantine under the browser-cutover rules below. This prevents an unbound scan from deleting, activating, or retaining a different candidate.

Normal crash recovery therefore has two observable outcomes: the old head remains visible and the uncommitted transaction is quarantined, or the new head remains visible with its complete reconciliation receipt retained. A conformance test must inject a host/power failure before and after each numbered publication step and each successful `DurableFileOps` primitive for an import containing multiple projects and assets. After remount/restart it must validate and accept the exact old or exact new full catalog, then call `reconcileLibraryTransaction`: it observes either `not_published` against the unchanged expected catalog or the returned complete source-to-target mapping, never a partial import, staged-only mapping, immediate loss of an unpublished payload, or read-only rejection caused only by a non-durable new directory entry.

### Failed-publication quarantine

`quarantine/<transactionId>/manifest.json` is the durable safety-window record for an unpublished project mutation, library import, #45 candidate, or non-secret #46 candidate. It is written canonically and flushed before any matching fence/control record is cleared. It contains the operation kind, transaction/candidate key, migration ID when present, failure phase/reason class, observed prior and intended catalog revisions plus their `catalogDigest` values, every retained relative payload/control/report path with its digest, `failedAt`, and `retainedUntil`. `retainedUntil` is at least 30 days after `failedAt`; it may be longer when the source recovery or compatibility window is longer. Final-path immutable payloads may stay at their existing paths, but the manifest is their only maintenance reachability claim and they are never visible to normal readers or eligible for later promotion.

At or after `retainedUntil`, maintenance takes the write lease, verifies every listed digest and that each listed payload is still unreachable from the visible catalog, retained commits, active staging, an active or pending cutover binding, recovery data, trash, and another unexpired quarantine. It then writes and flushes `quarantine/<transactionId>/cleanup.json` with the manifest digest, exact removed paths/digests, cleanup time, and the successful reachability recheck; only then may it remove those named payloads. The cleanup receipt remains for the same bounded maintenance-audit retention as the manifest. A missing/mismatched payload, an unexpired reference, or a failed cleanup write leaves the quarantine intact and blocks broad cleanup. No recursive staging cleanup, candidate-directory scan, or "unreachable now" heuristic may delete another transaction's payload.

Credentials are the narrow exception to byte retention: a failed #46 candidate must immediately delete only its candidate-private vault values through the platform vault, because retaining a raw secret for a safety window is forbidden. Its file-library quarantine manifest retains only the value-free vault cleanup result class; the marker, entry digests, index, and cleanup receipt remain only inside the selected OS vault. It contains no secret, secret-derived hash, source path, source-presence bit, vault-entry identifier, or index digest. Its immutable sanitized preference candidate, publish record, and report still follow the normal quarantine rule.

After each successful publication, reachability is computed from the visible full catalog, retained commits, active ordinary staging, every unexpired quarantine, each unexpired migration report/candidate named by its durable IndexedDB fence or binding, recovery data and trash. Unreachable active assets first become deletion candidates. A later cleanup pass may move still-unreachable candidates to trash, but it must recheck reachability under the write lease. Deleting a project first writes its last validated project snapshots and eligible assets to a `deletionId` trash entry, then removes their references in the next complete catalog. Restore republishes a validated snapshot; if an ID is occupied it applies deterministic restore suffixes and rewrites references like an import. Permanent removal requires a separate explicit empty-trash action.

## Browser migration and cutover

The browser-only IndexedDB implementation is the current durable implementation and is transitional only relative to this accepted target. Migration is a future one-time, user-visible operation, not a background sync mechanism. It has two independently committed stages: #45 moves only project facts, and #46 later separates the mixed browser settings record. There is no whole-database `storageMode` switch.

### Per-store ownership and bound cutover state

The durable control record in the IndexedDB `meta` store is an ownership ledger, not project or settings evidence. It contains the owner/state for each durable data store and a monotonic `storageModeEpoch`. The ledger is written only under the exclusive migration lease; `meta` remains the coordination store so the ledger can describe different owners without pretending that the whole database froze. It is deliberately distinct from runtime identity metadata.

Every committed store transition has one canonical `lumina-cutover-binding-record` envelope in that ledger. Its `binding: CutoverBindingV1` names a random lowercase UUID v4 `migrationId`, one opaque `t_` `candidateKey`, `candidateDigest`, `reportSha256`, the exact target `CatalogRevision`, and its distinct `catalogDigest`. It also records the transition scope, the prepared fence schema version, a finite `recoveryRetainedUntil` Unix epoch milliseconds, and `activation: 'pending' | 'active' | 'recovery_failed'`; the envelope carries the derived `bindingSha256` defined above. A #46 binding additionally copies the prior and target `PreferencesPointerV1` digests, exact prior and target vault-active-marker digests, and selected vault platform from that immutable candidate, never a pointer body, marker body, or vault entry reference. A later #46 binding is added alongside the retained #45 binding rather than replacing it. `pending` means the IndexedDB ownership commit has happened but the named target is not yet active; only `active` permits ordinary target attachment; `recovery_failed` is read-only and requires maintenance repair.

The binding contains no project ID, asset ID, setting object, credential, secret-presence bit, or raw secret. The UUID/key are opaque selectors and the candidate, report, catalog, and binding digests are integrity values only. Normal clients, MCP, diagnostics, logs and runtime identity metadata do not expose them. The binding is retained only through `recoveryRetainedUntil`; it is not the permanent ordinary-client attachment record. The transaction that changes a binding from `pending` to `active` also writes this permanent `meta` record. Before later compacting that binding, maintenance validates and preserves the same record in the ownership-ledger transaction that removes the binding:

~~~ts
type PermanentActiveOwnershipV1 = {
  format: 'lumina-permanent-active-ownership';
  version: 1;
  storageModeEpoch: number;
  storeOwnership: Record<'projects' | 'history' | 'assets' | 'settings', string>;
  projectLibrary: { libraryId: string; formatVersion: 1 } | null;
  settings: null | {
    preferencesOwner: {
      format: 'lumina-runtime-preferences-owner';
      version: 1;
      ownerId: string;
      storageModeEpoch: number;
    };
    vaultPlatform: 'windows-credential-manager' | 'macos-keychain';
    vaultMapping: 'lumina-platform-vault-entry-v1';
    vaultActiveMarkerSha256: string;
  };
};
~~~

It contains no migration ID, candidate key, project/asset identifier, setting object, vault entry ID, source-path, or secret-presence bit. `preferencesOwner.ownerId` is a new random lowercase UUID v4 owner identifier, not a migration selector; it is copied into every runtime preferences pointer for that ownership epoch. The permanent record remains until a later exclusive ownership transition atomically replaces it; report expiry may never delete it. If an unexpired active binding and permanent record coexist after an interrupted compaction, they must describe the same ownership/epoch and target attachments or the affected store enters `recovery_failed`; a matching pair is safe, and ordinary clients attach through the permanent record once the active transition commits. For `settings`, they require that `preferences/head.json` has the exact `preferencesOwner` object, that its referenced target validates its own declared version/SHA-256, and that the selected OS vault validates the fixed active marker's exact digest, `lumina-platform-vault-entry-v1` mapping, and the marker-bound immutable index seed/current value-free index before a credential mutation or cleanup. A normal runtime preference mutation may replace the pointer and target only through `DurableFileOps` while preserving that owner object; a different owner requires a new exclusive ownership epoch transition. A mismatch returns non-retryable `target_attachment_invalid` with no browser fallback. Thus settings remains accessible after its recovery window without retaining migration evidence indefinitely. Frozen source records themselves are never auto-deleted by compaction.

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

Once the fenced source snapshot, report and exactly one staged candidate validate, the holder repeats the close acknowledgement and opens `lumina-web` at `cutoverSchemaVersion`. Its single IndexedDB schema-version upgrade transaction retains every source record and atomically writes the complete per-store ownership vector, the next `storageModeEpoch`, and the full canonical `CutoverBindingV1` envelope with `activation: 'pending'`. It verifies that the durable fence has the same `migrationId`, `candidateKey`, scope, candidate/report/catalog digests, and target catalog before doing so. This is the source-side commit point; it does not publish a target by inference or by scanning staging.

After that transaction commits, only the named candidate is eligible. Under the maintenance lease, startup or the original holder uses the binding to apply this deterministic rule:

1. If the target head is exactly the bound `targetCatalog` and its computed `catalogDigest` matches, validate the one named candidate and report, atomically mark the same binding `active` and write the matching `PermanentActiveOwnershipV1`, then release only that candidate's active staging control files.
2. If the target head is exactly the candidate record's validated prior catalog and exactly one `staging/<candidateKey>/publish.json` matches every bound ID, candidate/report/catalog digest, and target catalog, publish that candidate once, atomically mark the binding `active` and write the matching `PermanentActiveOwnershipV1`, then release only its active staging control files.
3. A missing, duplicate, malformed or digest-mismatched named candidate/report, or any other target head, marks the binding `recovery_failed`. It neither promotes a different candidate nor revives a browser writer. Unrelated staging transactions remain subject to the normal library recovery rules and are not deleted or selected by this migration recovery path.

Before the final source-side transaction, a crash, validation failure, blocked timeout or explicit cancellation creates the exact candidate's failed-publication quarantine, then clears only the matching fence under the lease. Startup observes a matching durable fence with no `CutoverBindingV1` as exactly that pre-commit case: it creates that quarantine and never publishes the candidate. Ownership remains browser-live, and the compatible browser adapter resumes source writes; the schema is intentionally not downgraded, so old bundles continue to receive `VersionError`. A crash before the fence transaction leaves the prior database version and ownership intact. After the final source-side transaction, affected stores are frozen even if the process crashes before target publication; recovery follows the three rules above and never rolls back ownership. Recovery may compare, export or make a verified import from frozen evidence, but cannot reattach an affected store as a browser writer.

New compatible clients read the complete ownership vector and exact `storageModeEpoch` inside every transaction and rebuild their adapter after an epoch mismatch or `versionchange`. A requested write to a frozen store returns typed non-retryable `frozen_store_write` with the store and observed epoch, not a retry or a browser fallback. Acceptance tests for each transition must prove an in-flight admitted write is captured, an aborted write is reported interrupted, the durable fence rejects a post-fence stale compatible write, every compatible tab acknowledges and closes, an unresponsive connection times out with no ownership/epoch change, and `versionchange` closes a racing connection. They must inject crashes before the fence, between fence and source commit, and after source commit; verify an old-version reopen gets `VersionError` without a fallback write; and verify a new client gets the typed frozen-store rejection. The #45 case additionally proves compatible settings writes succeed before and after the project/history/assets commit, while the #46 case proves settings freezes only after its own epoch commit.

### #45 project library cutover

The browser-resident `BrowserMigrationCoordinator` is the only migration participant that opens `lumina-web`: it runs at the registered Origin, owns the exclusive lease, `versionchange` close protocol, schema-version fence, `meta` write barrier, and the one multi-store read-only source snapshot. It opens the affected stores through the browser's `IDBFactory`, reads the fenced `ProjectRecord`, history, `AssetMetadata`, and immutable Blob values from that snapshot, runs `lumina-project-migration-admission-v1` there, and never includes `settings` in #45. The runtime never opens, reads, scans, or otherwise accesses browser IndexedDB directly; it receives only the admitted project/history/metadata projection and eligible Blob bytes.

After user approval and the durable source fence, the coordinator requests one authenticated, single-use `BrowserMigrationTransferV1` capability from the local runtime. The capability is bound to the installation ID, exact registered Origin, existing authenticated bridge session, `migrationId`, `candidateKey`, transfer protocol version, scope, and a finite expiry. The runtime accepts frames only from its loopback peer carrying that capability and the exact Origin/bridge proof; it does not expose this route to MCP, another Origin, a different installation, or an unauthenticated local process. Capability values and frame bodies are excluded from logs and diagnostics.

The transfer uses ordered, versioned frames. JSON payloads are RFC 8785 canonical UTF-8 representations of the admitted projection; each Blob is sent as raw byte chunks with a fixed admitted `assetId`, offset, total byte count, and raw-byte SHA-256. Every frame has exactly `{ format: 'lumina-browser-migration-frame', version: 1, migrationId, candidateKey, sequence, kind, payloadDescriptor, payloadSha256, previousFrameSha256, frameSha256 }`. `payloadDescriptor` is exactly `{ encoding: 'rfc8785-jcs-json' }` for JSON or `{ encoding: 'raw-bytes', assetId, offset, totalByteCount }` for a Blob chunk. The `frameSha256` preimage is exactly the `RFC8785-JCS-SHA256-v1` canonical object containing every listed member except `frameSha256`; all of those members are required, including `payloadDescriptor`, `payloadSha256`, and `previousFrameSha256`. `payloadSha256` is the digest of the canonical JSON payload or raw Blob chunk. Sequence is a non-negative safe integer and starts at `0`: `begin` is sequence `0` and its `previousFrameSha256` is the fixed initial predecessor `0c1e563eb7547b8703779582176571ca4df0386a3285a510b6874456f662960a`, the `RFC8785-JCS-SHA256-v1` digest of `{ format: 'lumina-browser-migration-frame-chain-anchor', version: 1 }`. At every later sequence, `previousFrameSha256` equals the immediately preceding frame's `frameSha256`; no frame hashes itself.

The canonical order is exactly: `begin`; for each `source.fingerprintManifest.projects` member ordered by its UTF-8 project ID, one `project` frame followed immediately by its one `history` frame; for each `source.fingerprintManifest.assets` member ordered by its UTF-8 asset ID, one `asset-metadata` frame followed immediately by all of that asset's `asset-bytes` frames at offsets starting at `0` and increasing by the raw payload length; then one `complete` trailer. Thus the kind sequence is `begin`, zero or more `project`/`history` pairs, zero or more `asset-metadata`/one-or-more-`asset-bytes` groups, then `complete`. The `begin` payload also carries one positive safe-integer `assetChunkByteLength`; every non-final non-empty chunk has exactly that length, the final non-empty chunk is no longer than it, and a zero-byte Blob has exactly one zero-byte chunk at offset `0` with total byte count `0`. No frame may be omitted, interleaved, repeated, or follow `complete`. `begin` carries the browser-calculated candidate binding material, the chunk length, fence schema version, scope, expected next `storageModeEpoch`, target ownership vector, retention deadline, and current `CatalogRevision` plus `catalogDigest`; the runtime only validates, stores, and returns that material and never reads IndexedDB to invent it. The canonical JSON `complete` payload is exactly `{ format: 'lumina-browser-migration-complete', version: 1, sourceFingerprint, finalFrameSha256, frameCount }`: `finalFrameSha256` is the preceding non-`complete` frame's hash and must equal the trailer header's `previousFrameSha256`, never the trailer's own hash. `frameCount` is a safe integer that counts every frame including `begin` and `complete`, is at least `2`, and requires `complete.sequence === frameCount - 1`. The trailer's independently computed header hash is named `completeFrameSha256`; it is not present in the trailer payload. After it, the runtime constructs the immutable candidate `publish.json` and report and independently recomputes every frame, candidate, catalog, asset-reference, report, and binding-material digest.

Before returning an acknowledgement, the runtime durably stages the exact admitted payload and its canonical header, then advances one candidate-local progress record that binds every accepted sequence to its kind, `payloadSha256`, `frameSha256`, and predecessor. On restart or reconciliation it rehashes the staged payloads and headers from the fixed initial predecessor, requires contiguous sequences and the canonical order, derives exactly one `nextSequence` and expected predecessor, and quarantines only that candidate on a gap, duplicate, bad hash, wrong order, illegal chunk boundary, or trailer inconsistency. A retry of the same sequence and exact header/payload returns `already_accepted`; a different hash, payload, gap, duplicate, expired capability, or mismatched binding rejects and quarantines that one candidate without selecting another. Once the trailer's source fingerprint, predecessor, count, and `completeFrameSha256` validate, the runtime must durably write one canonical `lumina-browser-migration-candidate-ready` receipt before it sends any `candidate_ready` response. The receipt contains `{ migrationId, candidateKey, scope, sourceFingerprint, finalFrameSha256, completeFrameSha256, frameCount, candidateDigest, reportSha256, targetCatalog, catalogDigest, bindingMaterial }`, where `bindingMaterial` is exactly the `begin` material and no field is inferred later. It is the only response evidence, references the named immutable candidate/report, and contains no source payload or secret.

`reconcileBrowserMigrationCandidate` is the lost-response protocol. The browser calls it with the same authenticated bridge proof and `{ migrationId, candidateKey, sourceFingerprint, finalFrameSha256, completeFrameSha256, frameCount }`; `migrationId` is the idempotency key and maps to exactly one candidate key under the active fence. A matching ready receipt is revalidated against its candidate, complete trailer, report, target catalog, `catalogDigest`, and binding material, then returns the exact same `candidate_ready` value. A matching partial candidate returns `receiving` with its exact `nextSequence` and expected `previousFrameSha256` (and therefore the highest accepted sequence/frame hash), so the coordinator retransmits only from that sequence using the original ordered frames. A matching candidate with no accepted first frame returns `not_received`, so the coordinator may replay from sequence `0`. A mismatched query, duplicate ready receipt, or a ready receipt whose material differs from the fence rejects and quarantines only that candidate; it never substitutes another candidate or asks the runtime to read IndexedDB. The coordinator stores its acknowledged next sequence/predecessor, source fingerprint, final and complete trailer hashes, frame count, and the returned ready receipt in its matching `migration-fence` record. It may perform the final ownership upgrade only when that persisted receipt exactly matches a fresh reconciliation response and the fenced source fingerprint.

This handles a lost `candidate_ready` response without a second snapshot or a second candidate. If the browser process or lease dies before the final ownership binding, startup follows the pre-binding rule: it quarantines this one ready or partial candidate and clears this one fence; it does not automatically resume or promote it. If the source-side binding already committed, the existing pending-binding activation rules take over. This handoff is therefore retryable while its live fence exists, deterministic after a crash, and never grants the runtime an IndexedDB read path or a source-store write path.

1. While the ownership ledger marks `projects`, `history`, and `assets` as browser-live, their IndexedDB adapters are their only writers. Preflight makes the BrowserMigrationCoordinator acquire the exclusive lease, install the durable fence above, and take a read-only snapshot of only those stores. The #45 runtime never writes that source. The live settings record is outside this snapshot and remains browser-writable after the fence ends.
2. The BrowserMigrationCoordinator transfers every admitted ProjectRecord projection, admitted retained-history projection, and every non-staging admitted AssetMetadata/Blob in the successful source fingerprint through `BrowserMigrationTransferV1`, including unreferenced `active` and `deletion-candidate` assets with their exact lifecycle state. The runtime stages and validates the received values with the .lumina importer/exporter rules: admission version, parseable project/history JSON, declared schema/revision, complete asset-reference closure, matching metadata, byte counts, and SHA-256.
3. The runtime creates the project-library migration report described below at `migrations/<candidateKey>.json`, validates the unpublished catalog candidate against it, and stores no raw pre-admission project/history/metadata value, settings object, credential, token, or secret-derived value. The one immutable `staging/<candidateKey>/publish.json` must name the same `migrationId`, report path and `reportSha256`, exact prior/target `CatalogRevision`, and both prior/target `catalogDigest` values; its `candidateDigest` is the RFC 8785 hash of that immutable record and is copied with the report/catalog/binding material into the binding before the source-side commit. No other candidate can satisfy that binding.
4. Only after the staged target, immutable unpublished catalog candidate, and report validate does the final schema-version upgrade atomically persist the #45 ownership vector, `storageModeEpoch`, and its `pending` binding. The runtime then uses the activation rule above before attaching project/history/asset clients to file adapters. The corresponding browser stores remain frozen recovery evidence for the one compatibility release required by #45; `settings` remains live in IndexedDB.

### #45 durable ProjectRecovery parity

The current Web adapter deliberately strips `ProjectRecord.recovery` from `StoredProjectRecord`, and its `migration_failed` state is an in-memory set that disappears on restart. That is current behavior, not acceptable #45 source evidence. A #45-compatible browser release must materialize every observed recovery state before it offers migration. It writes one `BrowserProjectRecoveryEvidenceV1` record at `meta` key `project-recovery:<projectId>` in a `projects`/`history`/`meta` readwrite transaction that rereads the exact source values it binds:

~~~ts
type BrowserProjectRecoveryEvidenceV1 = {
  format: 'lumina-browser-project-recovery';
  version: 1;
  projectId: string;
  observedStoredSchemaVersion: number | null;
  effectiveSchemaVersion: number;
  schemaMapping: 'missing-to-v1' | 'zero-to-v1' | 'identity-v1' | 'unsupported';
  recovery: ProjectRecovery;
  projectSha256: string;
  historySha256: string;
  recordedAt: number;
};
~~~

`observedStoredSchemaVersion: null` means the field was absent, not `0`; the current source mapper records `missing-to-v1`, `zero-to-v1`, or `identity-v1` only after it has validated the effective v1 document. A non-v1 source schema records `unsupported` and `recovery: { reason: 'unsupported_schema' }`. Before this sidecar writes either source hash, the source must pass the later-defined `lumina-project-migration-admission-v1` no-redaction mode; this prevents a credential-bearing raw representation from becoming even browser migration evidence. When a lazy migration fails, the compatible adapter must retry only enough of the source read to write this same sidecar with `recovery: { reason: 'migration_failed' }` and hashes for the reread record; it must not expose a memory-only recovery result if that sidecar cannot commit. It instead returns an explicit persistence failure and leaves the browser source live. A sidecar whose project/history hashes no longer match its source record is stale and invalid.

During lease acknowledgement, a compatible tab that currently knows a pre-sidecar `migration_failed` state must materialize it before it acknowledges a migratable source. The coordinator then takes its fenced snapshot from `projects`, `history`, `assets`, and `meta` together. For every project, it must either have a matching durable recovery sidecar or prove from the observed source schema and validated mapper that recovery is `null`; an unsupported schema can never silently become `null`. A past memory-only failure that vanished on restart is not reconstructible evidence, so an initial #45 rollout must not claim recovery parity from it: it requires the compatibility recovery-materialization pass and a fresh validation scan before permitting the fence. If that pass cannot prove every project, it aborts before cutover without changing ownership.

The target snapshot manifest persists `observedStoredSchemaVersion`, `effectiveSchemaVersion`, `schemaMapping`, and `recovery` for every project. When `recovery` is non-null, it also persists the matching no-redaction-admitted sidecar and unmodified credential-free source project/history representations under that project's `recovery/r_<key>*` paths, hashes all three, and reopens the target `ProjectRecord` in the same read-only `ProjectRecovery` state after every runtime restart. It never runs an unsupported or failed source through a best-effort project rewrite. Export and deletion remain available exactly as they are for current recovery projects. Target validation must reopen the candidate after a fresh runtime process, compare every persisted recovery field and preserved source hash to the source fingerprint, and reject a candidate that loses, changes, or invents a recovery state.

### #45 secret-free project admission

`lumina-project-migration-admission-v1` is a fail-closed candidate-admission rule for project facts. It is deliberately narrower than the #46 settings/ordinary-export sanitizer: it admits only a safe project/history/asset projection to the #45 file-library candidate, does not read or transform `settings`, does not create a preferences file or vault entry, and does not certify a normal `.lumina` export as URL-sanitized. #46 still owns the complete `lumina-settings-credential-free-v1` settings and ordinary-export URL rule and all credential-vault migration.

For an existing browser library, the BrowserMigrationCoordinator applies this rule to the fenced in-memory snapshot before it computes any canonical project/history/metadata hash, source fingerprint, transfer-frame JSON digest, request/manifest digest, runtime candidate, report, or target file. For a browser `.lumina` import, the compatible importer applies it after bounded archive-structure and Blob-byte verification, but before it creates `BrowserImportOperationV1`, stages a payload, calculates a durable/canonical request or manifest digest, or writes imported project/history/asset records; direct runtime `applyLibraryTransaction` imports apply the same rule before their admitted-payload/request digest or any staging. Streaming an untrusted archive only to prove ZIP framing or a Blob byte count may use transient raw bytes; it must not retain or copy an archive-entry hash, text value, parser error, or other raw-derived value into an operation record, source store, fingerprint, frame, candidate, report, quarantine, diagnostic, or log before admission succeeds.

The rule parses every serializable project value (`id`, `name`, revision/schema fields, nodes, edges, viewport, and retained history) and every AssetMetadata value, especially `sourceMetadata`, with duplicate-member detection and the canonical UTF-8 rules above. A versioned project/history/node schema registry must classify every member as a known scalar, user text, URL, asset reference, container, or optional sensitive member; an unknown node type, history entry, object member, `sourceMetadata` key, type, or nested arbitrary map has no pass-through interpretation and fails admission. User text is not exempt: it is scanned as below. This preserves an explicit migration boundary rather than assuming that a current importer/exporter can safely carry arbitrary JSON.

The policy normalizes a member name by retaining ASCII letters and digits, lowercasing them, and removing all other characters. A name containing one of `apikey`, `token`, `secret`, `password`, `authorization`, `credential`, `cookie`, `privatekey`, `clientsecret`, `accesskey`, `gatewayurl`, `signature`, or `signedurl` is sensitive. The only lossy redaction permitted by v1 is to omit that complete member subtree when the registry marks that exact member optional-sensitive; a required or unclassified member fails with `project_secret_admission_failed`. No redaction record contains the source member name, path, value, length, presence bit, raw hash, or a secret-derived hash.

Every URL-classified string, and every user-text string whose trimmed ASCII prefix matches `^[A-Za-z][A-Za-z0-9+.-]*://`, `data:`, or `blob:`, must parse as an absolute `http:` or `https:` URL. It is admitted unchanged only when username, password, fragment, and query are all empty. An optional-sensitive URL member with any of those components is omitted; every other such URL fails. A user-text scalar also fails when it is an ASCII-case-insensitive authorization value (`Bearer`, `Basic`, or `Token` followed by non-whitespace data), a three-segment base64url JWT, or a key-shaped token beginning (ASCII-case-insensitively) `sk-`, `rk-`, `pk-`, `AKIA`, `ghp_`, `github_pat_`, or `xox` followed by at least eight identifier characters. A registry field whose grammar cannot establish a non-credential value must fail rather than return an "unknown but allowed" result. These conservative rules may require a user to remove or re-enter ambiguous data; they may not silently persist it.

Admission produces either one parsed/redacted logical projection or the fixed value-free error `project_secret_admission_failed`. On success the browser discards the raw tree before handoff and computes every downstream hash only from the admitted projection using `RFC8785-JCS-SHA256-v1`; successful evidence records only the fixed admission version, never a redaction list/count. On failure it creates no operation/candidate/fingerprint/report and follows the ordinary pre-commit cleanup path (clear only its matching fence and keep browser ownership live). Thus a secret-bearing source remains recoverable only in the existing browser source until the user repairs it; it never becomes a runtime-file fact or migration evidence.

`ProjectRecovery` has the stricter no-redaction mode. Before `BrowserProjectRecoveryEvidenceV1` writes its source hashes, the raw recovery project/history representations must pass the same classifier with zero omitted members and no URL/token finding. Otherwise the sidecar is not written and #45 preflight fails before a fence/candidate; the runtime never preserves a redacted value as an "unmodified" recovery file. A recovery project that passes this mode retains the existing exact-source parity contract. Normal projects and imported projects use the admitted projection in their canonical hashes, transfer frames, source fingerprint, and target files; count/map parity is over that projection and every omitted optional-sensitive member is absent from both source evidence and target, never implicitly restored.

### Browser import operation ownership and capture scope

The current browser `.lumina` import path has only a random `stagingId` on asset records and a global `cleanupStaging()` routine. It is current compatibility behavior, but it is not an operation-recovery protocol and #45 must not use it to sweep a source before migration. The #45-compatible browser release adds a temporary `import-staging` control store plus one durable `BrowserImportOperationV1` record in `meta` at `browser-import:<operationId>`. This store is a bounded browser import implementation detail, never a project owner and never part of the #45 ownership vector.

Each caller creates one lowercase UUID v4 `operationId` and one non-negative safe-integer Unix-millisecond `createdAt` before its first durable import write. `createdAt` is written exactly once, is never regenerated during retry/recovery, and is not a current-time default. After secret-free admission, the exact canonical record at `browser-import:<operationId>` is:

~~~ts
type BrowserImportOperationV1 = {
  format: 'lumina-browser-import-operation';
  version: 1;
  operationId: string;
  createdAt: number;
  stagingId: string;
  requestSha256: string;
  manifestSha256: string;
  expected: { projectCount: number; assetCount: number };
  stagedEntries: readonly {
    entryKey: string;
    kind: 'project' | 'history' | 'asset-metadata' | 'asset-bytes';
    sha256: string;
    byteCount: number;
  }[];
  state: 'preparing' | 'prepared' | 'published' | 'discarded';
  stateChangedAt: number;
  published: null | {
    publishedAt: number;
    projects: readonly { sourceProjectId: string; targetProjectId: string; revision: string }[];
    assets: readonly { sourceAssetId: string; targetAssetId: string; sourceProjectId: string; targetProjectId: string }[];
  };
  discarded: null | {
    discardedAt: number;
    reason: 'incomplete' | 'manifest_mismatch' | 'source_integrity_error';
    removedEntryKeys: readonly string[];
  };
};
~~~

The record itself is RFC 8785 canonical UTF-8 with no self-hash. `requestSha256` is the digest of the complete `BrowserImportRequestV1` value `{ format: 'lumina-browser-import-request', version: 1, archive: { format: 'lumina-project-export', version: <admitted archive version> }, projects: <UTF-8-ID-sorted { sourceProjectId, revision }[]>, assets: <UTF-8-ID-sorted { sourceAssetId, sourceProjectId, lifecycleState }[]> }`. `manifestSha256` is the digest of the complete `BrowserImportPreparedManifestV1` value `{ format: 'lumina-browser-import-prepared-manifest', version: 1, operationId, requestSha256, projects: <UTF-8-ID-sorted { sourceProjectId, projectSha256, historySha256 }[]>, assets: <UTF-8-ID-sorted { sourceAssetId, sourceProjectId, metadataSha256, bytesSha256, byteCount, lifecycleState }[]>, stagedEntries: <entryKey-sorted complete stagedEntries[]> }`. `projectSha256`, `historySha256`, and `metadataSha256` are hashes of the admitted projections; `bytesSha256` is `raw-bytes-sha256`. Every array is required, sorted as stated, and has no implicit empty/default member. Thus neither digest has a raw archive, raw project/history JSON, raw source metadata, raw archive-entry hash, or secret-derived preimage.

The first `meta`/`import-staging` transaction commits that complete `preparing` record before any staged payload. Every staged project/history payload and Blob is addressed by its `operationId` and opaque `entryKey`; any legacy `assets` staging record also carries that same operation ID. Each staging transaction rereads the record and may write only a listed entry with its exact digest/byte count. A retry with an existing operation ID is idempotent only when the caller's `createdAt`, `stagingId`, `requestSha256`, `manifestSha256`, and every staged entry match the record, and any stored terminal receipt revalidates exactly; it then resumes or returns the recorded state. A difference is `operation_mismatch` with no mutation. Reuse of a staging ID/entry key by another operation, duplicate owner records, or an entry absent from the manifest is `import_staging_collision`, blocks #45 preflight, and never authorizes a global cleanup.

The final publish transaction spans `projects`, `history`, `assets`, `import-staging`, and `meta`: it validates the complete manifest, allocates the source-to-target maps, writes all live records, removes only that operation's staged entries, and atomically replaces `prepared` with the retained `published` receipt. Therefore a crash leaves either `prepared` with one complete resumable payload or `published` with its exact result; it never leaves a guessed partial import. On restart, maintenance reconciles one supplied `operationId`, never every `lifecycleState: 'staging'` record. `prepared` resumes that one publish transaction; `published` returns its retained maps without replay; incomplete/mismatched `preparing` or `prepared` transitions only itself to `discarded`, records the exact removed opaque entry keys, and cleans only those entries. Its compact terminal receipt remains at least 30 days.

When more than one interrupted operation exists, preflight sorts records first by numeric `createdAt` ascending and then by the UTF-8 byte order of `operationId`; equal timestamps therefore have one stable order. It reconciles each record in that order without allowing an earlier failure to delete, rewrite, or select a later record. An unresolved/colliding record blocks the #45 fence after recording only its own outcome; a later `published` record remains intact and a later valid operation may be reconciled when its predecessor is resolved. Acceptance tests fix equal `createdAt` values, exercise both operation-ID and staging-ID collisions, kill/restart before and after each state change, and prove that replay returns the original mapping while cleanup removes exactly one operation's payload.

The successful #45 fingerprint starts after that operation reconciliation and contains every remaining browser `AssetMetadata` record with `lifecycleState: 'active'` or `'deletion-candidate'`, whether or not a current node/history references it. Every fingerprinted asset has exactly one transferred metadata frame, its complete Blob frames, one target catalog entry, and matching metadata/byte/lifecycle hashes. `deletion-candidate` remains a deletion candidate in the target; it is neither dropped nor rewritten as `active`. Parsed project/history references still require complete closure and target mappings, but unreferenced active/candidate assets are also preserved because they remain durable asset facts. Thus a successful source fingerprint has no `staging` asset entry and no implicit exclusion. A failed preflight may report its unresolved operation IDs only to maintenance, but it is not a successful migration report or candidate fingerprint.

### #45 canonical project migration evidence and recovery

All migration hashes use the exact `RFC8785-JCS-SHA256-v1` preimages above. A normal project is hashed only after `lumina-project-migration-admission-v1` produces its parsed/redacted logical projection; a recovery project preserves and hashes its original stored strings only after its no-redaction admission passes. Hashes never use host object-key order, a raw pre-admission value, or a silently substituted recovery state.

For each non-recovery ProjectRecord, `admitted` is its one successful post-admission projection and the project hash is the hash of this exact normalized value. Missing `schemaVersion` normalizes to `1`, missing `revision` to `"r0"`, and `recovery` is `null`; the source schema block is the independently observed/materialized mapping rather than an inferred current-code constant:

~~~ts
const projectCanonicalValue = {
  format: 'lumina-migration-project-v1',
  sourceSchema: {
    observedStoredSchemaVersion: sourceSchema.observedStoredSchemaVersion,
    effectiveSchemaVersion: sourceSchema.effectiveSchemaVersion,
    mapping: sourceSchema.mapping,
  },
  project: {
    schemaVersion: admitted.schemaVersion ?? 1,
    id: admitted.id,
    name: admitted.name,
    createdAt: admitted.createdAt,
    updatedAt: admitted.updatedAt,
    nodeCount: admitted.nodeCount,
    revision: admitted.revision ?? 'r0',
    recovery: null,
    nodes: admitted.nodes,
    edges: admitted.edges,
    viewport: admitted.viewport,
  },
};
~~~

For a recovery project, the no-redaction admission verifier may parse only to reject a secret-bearing value; after it passes, neither its project strings nor its history string is rewritten. Its project and history hashes are instead the following exact values; the `recovery` and source-schema values must equal the durable `BrowserProjectRecoveryEvidenceV1` sidecar. This is the representation copied to the target recovery files:

~~~ts
const recoveryProjectCanonicalValue = {
  format: 'lumina-migration-recovery-project-v1',
  sourceSchema: {
    observedStoredSchemaVersion: recoveryEvidence.observedStoredSchemaVersion,
    effectiveSchemaVersion: recoveryEvidence.effectiveSchemaVersion,
    mapping: recoveryEvidence.schemaMapping,
  },
  recovery: recoveryEvidence.recovery,
  storedProject: {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
    revision: record.revision ?? 'r0',
    nodesJson: record.nodesJson,
    edgesJson: record.edgesJson,
    viewportJson: record.viewportJson,
  },
};

const recoveryHistoryCanonicalValue = {
  format: 'lumina-migration-recovery-history-v1',
  historyJson: record.historyJson,
};
~~~

The normal history hash is `{ format: 'lumina-migration-history-v1', history: admitted.history }`. The asset metadata hash is the hash of this exact object, where `admittedAsset` is the one post-admission AssetMetadata projection; the asset byte hash is `raw-bytes-sha256` of the Blob byte sequence:

~~~ts
const assetMetadataCanonicalValue = {
  format: 'lumina-migration-asset-metadata-v1',
  metadata: {
    assetId: admittedAsset.assetId,
    projectId: admittedAsset.projectId,
    kind: admittedAsset.kind,
    mimeType: admittedAsset.mimeType,
    byteCount: admittedAsset.byteCount,
    createdAt: admittedAsset.createdAt,
    sourceKind: admittedAsset.sourceKind,
    width: admittedAsset.width,
    height: admittedAsset.height,
    durationMs: admittedAsset.durationMs,
    sourceMetadata: admittedAsset.sourceMetadata,
    lifecycleState: admittedAsset.lifecycleState,
  },
};
~~~

### #46 settings sanitizer and evidence

#45 does not invoke a settings sanitizer, create a preferences file, or transfer a credential. The redaction transform named `lumina-settings-credential-free-v1` is the compatibility baseline for the later #46 settings migration. It is the semantic behavior of the current `createCredentialFreeSettingsExport` in `src/features/settings/application/settingsRepository.ts`, covered by the SettingsRepository contract and browser diagnostics tests. It deep-clones the snapshot, removes every current `SETTINGS_SECRET_PATHS` entry (`openAiImageApi.apiKey`, `chaomoImageApi.apiKey`, `additionalImageApis.*.apiKey`, `customImageApis.*.apiKey`, `textApis.*.apiKey`, `videoApis.*.apiKey`, `externalAgentConnection.token`, `webDav.username`, and `webDav.password`), and recursively sanitizes every string property named `baseUrl` or `url`.

For a URL that the current WHATWG `URL` parser accepts, v1 removes username, password and fragment, then removes every query parameter whose case-insensitive name is `api_key`, `apikey`, `key`, `token`, `access_token`, `password` or `secret`; if it changed, its serialized `URL.toString()` value is retained. The current fallback strips `http(s)` userinfo when parsing fails. #46 preserves that compatibility transform, then adds a fail-closed admission check: an unparseable `baseUrl` or `url` causes `settings_sanitization_failed` instead of persisting or hashing a value that cannot prove the complete URL rule. `createCredentialFreeBrowserSettingsExport` remains the browser diagnostics wrapper: it applies this same v1 sanitizer and additionally omits `downloadPresetPaths`; #46 reports store no settings object at all, only the v1 metadata and its sanitized-output hash. #46 must test every secret query name case-insensitively (including duplicates), userinfo, fragments, nested `baseUrl`/`url` values, and the parser-failure rejection; each test asserts that preferences, report payloads, fingerprint inputs and hash inputs contain no source secret.

The non-secret settings hash is therefore the hash of `{ format: 'lumina-migration-settings-v1', sanitization: 'lumina-settings-credential-free-v1', settings: <sanitized SettingsExport.settings or null>, version: <effective SettingsExport.version or null> }`. A preferences snapshot contains only that accepted sanitized non-secret export; no unsanitized source settings object, secret value, secret-presence flag or secret-derived hash enters a preferences snapshot, report, fingerprint, or migration hash.

The following types are the normative v1 evidence schema. They have no implicit `null`, `active` or `0` defaults. `ProjectRecovery` is the current `{ reason: 'unsupported_schema' | 'migration_failed' }` union; `AssetLifecycleState` is the current `'active' | 'deletion-candidate' | 'staging'` union. The #45 project-library fingerprint contains only the admitted project and asset evidence below; `SourceSettingsEvidenceV1` is reserved for the separate #46 report. Any future change to either union, the project admission rule, or the settings sanitizer requires a new evidence version rather than silently reinterpreting v1 evidence.

~~~ts
type SourceProjectEvidenceV1 = {
  id: string;
  sourceSchema: {
    observedStoredSchemaVersion: number | null;
    effectiveSchemaVersion: number;
    mapping: 'missing-to-v1' | 'zero-to-v1' | 'identity-v1' | 'unsupported';
  };
  revision: string;
  recovery: ProjectRecovery | null;
  recoveryEvidenceSha256: string | null;
  projectSha256: string;
  historySha256: string;
  /** Every captured asset owned by this project, including unreferenced candidates. */
  assetIds: readonly string[];
};

type SourceAssetEvidenceV1 = {
  assetId: string;
  projectId: string;
  metadataSha256: string;
  bytesSha256: string;
  byteCount: number;
  lifecycleState: 'active' | 'deletion-candidate';
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
  projectAdmission: 'lumina-project-migration-admission-v1';
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

Preflight first resolves every IndexedDB import operation as specified above, then admits the complete fenced project/history/asset capture. A successful capture contains every remaining admitted AssetMetadata record with its exact `active` or `deletion-candidate` lifecycle state and complete Blob, plus every asset ID recursively referenced from admitted non-recovery nodes or retained history by the current `.lumina` exporter rules (`assetId`, `previewAssetId` and `lastFrameAssetId`). `SourceProjectEvidenceV1.assetIds` is the complete set of captured assets whose admitted `projectId` matches that project, not only the reference closure. A referenced ID without complete metadata and bytes fails validation. Any remaining `staging` record, operation without one owner, unresolved recovery sidecar, or failed project admission fails preflight before the source fingerprint/candidate exists; it is never included as a successful `staging` evidence item or silently rewritten as `active`. Project IDs, asset IDs, each project's complete owned asset ID list, and transfer mappings are sorted by UTF-8 byte order before hashing.

The #45 admitted-source fingerprint is the SHA-256 of the RFC 8785 canonical form of the complete `IndexedDbSourceFingerprintV1` object. `projects` and `assets` are the complete sorted admitted capture, not samples or aggregate counts. It deliberately contains no setting, credential, raw pre-admission value, redaction list/count, or secret-derived evidence.

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
    initialCatalogDigest: string;
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

The actual committed epoch, `pending`/`active`/`recovery_failed` state and candidate/report/catalog/binding digests live only in the matching `CutoverBindingV1` envelope; it must have the same `migrationId`, `candidateKey`, report digest, target catalog, target `catalogDigest`, and expected epoch before maintenance can use this report. The following is only an illustrative placeholder shape; every angle-bracket value must be replaced by the conditional value observed in that migration, not by `null`, `active`, `0`, or a current code constant:

~~~json
{
  "source": {
    "capturedAt": "<observed Unix epoch milliseconds>",
    "fingerprint": "<SHA-256 of the full source manifest>",
    "fingerprintManifest": {
      "sourceDatabase": { "observedSchemaVersion": "<opened IDBDatabase.version>", "observedMetaSchemaVersion": "<validated number or null>" },
      "projects": [{ "sourceSchema": "<observed/effective/version-mapping tuple>", "recovery": "<ProjectRecovery object or null, exactly observed>" }],
      "assets": [{ "lifecycleState": "<active | deletion-candidate, exactly observed>" }]
    }
  },
  "target": {
    "initialCatalog": "<CatalogRevision from the first published catalog>",
    "initialCatalogDigest": "<RFC8785-JCS-SHA256-v1 catalogDigest>",
    "initialHeadSha256": "<RFC8785-JCS-SHA256-v1 initial head pointer>"
  },
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

Before the #45 source-side commit, the runtime recomputes the complete admitted project/asset fingerprint with this same versioned algorithm and requires it to equal `source.fingerprint`; it also verifies the staged catalog against every report entry, every no-redaction-admitted recovery sidecar/raw recovery file, and every non-staging asset mapping before it writes the three `validation` values. A failure before the durable ownership/epoch transaction creates the exact candidate quarantine and clears only its matching fence, leaving every browser store under its prior ownership.

After the #45 ownership/epoch transaction commits, the report makes the frozen project/history/asset recovery window mechanically testable, but it does not authorize a return to browser-backed writes for those stores. A read-only recovery use is eligible only while `now <= cutover.indexedDbRecovery.retainedUntil`, the running runtime still recognizes `cutover.indexedDbRecovery.compatibilityRelease`, and all of the following are true under the maintenance lease: the report validates at its named library path; the matching `CutoverBindingV1` envelope is `active`, has the report's migration/key/report/catalog/catalog-digest/expected epoch, matching `recoveryRetainedUntil`, and frozen ownership; the current library head and catalog equal all three fields of `target.initialCatalog`, `initialCatalogDigest`, and `initialHeadSha256`; and a fresh v1 admission plus admitted-source-fingerprint computation against the frozen project/asset stores exactly equals `source.fingerprint`, including every recovery sidecar/schema mapping and every active/deletion-candidate asset. A recovery action first disables file-library writes, then exposes only those frozen stores for comparison, export, or a verified import into a file-library recovery catalog; it never reattaches them as normal writers. `settings` remains on its normal browser path until #46. Any failed comparison refuses recovery without attaching a second writer. The first library head that differs from `target.initialCatalog.commitId` is a post-cutover mutation; from that point recovery must use the last validated file snapshot or a verified .lumina export, never the stale IndexedDB evidence. When retention expires, maintenance may remove only the named report and its matching binding after validating the permanent `PermanentActiveOwnershipV1` ownership/epoch record; it never auto-deletes the frozen records, whose deletion remains an explicit user action.

The #45 migration acceptance evidence compares admitted project IDs, names, timestamps, node counts, observed/effective schema mappings, revisions, canonical project/history hashes, recovery sidecars and preserved no-redaction recovery hashes, every active/deletion-candidate asset metadata/byte/lifecycle hash, source-to-target count/map parity, and every retained credential-free task handle. It must seed optional sensitive project/history/source-metadata fields, credential-bearing URLs, bare-token strings, unknown metadata, and recovery values: prove optional fields are absent from the admitted source/target, every other case aborts before candidate evidence, and no raw value appears in target files or diagnostic/report bytes. Transfer fixtures must independently recompute the fixed chain anchor, every header/payload hash, exact canonical order, trailer predecessor/count/hash, and candidate-ready receipt; they must crash/restart after every accepted sequence, lose the ready response, and prove reconciliation returns the one persisted next sequence/predecessor or exact ready receipt without a second snapshot. It records an intentional interrupted result when a task handle cannot safely resume. A passing #45 migration proves one fenced project/history/asset cutover and no dual-writer interval for those stores; it does not prove a settings migration, full ordinary-export URL sanitization, public release, installer signature, or widget implementation.

### #46 settings separation and freeze

#46 begins from the current ownership ledger, where `settings` is still browser-live even if #45 has frozen the other three stores. It obtains a new exclusive migration lease and applies the same durable fence with `scope: ['settings']` before reading the one mixed `settings-storage` record. Its source evidence is `SourceSettingsEvidenceV1`, not an amendment to the #45 project/asset fingerprint or report. While that #46 fence is active, a compatible settings write returns retryable `migration_in_progress`; before its final ownership commit, an aborted attempt removes that exact fence and the compatible browser settings adapter resumes.

The #46 flow has one versioned preference pointer, not an inferred live file. It prepares a fail-closed credential-free snapshot with `lumina-settings-credential-free-v1` at `preferences/staging/<candidateKey>.json`, validates it, then durably materializes the immutable but unreachable `preferences/candidates/<candidateKey>.json`. `preferences/head.json` is the only ordinary-client pointer and `preferences/head.previous.json` is its maintenance-only prior-pointer journal; both use the `DurableFileOps` old-or-new publication rule. A `PreferencesPointerV1` contains `{ format: 'lumina-runtime-preferences-head', version: 1, migrationId, candidateKey, preferencesPath: 'candidates/<candidateKey>.json', preferencesFormat: 'lumina-runtime-preferences', preferencesVersion, preferencesSha256, preferencesOwner: { format: 'lumina-runtime-preferences-owner', version: 1, ownerId, storageModeEpoch } }`. Its IDs are opaque selectors, its digest covers the complete preference bytes, and it contains no setting object or secret. The owner object is generated for this #46 target and copied into the permanent active record with the same epoch. Ordinary preference clients resolve it only after the final active transaction has written that matching `PermanentActiveOwnershipV1.settings` attachment; they require the exact owner object, target, vault-marker, ownership, and epoch checks above. Later runtime preference writes preserve the owner object while updating the pointer/target through `DurableFileOps`; the original immutable candidate remains retained as report evidence until the binding/report retention window expires.

With explicit one-time user approval, #46 transfers `SETTINGS_SECRET_PATHS` through one deterministic private `lumina-platform-vault-entry-v1` namespace. `runtimeIdentity` is exactly the opaque, non-secret installation ID held in runtime identity metadata solely to retain stable runtime identity; it is not a payload path, collection name, migration selector, or credential. #46 computes `collectionDigest` as the RFC 8785 digest of `{ format: 'lumina-platform-vault-collection', version: 1, runtimeIdentity: <exact stable installation ID string> }`. This v1 collection is authoritative: Windows uses `Lumina/v1/<collectionDigest>/<suffix>` as the Credential Manager target name; macOS uses `com.lumina.runtime.credentials.v1.<collectionDigest>` as the Keychain service and `<suffix>` as its account. The derived collection digest, physical target/account names, marker bodies, entry digests, and index bodies stay inside the selected OS vault. `candidateKey` remains an opaque selector in the binding/report, but its derived physical vault prefix and every entry/index name remain in that vault. None of those derived physical values enters runtime identity metadata, a report, a binding, a preference file, diagnostics, or logs.

The earlier `Lumina/<installationId>/<entryId>` Credential Manager spelling and `com.lumina.runtime` Keychain service with `<installationId>/<entryId>` account are superseded pre-v1 names, not aliases. #46's source is the browser `settings-storage` record, so normal #46 preparation, read, update, delete, reset, rollback, preservation, activation, validation, and indexed cleanup must never probe, scan, mutate, or fall back to those legacy names. They remain untouched historical items; this ADR defines no automatic legacy-vault transfer, and a user needing an item from such a namespace must re-enter it into the current target under a separately approved operation. Every normal v1 operation first derives this one collection from the stable runtime identity and then uses only the exact v1 fixed marker, candidate prefix, and index-derived names; a namespace/identity mismatch fails closed before any credential mutation.

A location change, upgrade, Repair, or data-preserving reinstall must retain and validate the same stable runtime identity before opening the vault, so it computes the same `collectionDigest` and addresses the same v1 entries regardless of the payload path. Missing, malformed, or changed identity metadata is `vault_namespace_identity_invalid`: Repair must restore the known identity or require credential re-entry, and must not create a new collection, scan an existing vault, or fall back to a legacy name. Only the explicit "delete all Lumina data" action may remove the stable identity and its v1 collection, using the fixed marker and candidate indexes' direct names; a later fresh install then creates a new stable identity and a different collection. This rule makes ordinary read/update/reset/rollback, recovery preservation, and indexed cleanup address the same deterministic entries across repair and reinstall.

Each source secret expands to exactly one logical `VaultSecretLocatorV1` with `{ format: 'lumina-platform-vault-slot', version: 1, family, providerId?: string, field }`. The physical entry suffix is `candidate/<candidateKey>/entry/<entryDigest>`, where `entryDigest` is the RFC 8785 digest of `{ format: 'lumina-platform-vault-entry', version: 1, collectionDigest, locator }`. The source-to-locator mapping is fixed as follows:

| `SETTINGS_SECRET_PATHS` source | `family` | `providerId` | `field` |
| --- | --- | --- | --- |
| `openAiImageApi.apiKey` | `openai-image-api` | omitted | `api-key` |
| `chaomoImageApi.apiKey` | `chaomo-image-api` | omitted | `api-key` |
| `additionalImageApis.*.apiKey` | `additional-image-api` | exact item `id` | `api-key` |
| `customImageApis.*.apiKey` | `custom-image-api` | exact item `id` | `api-key` |
| `textApis.*.apiKey` | `text-api` | exact item `id` | `api-key` |
| `videoApis.*.apiKey` | `video-api` | exact item `id` | `api-key` |
| `externalAgentConnection.token` | `external-agent-connection` | omitted | `token` |
| `webDav.username` | `webdav` | omitted | `username` |
| `webDav.password` | `webdav` | omitted | `password` |

For a wildcard path, each object that owns an `apiKey` property must have a non-empty string `id`; IDs must be unique within that exact family. The string is used exactly as represented by RFC 8785: no array index, trim, case, locale, NFC/NFD, or other normalization participates in the locator. A missing, non-string, duplicate, or uncanonicalizable ID, or a non-string source secret value, fails preflight with `settings_credential_mapping_failed` before any target is prepared. An absent secret property creates no physical entry. The selected vault is the only place where an entry's existence is observable.

Every candidate also has a value-free, in-vault locator index. It solves cleanup without a Credential Manager/Keychain collection scan and is itself never copied outside the selected OS vault. Before writing any secret, preparation derives every locator permitted by the sanitized preferences candidate (including each configured wildcard provider ID) and creates the immutable canonical `candidate/<candidateKey>/entry-index-seed`:

~~~ts
type VaultCandidateIndexSeedV1 = {
  format: 'lumina-platform-vault-candidate-index-seed';
  version: 1;
  migrationId: string;
  candidateKey: string;
  mapping: 'lumina-platform-vault-entry-v1';
  entryDigests: readonly string[];
};

type VaultCandidateEntryIndexV1 = {
  format: 'lumina-platform-vault-candidate-entry-index';
  version: 1;
  seedSha256: string;
  generation: number;
  state: 'ready' | 'resetting' | 'reset' | 'cleanup-pending' | 'cleaned';
  entryDigests: readonly string[];
};
~~~

`entryDigests` is UTF-8-byte sorted, duplicate-free, and contains every slot that the candidate permits, whether or not its source secret was present. It therefore carries no value, source path, source-presence bit, or per-entry existence state. The seed digest is `RFC8785-JCS-SHA256-v1` over the complete seed value; the mutable `candidate/<candidateKey>/entry-index` is also canonical and begins with exactly that set, `generation: 1`, and `state: 'ready'`. A candidate-local vault maintenance lock serializes index changes. Its compare-and-swap requires the current `seedSha256` and `generation`, atomically replaces that one physical index item with the next generation, and reports a conflict before any entry write; a vault adapter that cannot provide that item-level behavior is not a valid #46 target. A prepared marker requires `ready`; an active marker permits `ready` or `reset`; `resetting`, `cleanup-pending`, and `cleaned` cannot attach an active candidate. Preparation atomically writes/rechecks both index records before any candidate-private secret entry; it writes an entry only when its digest is already in the current index. A later ordinary `update(locator, value)` may add a newly permitted locator only by compare-and-swap extending the current index first, preserving `seedSha256`, then writing/verifying the secret entry. `delete` and `reset` never remove a digest from the index. Thus a crash cannot leave a candidate-prefixed secret that is absent from the durable in-vault locator set.

The vault adapter exposes no collection/prefix enumeration to this protocol. It derives each physical `entry/<entryDigest>` name from the bound candidate and exact index member. Before the current index exists, the protocol can query only the exact seed/index/prepared-marker names: all absent is the idempotent `not_prepared` result, and a seed without a current index may be removed as a non-secret incomplete preparation because no entry write can precede that index. Once a current index exists, a missing, malformed, mismatched-with-seed/marker, or duplicate-containing index is `vault_cleanup_index_invalid`: it blocks cleanup/activation and preserves the named candidate for maintenance; it never authorizes a best-effort scan or deletion of another candidate. A prepared marker without its matching index is the same terminal corruption.

The collection has one fixed `active-marker` suffix and one candidate-private `candidate/<candidateKey>/prepared-marker` suffix. A marker is canonical `VaultCredentialMarkerV1` with `{ format: 'lumina-platform-vault-marker', version: 1, state: 'prepared' | 'active', migrationId, candidateKey, mapping: 'lumina-platform-vault-entry-v1', indexSeedSha256, priorActiveMarkerSha256 }`; it contains no value, source path, source-presence bit, entry ID, or mutable-index digest. The initial prior marker is the canonical `{ format: 'lumina-platform-vault-empty-marker', version: 1 }`. During preparation the coordinator first writes/rechecks the index seed/current index, then writes each candidate-private entry and validates its exact private readback, then writes the prepared marker only after all such writes succeed. A replay of the same `(migrationId, candidateKey, locator)` with the exact same private value is `already_prepared`; a different value, locator, index seed, or marker for that key is a candidate collision and fails without overwriting it. The runtime probe takes the expected marker digest/state and expected index seed, validates that exact private marker and matching in-vault index, and returns only `validated` or a failure class. It never returns a value, entry ID, count, source path, index body, or source-presence information. The prior active marker remains unchanged while the candidate is prepared.

Activation validates the prepared marker, `indexSeedSha256`, current index, and `priorActiveMarkerSha256`, then replaces only the fixed `active-marker` with the bound canonical `active` marker in one platform credential-item update; candidate values need no copy because the active marker selects their private prefix. If that fixed item already has the exact target digest, activation is an idempotent no-op; any other digest is the table's terminal mismatch. The binding carries the exact prior and target active-marker digests, and `PermanentActiveOwnershipV1.settings.vaultActiveMarkerSha256` carries the target digest after compaction. An ordinary runtime resolves the collection from stable runtime identity, reads only its fixed active marker, verifies that digest against the active binding or permanent record, derives the selected candidate entry from the locator, and accesses the candidate index only for mutation or cleanup. It never scans a vault collection or consults browser settings.

`read(locator)` is permitted only after that attachment check and returns the selected platform value to the local credential consumer or `credential_not_configured` when its exact entry is absent; it never falls back to IndexedDB. `update(locator, value)` first proves that the locator is allowed by the current sanitized preferences, atomically extends the in-vault index first when needed, then replaces only its selected active entry and verifies private readback before reporting success; repeating the same locator/value is a success with no second entry. `delete(locator)` removes only that derived active entry and proves it absent but retains its digest in the index; deleting an absent entry is a successful no-op.

`reset()` and candidate rollback use the same indexed deletion protocol, so their result does not depend on a provider configuration still existing in current preferences. Under the candidate-local vault maintenance lock, they reread the bound marker, immutable seed, and current index; compare-and-swap its state to `resetting` or `cleanup-pending`; delete exactly the UTF-8-sorted `entry/<entryDigest>` values listed there; and privately verify every listed entry is absent. `reset()` then atomically records `state: 'reset'` and leaves the selected active marker, seed/index, and non-secret preferences intact. It records only a value-free in-vault receipt `{ format: 'lumina-platform-vault-cleanup-receipt', version: 1, migrationId, candidateKey, seedSha256, action: 'reset' | 'rollback' | 'abandon', result: 'all_indexed_entries_absent', completedAt }`; the receipt has no entry IDs, values, source path, source-presence bit, or secret-derived hash. A rollback/abandon first restores the bound prior fixed marker when needed, then also removes the named prepared marker, marks the index `cleaned`, and keeps the seed/index/receipt only as candidate-local maintenance evidence until its matching quarantine/control cleanup is complete.

Every delete/recheck is idempotent. A crash after the index state change or after any individual delete resumes from that exact index and repeats only the named absence checks; a missing/mismatched index or receipt is terminal `vault_cleanup_index_invalid`, not a permission to enumerate the collection. The caller may record only the value-free result class `cleaned` outside the vault after revalidating the receipt. These operations never modify a prior candidate's prefix. Before the #46 ownership commit cleanup uses this protocol for the named prepared candidate; after a pending/failed activation it restores the bound prior active marker first, then uses it for that same candidate. Declining a transfer requires re-entry in the new target. Raw secrets, raw settings, secret-presence flags, secret-derived hashes, entry digests, and index bodies never enter staging, project files, ordinary exports, diagnostics, reports, fingerprints, or logs.

The #46 candidate's one immutable `staging/<candidateKey>/publish.json` binds the same `migrationId`, report SHA-256, exact current `CatalogRevision`, target preferences version/SHA-256 and owner object, SHA-256 of the exact prior preferences pointer (or the versioned empty-pointer marker), SHA-256 of the target `PreferencesPointerV1`, selected vault platform and mapping version, plus the exact prior and target active-marker digests. The target preference SHA-256 is over the complete versioned preference-file bytes; the vault result says only that the candidate-scoped platform operation completed and can be resolved by the selected OS vault. No pointer may name that candidate until the matching pending IndexedDB binding exists. A failure before an immutable candidate exists uses the indexed cleanup protocol for only that candidate's provisional staging/vault records. Once immutable preference, publish, or report evidence exists, cleanup first obtains the in-vault `all_indexed_entries_absent` receipt for that candidate and removes its prepared marker, then writes and flushes its value-free failed-publication quarantine manifest for the named non-secret preference, publish, report, and staging payloads before it clears only the matching fence. It retains those non-secret payloads through the safety window; it does not immediately delete or promote them. Startup applies that same cleanup when it finds the matching settings fence with no binding. Settings remains browser-live; the runtime must not attach a mixed fallback preferences/credential adapter.

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
      mapping: 'lumina-platform-vault-entry-v1';
      preparedMarkerSha256: string;
      activeMarkerSha256: string;
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

After both provisional destinations validate, #46 performs the next `cutoverSchemaVersion` IndexedDB upgrade transaction. It advances `storageModeEpoch`, changes only `settings` from browser-live to frozen recovery evidence, retains the record without exposing it to ordinary clients, and atomically writes its full `pending` `CutoverBindingV1`. The pending binding must match the report, candidate digest, current catalog, expected epoch, source fence, prior/target preference-pointer digests, selected vault platform/mapping, and prior/target active-marker digests. This is the only point after which a candidate pointer may be published and browser settings writes may not resume.

Under the maintenance lease, activation is always ordered as follows: validate the exact pending binding and all targets; durably publish the named `PreferencesPointerV1`; replace the fixed vault active marker with the same candidate-scoped target marker; then atomically write that binding as `active` and its matching `PermanentActiveOwnershipV1.settings` attachment in IndexedDB `meta`. Each step is idempotent and ordinary clients attach neither preferences nor credentials until that final meta transaction is reread. Startup and the original holder must resolve every observable crash state with this table; they never select a file or vault collection by directory scan.

| Durable observation for the one bound `(migrationId, candidateKey)` | Required validation and action | Result |
| --- | --- | --- |
| Matching settings fence, no binding | The fence is the only selector. At any preparation phase, accept only the direct-name `not_prepared` result before a current index exists, or run indexed cleanup only for its candidate and require the value-free `all_indexed_entries_absent` receipt before removing its prepared marker/provisional paths. Each present immutable preference, publish, or report record must have the exact ID/key; a malformed one is retained only in this candidate's invalid quarantine, never promoted. When any immutable non-secret payload exists, write and flush that candidate's value-free quarantine manifest before clearing only that fence. | Settings remains browser-live; retry starts a new preparation. |
| `pending`; current preference pointer is the bound prior pointer; fixed active marker is the bound prior digest and the candidate marker is `prepared` | Validate binding/report/candidate/catalog/epoch, frozen source hash, preference format/version/SHA-256, target-pointer digest, exact prepared-marker probe, and matching in-vault seed/current index. Publish only the target pointer with `DurableFileOps`, then continue. | Resume at the next row's marker activation. |
| `pending`; current pointer is the exact target pointer; fixed active marker is the bound prior digest and the candidate marker is `prepared` | Revalidate the same predicates including the matching in-vault seed/current index, replace only the fixed active marker with the bound target marker, then atomically mark that binding `active` and write its matching permanent settings attachment. | Runtime preferences and credentials become attachable. |
| `pending`; current pointer is the exact target pointer; fixed active marker is the bound target digest | Revalidate the same predicates including the matching in-vault seed/current index, then atomically mark that binding `active` and write its matching permanent settings attachment. | Resume completes without a second pointer or vault write. |
| `active`; current pointer has the bound preferences owner; fixed active marker is the bound target digest and the permanent settings attachment matches | Revalidate the immutable initial preference candidate/report, binding/source predicates, and current owner-preserving pointer/target; remove only candidate transfer/staging control files. Retain the immutable initial candidate, active private prefix/marker, report, and binding for their stated retention. | Ordinary target remains active; later pointer updates keep the same owner. |
| Any other pointer, vault state, missing/mismatched report or candidate, wrong catalog/epoch/source hash, or extra object claiming the same migration ID while a matching binding exists | Mark only that binding `recovery_failed`, keep settings frozen, and expose no preferences or credentials. | Terminal maintenance repair; no browser writer or fallback is restored. |

The exact validation set in every non-cleanup row is: the immutable report and publish record have the same migration ID/candidate key/report SHA/candidate digest; the pending or active binding has the same scope, catalog, ownership, epoch, retention, pointer digests, target preferences owner, mapping version, platform, and prior/target active-marker digests; the frozen `settings-storage` record recomputes to `source.sha256`; the immutable initial `preferences/candidates/<candidateKey>.json` has the report's exact format/version/SHA-256; before activation `preferences/head.json` is either the bound prior pointer or the exact target pointer, while an active target has the bound preferences owner and a valid current target of its own declared version/SHA-256; the active permanent settings attachment has that same owner/epoch/marker; and the deterministic selected OS collection validates precisely the bound candidate marker plus its matching immutable seed and current value-free index in the stated `prepared` or `active` state without returning secret material. No partial pointer publication falls outside these branches: a pointer to a candidate with no matching pending/active binding is an invariant failure. It enters an unbound read-only maintenance state, does not synthesize or select a binding, and never permits ordinary attachment; operator repair must first prove the pointer's predecessor or preserve the evidence for manual repair.

`recovery_failed` is terminal for normal startup. Maintenance may retry the same candidate only after every failed predicate becomes true, or explicitly abandon exactly that candidate. Abandoning first restores the bound prior pointer through `DurableFileOps` and restores the bound prior fixed active marker only when their journals and bound prior digests validate. It then uses the candidate's index to obtain its `all_indexed_entries_absent` receipt and remove its prepared marker, writes and flushes its value-free quarantine manifest for the named non-secret preference candidate, staging files, publish control file, and report, and releases only that candidate control. In the same `meta` transaction that records the terminal failure, it replaces any active permanent settings attachment with `settings: null` and `storeOwnership.settings: 'frozen-recovery-failed'`, so no ordinary target can attach after rollback. A later user-approved repair prepares a new candidate from frozen evidence and writes a new permanent settings attachment only on its own active transition; it never reenables an IndexedDB settings writer. If either prior target cannot be proved, maintenance preserves the named evidence for operator repair rather than guessing, selecting, or deleting another candidate.

`lumina.runtime.maintenance.getSettingsMigrationReportV1(migrationId)` is a local maintenance-only endpoint, unavailable to MCP and ordinary settings clients. With the maintenance lease it returns `eligible` only when all of these predicates hold: the named immutable report validates; the matching binding is `active` with the same migration/key/candidate digest/catalog/epoch, pointer digests, active-marker digest, matching `recoveryRetainedUntil`, and frozen `settings` ownership; the immutable initial preference candidate has the report's exact format/version/SHA-256; the current preference pointer has the same bound owner and a valid current target; an OS-vault probe re-validates the same fixed active marker, immutable index seed, and current value-free index without returning values, entry IDs, or source-presence data; a fresh sanitized hash of the frozen `settings-storage` record equals `source.sha256`; the running runtime recognizes `recovery.compatibilityRelease`; and `now <= recovery.retainedUntil`. Its `unavailable` result identifies only the failed predicate class (`binding`, `report`, `pointer`, `preferences`, `vault`, `source_hash`, `compatibility`, or `retention`) and contains no settings, secret, vault-entry, index, or source-presence data. These predicates, report fields, pointer, vault validation, and binding are the frozen-settings ownership evidence required for a recovery test.

Acceptance tests must inject a crash after each preparation write, after the pending ownership commit, after preference-pointer publication, after fixed-marker activation, and after the active-binding/permanent-record transaction. Each restart must take exactly one table branch, resume idempotently or clean only its one candidate, and prove no ordinary client can read a partial target or write frozen settings. They must also prove wildcard provider IDs produce stable distinct entry digests, duplicate/malformed IDs reject before target preparation, and a failed candidate deletes only its indexed private entries while retaining its non-secret quarantine. The vault fake must make collection/prefix enumeration throw: remove a provider configuration from current preferences after preparation, crash after any indexed deletion, restart, and prove `reset`, rollback, and abandon delete/recheck every indexed candidate entry by direct derived name, preserve the value-free in-vault cleanup receipt, and never call enumeration. A data-preserving v1 upgrade, payload relocation, Repair, and reinstall fixture must retain the exact installation ID and thereby use the same v1 collection/marker/index names; missing or changed identity metadata must fail with `vault_namespace_identity_invalid` without creating, scanning, or falling back to a collection, while a legacy-form target stays untouched. Read/update/delete/reset must touch only the currently selected prefix; an update must index a new allowed locator before its value write. They must fabricate a candidate pointer without a binding and prove the unbound maintenance state attaches no target. A crash or timeout before the final #46 transaction leaves settings browser-live after exact cleanup; after it commits, settings cannot regain an IndexedDB writer. A settings recovery action may compare the frozen record, rebuild a new candidate, or perform a user-approved credential re-entry through the platform vault, but it never attaches the frozen record as the normal settings adapter or silently retransfers a credential. Normal clients then receive the same non-retryable `frozen_store_write` rejection for settings writes. At report expiry, maintenance first validates and retains `PermanentActiveOwnershipV1.settings`, a live preferences pointer with its matching owner and valid target, and the deterministic fixed active marker; it may then remove only the named report and binding. The permanent record, active vault prefix/marker/index, preferences, and frozen settings evidence remain, so normal attachment never depends on expired recovery evidence.

### Ownership epoch and runtime revision fencing

`storageModeEpoch` fences browser-store ownership and stale tabs; it is not a project or catalog revision. A #45 client coordinates the ownership epoch with the runtime before attaching file adapters, but every project mutation still carries its independent expected project revision and `CatalogRevision` through `applyProjectMutation` or `applyLibraryTransaction`. An epoch mismatch requires adapter teardown and ownership recheck; a stale project or catalog revision rejects the requested runtime mutation before library-head publication. Conversely, the #46 settings epoch transition does not change a project revision or authorize a project mutation. The two fences are therefore coordinated at client attachment and recovery, but neither substitutes for the other.

## Authorization and downstream clients

Changing data location does not relax MCP controls. The current bridge keeps its existing browser-backed authorization behavior until #43-#45 land. #45 changes only project/history/asset ownership; settings remain browser-live until #46 and are not exposed to MCP in either stage. In the target runtime, the bridge resolves project data through the command/interface seam above and does not receive raw filesystem access. Opening or reconnecting remains read-only; write, import and run authorization remain separate explicit grants. MCP change sets must carry projectId and an expected revision and call `applyProjectMutation`; an authorized `.lumina` import calls `applyLibraryTransaction` with its expected catalog revision and one persisted operation ID. On reconnect it calls `reconcileLibraryTransaction`, never a blind import retry. Neither calls the legacy revisionless convenience methods. A stale revision or catalog is rejected before library-head publication, and disconnect, timeout, token rotation, runtime restart and repair never replay a mutation or billable generation.

An MCP App widget is a downstream proof of concept. It may render a client of this runtime-owned project library only after its own host, authorization and lifecycle questions are tested. It is neither a prerequisite for this migration nor an alternative storage owner.

## Consequences

Today, browser IndexedDB and its browser-only tests remain the current durable behavior at the registered Origin. When #43-#45 implement migration, only `projects`, `history`, and `assets` are read sources before the #45 cutover and then freeze as recovery evidence; the browser settings record remains live. #46 separately migrates non-secret preferences and provider credentials/tokens before freezing `settings`. New work must not claim that either cutover has already happened. Once the target ships, upgrade, Repair, reinstall and ordinary uninstall acceptance must prove the managed library, preferences and credential vault preservation independently of a Chrome profile or registered Origin. The stable Origin remains an entry, bridge and compatibility concern; it does not select the target project library.

This ADR specifies the durable architecture only. It does not implement the filesystem module, browser or HTTP adapters, IndexedDB migration, settings vault, installer changes, or MCP App widget.
