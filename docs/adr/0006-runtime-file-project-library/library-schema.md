---
status: accepted
parent: ../0006-runtime-file-project-library.md
---

# 运行时文件项目库：结构与完整性

> **权威范围**：根目录、数据边界、版本化布局、路径验证、规范字节与摘要 本文中的规范性条款是 ADR-0006 对该主题的唯一权威来源；根 ADR 只保留决定、状态、历史和导航索引。

## 根目录与数据分类

目标运行时将根据安装身份选择以下按用户管理的位置；安装 payload 本身从不成为数据根，也不因用户选择安装目录而改变项目库位置。这些根是 #43-#46 的交付契约，不表示当前安装包已经创建它们。

| 类别 | Windows | macOS | 内容与保留规则 |
| --- | --- | --- | --- |
| 安装 payload | 用户选择的安装目录 | Lumina.app 的安装目标卷 | 只有已签名 runtime 和静态资源；升级或 Repair 可以替换它。 |
| 运行时身份元数据 | %APPDATA%\Lumina\runtime\ | ~/Library/Application Support/Lumina/runtime/ | installation ID、实际 runtime 路径、注册 Origin、bridge 兼容线，以及只用于定位的项目库 ID/root reference。它不保存项目/资产 ID 或哈希、每 store 归属、`storageModeEpoch`、attachment selector/digest、迁移 selector 或证据、设置、凭据，或任何秘密。每 store 归属控制、epoch 和迁移绑定在 IndexedDB `meta` 协调记录中；与其匹配的非秘密 runtime attachment/root identity 仅在文件项目库中；完整迁移证据也仅在文件项目库中。 |
| Lumina 项目库 | %LOCALAPPDATA%\Lumina\library\ | ~/Library/Application Support/Lumina/library/ | 项目快照、历史、资产、staging、删除恢复数据，以及非秘密的运行时项目库 attachment/root identity 记录。它是项目事实源。 |
| 非秘密偏好 | %LOCALAPPDATA%\Lumina\preferences\ | ~/Library/Application Support/Lumina/preferences/ | 版本化设置快照，排除所有秘密路径。 |
| 凭据库 | Windows Credential Manager，目标名 `Lumina/v1/<collectionDigest>/<suffix>` | Keychain，service 为 `com.lumina.runtime.credentials.v1.<collectionDigest>`，account 为 `<suffix>` | provider API key、外部 Agent token 和 WebDAV 凭据；#46 定义的 v1 collection 是唯一权威命名空间，不写入普通文件。 |
| Gateway 临时状态 | %LOCALAPPDATA%\Lumina\gateway\ | ~/Library/Application Support/Lumina/gateway/ | 有界任务映射和临时介质；按 Gateway 现有 TTL 清理，不是项目资产。 |
| 运行日志 | %LOCALAPPDATA%\Lumina\logs\ | ~/Library/Logs/Lumina/ | 受保留期约束的脱敏运行日志。 |

运行时身份元数据可以引用项目库 ID 和已选择的根，但项目库不依赖安装 payload 的绝对路径。普通升级、Repair 和保留数据的重装必须复用这些根。普通卸载保留项目库、非秘密偏好、凭据库和身份元数据；只有明确的“删除所有 Lumina 数据”操作才可删除它们。卸载可移除 payload、过期 Gateway 临时状态和日志，但不得把这些清理伪装成项目删除。

## 版本化项目库布局

所有 JSON 使用 UTF-8，并由 library.json 和每个快照 manifest 的 format、version 与 SHA-256 绑定。逻辑 `projectId`、`assetId`、archive entry path、project name、revision 和所有客户端输入都不是文件系统路径，绝不传给路径构造函数。

每一个物理路径段使用运行时生成的 `LibraryKey`，而不是逻辑 ID。v1 key 由 CSPRNG 生成 128 bit，写入前在库写 lease 下检查唯一性，并严格匹配 `^[pabsctrd]_[0-9a-f]{32}$`：`p` project、`a` asset、`b` attachment/binding、`s` snapshot、`c` commit、`t` transaction、`r` recovery、`d` deletion。唯一例外是内容寻址的 SHA-256 文件名段；它只能是对已验证目标字节重新计算出的严格小写 `[0-9a-f]{64}`，绝不来自调用方或逻辑 ID。读取磁盘时先以 strict UTF-8 解码并验证该语法，再构造路径；因此非 ASCII、无效 UTF-8 或 Unicode 规范化变化、`.`/`..`、`/`、`\\`、绝对路径、盘符、UNC、冒号和 Windows 保留名都不能成为路径段。该 ASCII 语法也使 NFC/NFD 在 macOS 上没有等价但不同的 key。

Catalog 的 `projectKey`、`snapshotKey`、`assetKey` 和所有 control-record ID 必须通过该验证；`manifestPath`、`metadataPath` 和 `bytesPath` 由这些 key 和已验证的内容 digest 按下述固定模板生成，读取时必须与生成结果完全相等。特别是 `metadataPath` 必须是 `assets/<assetKey>/metadata/<metadataSha256>.json`，而不是可变的 `metadata.json`。实现还必须在 canonical managed root 下解析生成路径、拒绝路径上的 symlink、junction 或 reparse point，并在创建前后验证结果仍在该 root 内。不存在 `join(root, projectId)`、archive path 或任何调用方字符串的合法实现。

~~~text
library/
  library.json
  head.json
  head.previous.json
  control/
    import-operation-ledger.json
  commits/
    <commitId>.json
  attachments/
    <attachmentKey>.json
  migrations/
    <transactionId>.json
  maintenance/
    <transactionId>/
      gc.json
      cleanup.json
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
      metadata/
        <metadataSha256>.json
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
      cleanup.json
      expiry.json
      projects/
      assets/
~~~

`library.json` identifies format `lumina-library`, version 1, a `libraryId`, an immutable CSPRNG `libraryRootId`, and an immutable 128-bit lowercase-hex `importOperationNamespace`. It contains no project bodies, settings or secrets. `control/import-operation-ledger.json` is the one durable, canonical, non-secret high-water record for that namespace; it is never a normal-reader project discovery path. `head.json` is the only normal-reader visibility pointer: it names exactly one immutable `commits/<commitId>.json`, that commit's SHA-256, and its previous commit ID. `head.previous.json` is a maintenance-only byte-identical copy of the last durably visible head written before a replacement; normal readers never consult it. It exists solely to restore that validated prior catalog if a host/power failure leaves the new root directory entry absent or unreadable. A commit is a complete catalog, not a delta: it contains the sorted visible `projectId -> projectKey/snapshot manifest/revision/SHA-256` map, the sorted visible `assetId -> assetKey/metadata format/version/content-addressed path/digest/byte path/byteCount/SHA-256` map, its one immutable runtime-library attachment reference, and the bounded, unexpired import-reconciliation receipts described below. `attachments/<attachmentKey>.json` is a non-secret immutable attachment/root identity record addressed by a `b_` LibraryKey. `migrations/<transactionId>.json` is immutable migration evidence addressed by a `t_` LibraryKey; it is maintenance-only, is never discovered by normal readers, and may contain the complete project/asset fingerprint required below. `quarantine/<transactionId>/` contains a failed-publication manifest and later cleanup receipt; it is maintenance-only, never a recovery reader or promotion source. Readers pin one valid library head before resolving any project, history or asset; they never discover live facts by scanning `projects/`, `assets/`, `attachments/`, `migrations/`, `staging/`, `quarantine/` or `control/`.

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
  "runtimeAttachment": null,
  "projects": [
    { "projectId": "<logical ProjectRecord.id>", "projectKey": "<runtime p_ key>", "snapshotKey": "<runtime s_ key>", "revision": "<logical revision>", "manifestPath": "projects/<p_ key>/snapshots/<s_ key>/manifest.json", "manifestSha256": "<hash>" }
  ],
  "assets": [
    { "assetId": "<logical AssetMetadata.assetId>", "assetKey": "<runtime a_ key>", "metadataFormat": "lumina-library-asset-metadata", "metadataVersion": 1, "metadataPath": "assets/<a_ key>/metadata/<metadataSha256>.json", "metadataSha256": "<SHA-256 of exact metadata bytes>", "bytesPath": "assets/<a_ key>/bytes.bin", "byteCount": "<safe integer>", "bytesSha256": "<hash>" }
  ],
  "completedImports": [
    {
      "receipt": {
        "format": "lumina-library-completed-import-receipt",
        "version": 1,
        "operationId": "<runtime li_<namespace>_<sequence> ID>",
        "requestSha256": "<SHA-256 of the versioned import request fingerprint>",
        "publishedCommitId": "<runtime c_ key>",
        "publishedSequence": "<safe integer>",
        "publishedCatalogContentSha256": "<SHA-256 of the receipt-excluded catalog content domain>",
        "publishedAt": "<Unix epoch milliseconds>",
        "retainedUntil": "<publishedAt plus 30 days>",
        "projects": [
          { "sourceProjectId": "<archive project ID>", "targetProjectId": "<allocated project ID>", "revision": "<target revision>" }
        ],
        "assets": [
          { "sourceAssetId": "<archive asset ID>", "targetAssetId": "<allocated asset ID>", "sourceProjectId": "<archive owner ID>", "targetProjectId": "<allocated owner ID>" }
        ]
      },
      "receiptSha256": "<SHA-256 of the exact receipt object only>"
    }
  ]
}
~~~

project.json has the portable project document shape already used by .lumina exports: schemaVersion, id, name, createdAt, updatedAt, nodeCount, revision, nodes, edges and viewport. It maps the current ProjectRecord fields nodesJson, edgesJson and viewportJson to their parsed JSON values. history.json maps historyJson. The snapshot manifest records `recovery` as either the current ProjectRecovery value or null and points to any preserved recovery files. The ProjectSummaryRecord fields are derived from project.json rather than duplicated in a separate index.

Each `metadataPath` names one immutable canonical `AssetMetadataDocumentV1`: `{ format: 'lumina-library-asset-metadata', version: 1, metadata: { assetId, projectId, kind, mimeType, byteCount, createdAt, sourceKind, width, height, durationMs, sourceMetadata, lifecycleState } }`. `metadataSha256` is the `RFC8785-JCS-SHA256-v1` digest of those exact document bytes, and its final path must use the same digest. A catalog entry is invalid unless its declared format/version, path, digest, `assetKey`, asset ID, byte count, and bytes digest all agree with that immutable document and Blob. `bytes.bin` is the corresponding immutable Blob byte sequence; the catalog records its byte count and SHA-256. Object URLs remain process-local display leases and never enter this layout.

Current credential-free stable task handles remain inside nodes and retained history, including generationJobId, generationTaskHandle, generationProviderRequestId and generationRecoveryState. A task handle may retain its validated opaque provider identity and callback shape, but project files never contain an API key, authorization header, Gateway task map, temporary media bytes or a provider response. A handle whose temporary backing state no longer exists becomes interrupted or attention-required and is never resubmitted automatically.

When a project cannot be migrated or validated, recovery records preserve the source project and history bytes, the observed schema version, and one of the existing reasons unsupported_schema or migration_failed. The runtime surfaces the corresponding ProjectRecord recovery state as read-only; export and deletion remain available. No recovery record authorizes a best-effort rewrite of unknown project data.

The .lumina archive remains the portable project format. Its versioned manifest, allowlisted paths, project/history JSON, referenced assets, metadata, byte counts and SHA-256 checks remain the interchange contract. The current `lumina-project-export` version 1 implementation emits and reads only uncompressed ZIP32: `storedZip.ts` uses 32-bit size/offset fields and `luminaProjectImportArchive.ts` reads the complete Blob into one `Uint8Array`. It therefore cannot read or write ZIP64, and its theoretical 4,294,967,295-byte ZIP32 container bound is not a safe current user-facing archive size because whole-Blob memory and browser quota fail earlier. Current `src/features/assets/application/luminaProjectExport.ts` removes named sensitive fields and gateway-like URL values, but it does **not** implement the complete `lumina-settings-credential-free-v1` URL rule. In particular, it is not current evidence that ordinary archives remove arbitrary URL userinfo, fragments, or `api_key`/`key` query values. Current ordinary exports therefore exclude preferences, Credential Manager or Keychain entries, Gateway state, logs and installation metadata, but must not be described as already proving full secret-bearing URL exclusion.

#46 must make the target ordinary-export path apply the same versioned `lumina-settings-credential-free-v1` sanitizer to every serializable `baseUrl` or `url` property in project JSON, retained history and asset source metadata before archive hashes are calculated. The target rejects an unparseable such value with `ordinary_export_sanitization_failed` and emits no archive; it never falls back to serializing the original string. Its acceptance fixtures must put userinfo, fragments, duplicate mixed-case `api_key`, `apikey`, `key`, `token`, `access_token`, `password` and `secret` query parameters in those fields, then decode every archive entry and assert that only the v1-sanitized URLs remain. A malformed `baseUrl` or `url` fixture must fail closed, and the resulting archive bytes, manifest hashes and error/report payloads must contain no source secret.

### Project-fact admission and resource limits

[`admission-registry-v1.json`](./admission-registry-v1.json) is the sole versioned, machine-readable authority for v1 admitted source records, project/history documents, node variants, edge data, `AssetMetadata`, `sourceMetadata`, provider parameters, MIME grammar, unknown-member behavior, normalization, secret handling, and numeric limits. An implementation must load that exact format/version, reject a duplicate/unknown field or node type, and reject a registry version it does not implement. The registry is intentionally closed: TypeScript index signatures and the current source adapters do not authorize an unlisted persisted field. Any later field, MIME, node type, size, or sanitization rule requires a new registry version and a new admission path; it cannot be accepted as an untyped compatibility pass-through.

The v1 limit values are exact and apply before canonical hashing, byte staging, transfer acknowledgement, or durable publication. A direct streamed target `AssetRepository.write` admits at most `2,147,483,648` bytes (2 GiB) for one durable asset. One target `.lumina` import admits at most 64 projects, 256 assets, and `6,442,450,944` bytes (6 GiB) summed over admitted asset byte counts; its streamed archive envelope is at most `8,589,934,592` bytes (8 GiB). The target runtime accepts a ZIP32 or ZIP64 container around the unchanged versioned `.lumina` manifest, but an envelope above `4,294,967,295` bytes is valid only as ZIP64 and must stream every entry; it never calls `Blob.arrayBuffer()` for that path. One `AssetMetadataDocumentV1` is at most `65,536` bytes, an archive manifest is at most `4,194,304` bytes, an admitted project document is at most `4,194,304` bytes, and its retained history document is at most `16,777,216` bytes. A browser compatibility path that verifies a legacy ZIP32 archive by first calling `Blob.arrayBuffer()` has its separate `536,870,912`-byte (512 MiB) envelope ceiling and rejects with `browser_buffered_archive_too_large` before allocating that buffer. The target runtime archive importer/exporter instead streams every archive entry and may use the 8 GiB envelope limit; it must not use the current whole-Blob `arrayBuffer()` implementation as evidence that this target is already delivered. The migration coordinator likewise admits at most 8 GiB summed across all canonical JSON and raw Blob frame payloads for one candidate. JSON frame payloads are at most 1 MiB, raw Blob chunks at most 4 MiB, canonical headers at most 64 KiB, and a complete frame at most `4,259,840` bytes; a limit error uses the exact registry error code and leaves no candidate, source fingerprint, or partial target fact.

These are intentionally target bounds, not a false description of current browser persistence. Today `indexedDbAssetRepository` writes the supplied Blob and records `blob.size`; browser image/media import first uses the quota-aware reservation gate, but has no static durable-asset ceiling. The current archive verifier and exporter buffer whole archive or asset values with `arrayBuffer()`, and the current ZIP32 writer/parser additionally reject a size or offset above `4,294,967,295`; neither fact establishes a safe static browser archive admission limit. The 2 GiB v1 cap is therefore a conservative product/runtime limit for streamed, same-volume staging and restartable recovery, not a filesystem maximum and not a claim that every current browser profile accepts 2 GiB. It admits one 2 GiB direct local MP4/WebM/MOV/MKV/AVI/MPEG asset and any allowed combination up to 6 GiB in one streamed import, rather than reducing local video to the Gateway's temporary ceiling. The 8 GiB envelope covers the maximum admitted assets plus the bounded project/history/metadata/manifest records and container overhead. It preserves the current image-output `image/svg+xml` form and the registry's audio allowlist when the target client can inspect or retain them; a larger professional asset must be split or use a later versioned limit increase.

`64 * 1024 * 1024` (`67,108,864` bytes) remains only the current GenerationGateway temporary-media publish/transcode ceiling in `gateway/server.mjs` and `browserMediaGateway.ts`. It applies to a temporary provider copy and its converted output, not to an IndexedDB Blob, a durable file-library asset, a `.lumina` archive, or a browser-to-runtime migration frame. Gateway transcoding is not a durable-library admission fallback: a target direct asset write has the registry's exact lowercase MIME grammar and kind-specific allowlist, rejects empty/parameterized/`application/octet-stream`/unknown or kind-mismatched media as `unsupported_media_type`, and never sends an over-limit durable asset through Gateway merely to satisfy admission.

### Path-key verification

#43-#45 must test the path-key interface before any filesystem adapter is accepted. The tests construct paths only through the key validator and managed-root resolver, never through a test-only unsafe join.

- On Windows and macOS, valid `p_`, `a_`, `b_`, `s_`, `c_`, `t_`, `r_`, and `d_` keys produce their exact fixed relative paths under one managed root; logical project and asset IDs with arbitrary text cannot alter those paths.
- On both platforms, reject `.` and `..`, embedded or leading `/` and `\\`, `../`, `%2e%2e`, POSIX-rooted paths, Windows drive paths, UNC paths, `file:` paths, NUL/control characters, colon/alternate-data-stream syntax, trailing-dot or trailing-space segments, invalid UTF-8, non-ASCII input, and NFC/NFD-distinct Unicode input before any path is constructed.
- On Windows, reject every reserved basename and extension variant (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`) and verify no case-folded or trailing-dot/space spelling can bypass the key grammar.
- On macOS, assert that composed and decomposed forms of the same non-ASCII name are both rejected rather than normalized into one directory, and that an absolute or separator-bearing name cannot escape the root.
- On both platforms, place a symlink, junction, or reparse point in an existing candidate path and verify the resolver rejects it; a successful write and read must resolve beneath the canonical managed root. Archive entry paths continue to be validated by the `.lumina` importer and are never repurposed as library paths.

### Canonical bytes and digest preimages

`RFC8785-JCS-SHA256-v1` is a normative byte algorithm, not a label for an implementation's usual JSON serializer. It means: strictly UTF-8 decode one JSON value; reject a BOM, invalid UTF-8, duplicate object-member names, non-finite numbers, unpaired surrogate code units, and any value RFC 8785 cannot represent; apply only the field-specific defaults stated in this ADR; serialize with RFC 8785 JSON Canonicalization Scheme; UTF-8 encode that result with no BOM or trailing newline; then compute SHA-256 and render lowercase hexadecimal. No NFC/NFD, case, locale, timestamp, revision, path, or array normalization is implicit. A parser must detect duplicate names before constructing a host-language object, and an implementation must reject rather than silently use a last-member-wins parser.

Every file-library JSON document that carries or is named by an integrity digest (`head.json`, `head.previous.json`, commits, runtime attachments, snapshot manifests, recovery records, publish records, migration reports, completed-import receipts, quarantine manifests and cleanup receipts, trash manifests and their cleanup/expiry receipts, preference candidates, and preference pointers) is stored as those exact canonical UTF-8 bytes. On read, its original bytes must equal a fresh canonical serialization of the parsed value; otherwise it is corrupt. Portable `.lumina` input and current IndexedDB JSON strings are parsed as logical values and then written in this canonical target form. Blob bytes, archive bytes, and transfer chunk bytes instead use `raw-bytes-sha256`: SHA-256 of their exact byte sequence without decoding or normalization.

Arrays remain semantic order, so their order is part of every preimage. Where this ADR requires an order, IDs are ordered by their strict UTF-8 byte sequence with no Unicode normalization: project and asset evidence by ID, per-project owned asset IDs by asset ID, `completedImports` by operation ID, and source-to-target mappings by source ID. `CatalogRevision` always serializes all three fields in this order-independent canonical object: `commitId`, `sequence`, and `commitSha256`; an omitted field is not equivalent to a default.

| Digest field | Exact preimage |
| --- | --- |
| `commitSha256` | The full `lumina-library-commit` value stored at `commits/<commitId>.json`. The commit does not contain a self-hash field. |
| `completedImports[].receiptSha256` | The inner `receipt` value of one `completedImports` envelope only. `receiptSha256` is outside that preimage; `publishedCommitId`, `publishedSequence`, and `publishedCatalogContentSha256` are allocated before receipt hashing, while a published commit SHA-256 is never a receipt field. |
| `publishedCatalogContentSha256` | `{ format: 'lumina-library-import-catalog-content', version: 1, catalog: { format: 'lumina-library-commit', version: 1, commitId, previousCommitId, sequence, runtimeAttachment, projects, assets } }`. This preimage deliberately omits the entire `completedImports` array, including this and all prior envelopes. |
| `initialHeadSha256` | The full target `lumina-library-head` value stored at `head.json` for the initial catalog, including its `commitSha256` and `previousCommitId`. |
| `catalogDigest` | `{ format: 'lumina-library-catalog-revision', version: 1, catalog: <all three CatalogRevision fields> }`. It is distinct from the catalog file's `commitSha256`; every candidate, report, binding material, and reconciliation response that names a catalog carries both values. |
| `candidateDigest` | The full immutable `lumina-library-publish` `staging/<candidateKey>/publish.json` value. The publish record contains no candidate self-hash. |
| `reportSha256` | The full immutable migration or settings report value at `migrations/<candidateKey>.json`. The report contains no report self-hash. |
| `bindingSha256` | The `binding` value of the durable IndexedDB `lumina-cutover-binding-record` envelope. The envelope stores `{ format, version, binding, bindingSha256 }`; `bindingSha256` hashes only `binding`, never itself or envelope metadata. |
| `preferencesSha256` and preference-pointer digest | Respectively the full versioned preference-candidate value and the full `PreferencesPointerV1` value. The versioned empty-pointer marker is `{ format: 'lumina-runtime-preferences-empty-pointer', version: 1 }`. |
| `assets[].metadataSha256` | The full canonical `AssetMetadataDocumentV1` at that catalog entry's exact content-addressed `metadataPath`. Its `format`, `version`, `metadata.assetId`, `metadata.byteCount`, and `metadata.lifecycleState` must agree with that same entry; the digest is never taken from a mutable asset-key location. |
| `requestSha256`, `manifestSha256`, source fingerprint, frame header/payload hashes, and every admitted project/history/metadata hash | The exact versioned logical value stated at its use site, using this algorithm; a frame payload uses canonical JSON bytes or `raw-bytes-sha256` according to its descriptor. `requestSha256` and `manifestSha256` are never calculated from a raw archive/project/history/metadata value before `lumina-project-migration-admission-v1` has accepted or redacted it. |

An implementation must preserve the exact digested values in the immutable record that names them and recompute them before use. It must never calculate a digest from pretty-printed file bytes, a host object iteration order, an unversioned subset, a digest string with different casing, or a value after a second migration/default pass. A report or binding whose catalog revision and `catalogDigest` disagree is invalid before any source ownership change.
