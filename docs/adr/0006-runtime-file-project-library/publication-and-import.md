---
status: accepted
parent: ../0006-runtime-file-project-library.md
---

# 运行时文件项目库：发布、导入与保留

> **权威范围**：原子发布、并发、删除生命周期、隔离、保留/GC，以及浏览器导入操作 本文中的规范性条款是 ADR-0006 对该主题的唯一权威来源；根 ADR 只保留决定、状态、历史和导航索引。

## Publication, concurrency and recovery

The following is the target runtime publication contract. It uses one library-level commit for every mutation, including a single-project save, a viewport update, deletion and a multi-project .lumina import. The runtime prepares data beneath staging on the same volume as the final project library. It validates project JSON, schema versions, asset byte counts, MIME, every exact metadata format/version/content digest and snapshot hashes before publication. Staging assets use the existing staging lifecycle and are invisible to normal AssetRepository reads, metadata queries, Object URL hydration, deletion-candidate scans and exports.

Each `staging/<transactionId>/publish.json` is an immutable record with `format: "lumina-library-publish"`, `version: 1`, a runtime `transactionId`, operation kind (`project-mutation`, `library-import`, `migration` or `ownership-attachment`), its expected prior catalog revision, affected project expected revisions when applicable, new payload paths and checksums, and the intended full catalog commit ID, sequence and SHA-256. Each staged visible asset entry names its exact next `AssetMetadataDocumentV1` format/version/path/digest; a lifecycle change creates a new document rather than naming or replacing an earlier version. A `library-import` record additionally carries its runtime-allocated `operationId`, runtime-computed request fingerprint and complete source-to-target mappings, but that staging copy is never the authoritative reconciliation record: the identical bounded receipt is part of the published full catalog. An `ownership-attachment` record copies the exact project, asset and unexpired receipt maps from its pinned predecessor and changes only the immutable attachment reference and catalog revision. The commit catalog has a monotonic library sequence and no duplicate project or asset IDs; its project map, asset map and active import receipts are ordered by the UTF-8 byte order of their stable IDs. The head and commit SHA-256 values use the canonical JSON and digest rules defined in the migration evidence section below.

The runtime has a mandatory native `DurableFileOps` seam. It exposes `flushFile`, `atomicReplace`, and `syncDirectory`, and it reports `durability_unavailable` before a pointer change when the managed filesystem cannot provide their stated persistence semantics. On Windows, the implementation flushes each file with `FlushFileBuffers`, replaces an existing pointer with `ReplaceFileW` (or a same-volume `MoveFileExW` using `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` when no old pointer exists), and uses the platform's supported native parent/root metadata flush. On macOS, it flushes payload and pointer files with `fcntl(F_FULLFSYNC)` (falling back only to a documented `fsync` capability with the same tested guarantee), uses same-volume `renameat` for replacement, then `fsync`s every affected parent and the library root. The Windows directory/volume helper and the macOS helper are conformance-tested native implementations, not a best-effort JavaScript rename: their successful result means that a subsequent host/power failure leaves either the old valid head or the new valid head recoverable. A filesystem that cannot pass that fault-injection contract is not a writable library root.

The runtime holds its library write lease for final validation and publication, then performs this exact order:

1. Read and validate the current library head. A single-project mutation rechecks that project's expected revision. For a library import, first look up a retained receipt by its `operationId`: an exact request fingerprint returns that receipt without a second publication, while a different fingerprint returns `operation_mismatch`. A new import then requires its complete expected catalog revision to equal that head and allocates all target IDs while holding the lease. A mismatch returns `stale_revision` or `stale_catalog` before the visible catalog changes.
2. Flush all transaction payloads, project snapshots, immutable asset metadata versions/bytes, the complete immutable catalog and (for an import) its complete reconciliation receipt under staging. Verify every listed checksum, content-addressed metadata path and reference closure.
3. Materialize the verified immutable payloads, including each `assets/<assetKey>/metadata/<metadataSha256>.json`, any `attachments/<attachmentKey>.json`, and `commits/<commitId>.json` at their final paths. `DurableFileOps.flushFile` and `syncDirectory` must complete for every new file and each final parent up to the library root before the payload is eligible for a head pointer. An attachment is visible only through the catalog that names its exact path and digest; writing an attachment file alone is never an attachment activation.
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

type RuntimeCommandAction =
  | 'project-mutation'
  | 'project-delete'
  | 'project-restore'
  | 'asset-write'
  | 'asset-lifecycle'
  | 'asset-trash-restore'
  | 'library-import'
  | 'empty-trash';

type RuntimeCommandContext = Readonly<{
  /** One caller-generated lowercase UUID v4; retries use the same commandId. */
  commandId: string;
  /** The complete revision pinned from one validated head/catalog read. */
  expectedCatalog: CatalogRevision;
  authorization: {
    format: 'lumina-runtime-command-authorization';
    version: 1;
    action: RuntimeCommandAction;
    subject: { projectId?: string; assetId?: string; deletionId?: string };
    bridgeSessionId: string;
    issuedAt: number;
    expiresAt: number;
    /** Opaque authenticated proof, transport-only and never persisted or logged. */
    proof: string;
  };
}>;

type RuntimeProjectMutation =
  | { kind: 'saveSnapshot'; record: ProjectRecord }
  | { kind: 'updateViewport'; viewportJson: string }
  | { kind: 'rename'; name: string; updatedAt: number }
  | { kind: 'delete' }
  | { kind: 'restoreProject'; deletionId: string; trashManifestSha256: string };

applyProjectMutation({ context, projectId, expectedRevision, mutation }):
  Promise<
    | { code: 'applied'; revision: string; catalog: CatalogRevision }
    | { code: 'deleted'; catalog: CatalogRevision; deletionId: string; trashManifestSha256: string }
    | { code: 'restored'; projectId: string; revision: string; catalog: CatalogRevision }
    | { code: 'stale_catalog'; actualCatalog: CatalogRevision }
    | { code: 'stale_revision'; actualRevision: ExpectedProjectRevision }
    | { code: 'authorization_denied' }
    | { code: 'rejected'; reason: 'project_secret_admission_failed' }
  >;

writeRuntimeAsset({ context, projectId, expectedProjectRevision, input }):
  Promise<
    | { code: 'applied'; metadata: AssetMetadata; catalog: CatalogRevision }
    | { code: 'stale_catalog'; actualCatalog: CatalogRevision }
    | { code: 'stale_revision'; actualRevision: ExpectedProjectRevision }
    | { code: 'authorization_denied' }
    | { code: 'rejected'; reason: 'project_secret_admission_failed' | 'asset_too_large' | 'unsupported_media_type' }
  >;

type ImportOperationId = string;

type RuntimeLibraryTransactionReconciliation = {
  operationId: ImportOperationId;
  expectedCatalog: CatalogRevision;
};

type RuntimeLibraryImportAllocation = {
  allocationId: string;
  expectedCatalog: CatalogRevision;
};

allocateLibraryImportOperation({ context, allocation }):
  Promise<
    | { code: 'allocated'; operationId: ImportOperationId; allocationExpiresAt: number }
    | { code: 'stale_catalog'; actualCatalog: CatalogRevision }
    | { code: 'operation_mismatch'; operationId?: ImportOperationId }
    | { code: 'authorization_denied' }
    | { code: 'allocation_expired' }
  >;

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
  context: RuntimeCommandContext;
  /** Allocated by allocateLibraryImportOperation, never generated ad hoc by a caller. */
  operationId: ImportOperationId;
  expectedCatalog: CatalogRevision;
  archive: Blob;
};

applyLibraryTransaction(transaction: RuntimeLibraryTransaction):
  Promise<
    | AppliedLibraryImport
    | { code: 'stale_catalog'; actualCatalog: CatalogRevision }
    | { code: 'operation_mismatch'; operationId: ImportOperationId }
    | { code: 'operation_outcome_expired'; operationId: ImportOperationId }
    | { code: 'authorization_denied' }
    | { code: 'rejected'; reason: LuminaProjectImportErrorCode | 'project_secret_admission_failed' | 'import_asset_aggregate_too_large' | 'archive_envelope_too_large' | 'unsupported_media_type' }
  >;

reconcileLibraryTransaction(query: RuntimeLibraryTransactionReconciliation):
  Promise<
    | AppliedLibraryImport
    /** The validated head still equals expectedCatalog, so this operation was not published. */
    | { code: 'not_published'; catalog: CatalogRevision }
    | { code: 'operation_outcome_expired'; operationId: ImportOperationId }
    /** A damaged/contradictory ledger or catalog requires maintenance; never replay automatically. */
    | { code: 'unknown_outcome'; actualCatalog: CatalogRevision }
  >;

type AssetLifecyclePrecondition = Readonly<{
  expectedCatalog: CatalogRevision;
  expectedProjectRevision: ExpectedProjectRevision;
  /** Complete UTF-8-asset-ID-sorted non-staging asset state for this project. */
  expectedAssets: readonly {
    assetId: string;
    lifecycleState: 'active' | 'deletion-candidate';
    metadataSha256: string;
  }[];
}>;

type RuntimeAssetLifecycleMutation =
  | { kind: 'replaceDeletionCandidates'; projectId: string; candidateAssetIds: readonly string[] }
  | { kind: 'requestAssetDeletion'; projectId: string; assetId: string }
  | { kind: 'restoreDeletionCandidate'; projectId: string; assetId: string }
  | { kind: 'restoreAssetFromTrash'; deletionId: string; assetId: string; trashManifestSha256: string };

applyAssetLifecycleMutation({ context, precondition, mutation }):
  Promise<
    | { code: 'applied'; catalog: CatalogRevision }
    | { code: 'stale_catalog'; actualCatalog: CatalogRevision }
    | { code: 'stale_revision'; actualRevision: ExpectedProjectRevision }
    | { code: 'stale_asset_lifecycle'; actualCatalog: CatalogRevision }
    | { code: 'authorization_denied' }
    | { code: 'rejected'; reason: 'asset_still_reachable' | 'project_secret_admission_failed' }
  >;

emptyTrash({ context, deletionId, trashManifestSha256 }):
  Promise<
    | { code: 'cleanup_authorized'; cleanupSha256: string; catalog: CatalogRevision }
    | { code: 'cleanup_complete'; cleanupSha256: string; catalog: CatalogRevision }
    | { code: 'stale_catalog'; actualCatalog: CatalogRevision }
    | { code: 'authorization_denied' }
    | { code: 'rejected'; reason: 'trash_manifest_mismatch' | 'asset_still_reachable' }
  >;

type FrozenBrowserStoreWrite = {
  code: 'frozen_store_write';
  store: 'projects' | 'history' | 'assets' | 'settings';
  observedEpoch: number;
  retryable: false;
};

type WidgetWriteDenied = {
  code: 'widget_write_denied';
  retryable: false;
};
~~~

`CatalogRevision` is the exact value pinned from one validated `head.json` and its named catalog: all three fields must equal under the write lease. Every mutating public target call above carries `RuntimeCommandContext`; the runtime verifies its opaque bridge proof, action, exact subject, expiry, command ID, and complete expected catalog before it reads/stages a payload. `saveSnapshot`, `updateViewport`, and `rename` require `project-mutation`; `delete` requires `project-delete`; `restoreProject` requires `project-restore`; `writeRuntimeAsset` requires `asset-write`; candidate replacement/request/restore requires `asset-lifecycle`; `restoreAssetFromTrash` requires `asset-trash-restore`; archive allocation/publication requires `library-import`; and `emptyTrash` requires `empty-trash`. A duplicated `expectedCatalog` in an import or lifecycle precondition must byte-for-byte equal `context.expectedCatalog`. The runtime records only the command ID, action, result code, catalog revision, and expiry needed for idempotent response replay; it never persists or logs the proof. A stale catalog returns `stale_catalog` with the one current complete revision, a stale project/asset precondition returns its typed stale result, and an expired/missing/wrong-action/wrong-subject proof returns `authorization_denied` before staging. Browser adapters attempting a frozen IndexedDB store instead return the separate non-retryable `FrozenBrowserStoreWrite`; runtime file commands never pretend that result was a catalog conflict. A caller identified as an MCP App widget receives `WidgetWriteDenied` before authorization or staging until #48 supplies and independently accepts a widget write contract. That denial is a boundary, not a #45 release prerequisite.

`applyLibraryTransaction` is the sole target bulk command. The runtime, not an arbitrary client UUID, allocates every `ImportOperationId` from the permanent `control/import-operation-ledger.json` under the library write lease. Its exact canonical `LibraryImportOperationLedgerV1` value is `{ format: 'lumina-library-import-operation-ledger', version: 1, namespace: <library.json importOperationNamespace>, lastAllocatedSequence: <safe integer>, allocations: <allocationId-sorted active allocation records> }`; each active record is `{ allocationId, operationId, expectedCatalog, allocatedAt, expiresAt, state: 'allocated' | 'claimed' }`. An ID is exactly `li_<namespace>_<base-10 sequence>` with no leading zero. A caller first persists one lowercase UUID v4 `allocationId` beside its pending archive and calls `allocateLibraryImportOperation` with an import-authorized context. A matching still-live allocation returns the original ID; a different catalog/context is `operation_mismatch`. For a new allocation the runtime increments `lastAllocatedSequence`, writes and flushes the complete ledger before returning the ID, and only then accepts the first archive frame. A crash before that flush allocates nothing; a crash after it may leave a permanently consumed gap, which is intentional. An unclaimed allocation expires exactly 24 hours after `allocatedAt` and is removed only by an exact maintenance update; the high-water value never decreases. A claimed allocation remains until its terminal receipt is eligible for expiry. The active allocation list is capped at 128; capacity exhaustion rejects before a sequence increment.

On submission and reconciliation, the runtime parses the namespace/sequence, requires its namespace to equal `library.json`, and requires `1 <= sequence <= lastAllocatedSequence`. A sequence above the high water or malformed namespace is `operation_mismatch`; a consumed sequence with no live allocation or retained receipt is the non-retryable `operation_outcome_expired`, never a fresh import. Thus receipt compaction does not make an old logical import ID reusable. A lost allocation response is replayed by the same `allocationId` until its exact allocation expiry; after that the caller must explicitly authorize a new allocation and gets a higher ID. A lost publication response is replayed only by `reconcileLibraryTransaction` while its receipt exists. That logical ID is never a filesystem path. The runtime must run `lumina-project-migration-admission-v1` over every imported project/history/AssetMetadata value before it creates a receipt, staging entry, canonical digest, or target file. It then computes `admittedImportSha256` over the complete RFC 8785 value `{ format: 'lumina-admitted-project-import', version: 1, admission: 'lumina-project-migration-admission-v1', archive: { format: 'lumina-project-export', version: <admitted archive version> }, projects: <UTF-8-ID-sorted { sourceProjectId, revision, projectSha256, historySha256 }[]>, assets: <UTF-8-ID-sorted { sourceAssetId, sourceProjectId, metadataSha256, bytesSha256, byteCount, lifecycleState }[]> }`, where the project/history/metadata digests are the admitted canonical values and only `bytesSha256` is `raw-bytes-sha256`. `requestSha256` is the digest of `{ format: 'lumina-library-import-request-v1', version: 1, operationId, expectedCatalog, admittedImportSha256 }`. No raw archive/text/metadata hash or raw archive-entry digest is stored in the receipt, staging, report, or request preimage. Reusing an `operationId` with a different admitted payload or expected catalog returns `operation_mismatch` before publication.

Its archive must contain the full project and asset set to import; the command re-runs the existing `.lumina` verifier/preparer, applies that admission rule, and requires exactly that admitted set. Under the write lease it allocates the complete source-project-ID -> target-project-ID map and source-asset-ID -> target-asset-ID map before any target asset metadata is written to staging or validated. Every imported `AssetMetadata.projectId` is resolved through the former map before its final metadata is staged, validated or published. A missing manifest owner is `invalid_manifest`; a failed admission or any owner project rejected for schema/content validation rejects the entire command and publishes no project, asset, mapping, receipt, or candidate. The final target metadata is a complete `AssetMetadata`, not a partial copy: `assetId` and `projectId` are the two allocated target IDs; `kind`, `mimeType`, `byteCount`, `sourceKind` and `sourceMetadata` come from the admitted archive projection; and `createdAt`, `width`, `height`, `durationMs` and `lifecycleState` receive the explicitly validated v1 import values (one transaction import timestamp, `null`, `null`, `null` and `active`). A later archive schema that carries any of those values must version and validate them rather than silently discarding them. Target tests must cover a missing owner, a failed secret admission, and a rejected owner project with no staged or published asset, then read every persisted metadata field and assert that the returned asset map and the stored owner mapping agree for every imported asset.

After the runtime has allocated the new `commitId` and sequence, but before it hashes the complete catalog, it creates the exact `publishedCatalogContentSha256` domain defined above from that catalog's commit identity, attachment, project map, and asset map. It then creates the exact canonical inner `lumina-library-completed-import-receipt` shown above and computes `receiptSha256` over that inner value only. It puts `{ receipt, receiptSha256 }` into the catalog and computes the catalog's `commitSha256` once. The receipt deliberately has no `publishedCommitSha256` or `catalogDigest`, so it cannot require a SHA-256 fixed point. Every later full catalog copies each unexpired envelope byte-for-byte. The inner receipt is keyed by `operationId` and contains the request hash, preallocated published commit ID/sequence, receipt-excluded catalog-content digest, retention time, and complete project and asset mappings. It is retained for 30 days from `publishedAt` and may be removed only by a later serialized catalog publication after `retainedUntil`. Staging cleanup must never delete the only mapping. This is bounded reconciliation evidence rather than an unbounded operation log.

If a response is lost after step 5, the client calls `reconcileLibraryTransaction` with the same operation ID and its original expected catalog. The runtime rereads and validates `head.json` and its catalog: an unexpired matching envelope first verifies `receiptSha256`, then opens only `commits/<receipt.publishedCommitId>.json`, recomputes that catalog's SHA-256 and receipt-excluded `publishedCatalogContentSha256`, requires its `commitId`/sequence to equal the receipt, and requires it to contain the exact same envelope. It then returns `AppliedLibraryImport` with the computed original `CatalogRevision` and every mapping, even if later catalog commits have advanced the head. If the receipt is absent while the validated head still equals the original expected catalog and the exact allocation remains claimed/live, `not_published` proves that the import was not visible and the caller may retry the same operation. If a syntactically valid operation sequence is at or below the durable high water but neither a live allocation nor a retained receipt exists, reconciliation returns `operation_outcome_expired`; clients and MCP must never replay that operation automatically. `unknown_outcome` is reserved for a damaged/contradictory ledger or catalog that must enter read-only maintenance, not ordinary receipt expiry. A new import then requires a new explicit authorization, allocation ID, operation ID, and pinned catalog. This protocol, rather than staging-directory inspection, prevents a lost reply from creating a double import.

`stale_catalog` and `rejected` are returned only before the visible pointer replacement in publication step 5, so neither makes a new head visible. A storage failure before that step likewise leaves the old catalog visible. The command never calls `applyProjectMutation` once per imported project: it prepares one `library-import` publish record, materializes one complete next catalog and receipt, and performs the same single `head.json` replacement in publication step 5. Its `applied.catalog` is that newly published catalog revision. This is the all-or-stale multi-project import seam.

The target file adapter routes each ordinary project mutation through `applyProjectMutation`; under the same lease it derives one complete next catalog from the current head. Every non-delete success writes a next project revision into that catalog; `delete` checks the revision before removing the project. `updateViewport` and `rename` receive the same check rather than inheriting `saveSnapshot` semantics by implication. Existing browser-only convenience methods remain current compatibility behavior until those adapters land; they are not evidence of a runtime-wide stale-revision contract.

### Target deletion lifecycle and legacy API binding

The current `projectStore.deleteProject` -> `ProjectRepository.delete`, `AssetRepository.delete`, `setDeletionCandidates`, `withProjectMutationOrdering`, `batchImageCropSession` cleanup, stale/cancelled `videoGenerationResult` cleanup, canvas-media-import cleanup, and IndexedDB import `discardStaging()` paths are browser-only compatibility behavior. In particular, the current IndexedDB project and asset adapters physically delete records. That behavior and the current repository-contract assertions remain true before cutover; this section is the required future runtime-adapter behavior and does not silently redefine a current browser write.

After #45, `projectStore.deleteProject` and every route through `ProjectRepository.delete` must obtain a target command context containing the pinned `CatalogRevision`, the project's expected revision, and an explicit authenticated user `delete-project` authorization bound to that project and catalog. They must call only `applyProjectMutation({ context, projectId, expectedRevision, mutation: { kind: 'delete' } })`; a bare legacy repository call that lacks this context rejects with non-retryable `target_delete_authorization_required`. A `deleted` result means that the project disappeared from the live catalog, not that its bytes were erased. Before the replacement head is published, the runtime validates the current project/history snapshot and reference closure, writes and flushes one `trash/<deletionId>/manifest.json` naming that exact last snapshot/history and every recovery/asset payload needed to restore it, and records the approved project ID, catalog revision, manifest digest, and authorization class without an authorization token. The next catalog may then remove the project. The explicit project restore is `applyProjectMutation({ context, projectId, expectedRevision: 'absent', mutation: { kind: 'restoreProject', deletionId, trashManifestSha256 } })`; it has its own `project-restore` proof and pinned catalog, republishes the validated trash snapshot through the normal stale-catalog command, and uses the existing deterministic suffix/reference-rewrite rule if the project ID is occupied. A crash before the head leaves the project live or its complete trash root; a crash after it leaves the project recoverable from that one manifest.

`setDeletionCandidates(projectId, assetIds)` is only a lifecycle-state publication. In the target it requires the same authenticated catalog-pinned project context and calls `applyAssetLifecycleMutation({ context, precondition, mutation: { kind: 'replaceDeletionCandidates' } })` with an `AssetLifecyclePrecondition`: the exact pinned catalog, the paired expected project revision, and the complete UTF-8-sorted non-staging owned-asset `{ assetId, lifecycleState, metadataSha256 }` set that the caller observed. Under one library write lease the runtime rereads all three preconditions, validates that every requested asset belongs to that project, creates a fresh immutable `AssetMetadataDocumentV1` for every changed lifecycle state, and links each new content-addressed metadata path/digest only from one next catalog. It never overwrites an old metadata payload, so readers pinned to the prior catalog retain the old coherent lifecycle state. A catalog/revision/asset-set difference returns `stale_catalog`, `stale_revision`, or `stale_asset_lifecycle` with no partial update and no automatic merge/retry; two stale whole-set writes therefore cannot silently erase one another's candidate state. The caller may reread, deliberately recompute, and submit a fresh mutation.

It never deletes metadata or Blob bytes, never accepts a `staging` asset, and may mark an asset only after a complete project/history/reference scan proves it is no longer needed by a live project, retained history, import receipt, recovery root, reader pin, trash manifest, pending/active binding, quarantine, or other project. A candidate remains readable and undoable until it is restored or the later trash pass creates its own durable recovery root. Shared or otherwise reachable assets stay active; a caller receives non-retryable `asset_still_reachable` rather than a partial candidate set. Target `AssetRepository.write` routes through `writeRuntimeAsset` with the same catalog-pinned authenticated context before it creates a `staging` asset. Target `AssetRepository.delete` (visible -> candidate), candidate restore, project delete's related candidate changes, and every maintenance candidate -> trash/GC transition use the same catalog/project/metadata compare-and-swap under their owning publication or cleanup lease. Each such transition publishes a new metadata document/catalog link when metadata changes; it never mutates a metadata payload reached by an existing catalog. A cleanup plan also rechecks its exact root-set/catalog digest immediately before `authorized`; a changed asset lifecycle cancels that one plan instead of deleting or rewriting the newer state.

The target `AssetRepository.delete(assetId)` is likewise not a physical-delete escape hatch. For a visible asset, it is a catalog-pinned, authorized `applyAssetLifecycleMutation({ context, precondition, mutation: { kind: 'requestAssetDeletion' } })` and resolves only after the lifecycle catalog publishes; it rejects with `target_delete_authorization_required`, `asset_still_reachable`, `stale_catalog`, `stale_revision`, or `stale_asset_lifecycle` when the required proof is absent. Its explicit trash restore is `applyAssetLifecycleMutation({ context, precondition, mutation: { kind: 'restoreAssetFromTrash', deletionId, assetId, trashManifestSha256 } })`, with an `asset-trash-restore` proof bound to that exact manifest and catalog. It never moves a visible asset directly past the candidate/trash safety window. For a `staging` asset, the generic call rejects with non-retryable `staged_discard_requires_owner`: the only permitted immediate cleanup is an internal `discardStagedAsset` operation carrying the exact staging `transactionId` (or the migration `migrationId` and `candidateKey`), `assetId`, metadata digest, and byte digest. Under the write lease it rereads the one matching `publish.json` or migration candidate, proves that the asset was never in a visible catalog or trash/recovery root, and deletes only that named staging payload. A mismatch, published asset, missing owner record, or crash leaves the matching staging record for its normal one-operation recovery/quarantine path; it never falls back to a global asset/staging sweep.

The active target media cleanup paths must therefore replace the current `batchImageCropSession` catch-path, the stale/cancelled `videoGenerationResult.deleteCreatedAssets()` path, and `Canvas`'s failed canvas-media-import `deleteAsset` callback with that operation-scoped staged discard. Each output application service returns the exact staging transaction/candidate identity with a newly written asset and calls `discardStagedAsset` only while its paired node/project publication has not made the asset visible. If a result became visible before its later workflow fails, cleanup must use the ordinary catalog-pinned authorized candidate/trash lifecycle instead; it may not hide that visible result with `AssetRepository.delete`. The target archive importer follows the already-defined `BrowserImportOperationV1`/`applyLibraryTransaction` operation-specific discard rules for the same reason. Releasing an Object URL remains a process-local lease operation and never proves or performs byte deletion.

Only a separate, explicit `emptyTrash` maintenance command may permanently remove a trashed project or asset. It requires fresh user authorization, the exact `deletionId`/trash-manifest digest, the maintenance lease, and a fresh full root-closure/digest check. The exact canonical receipt at `trash/<deletionId>/cleanup.json` is:

~~~ts
type TrashCleanupReceiptV1 = {
  format: 'lumina-library-trash-cleanup';
  version: 1;
  deletionId: string;
  trashManifestSha256: string;
  expectedCatalog: CatalogRevision;
  rootSetSha256: string;
  entries: readonly { path: string; sha256: string }[]; // UTF-8 path-sorted
  authorizationClass: 'empty-trash'; // never the authorization proof
  state: 'authorized' | 'complete' | 'cancelled';
  authorizedAt: number;
  terminalAt: number | null;
  retainedUntil: number | null;
};

type TrashExpiryReceiptV1 = {
  format: 'lumina-library-trash-expiry';
  version: 1;
  deletionId: string;
  trashManifestSha256: string;
  cleanupSha256: string;
  terminalRootSetSha256: string;
  state: 'authorized' | 'complete';
  authorizedAt: number;
  completedAt: number | null;
  retainedUntil: number | null;
};
~~~

`emptyTrash` first writes and flushes this receipt as `authorized` before removing any named trashed metadata or Blob bytes. It then rechecks every named path/digest and root, removes only still-matching listed payloads, and changes that exact receipt to `complete` or `cancelled`. A `complete` or `cancelled` receipt has `terminalAt` set once and `retainedUntil === terminalAt + 30 * 24 * 60 * 60 * 1000`; an `authorized` receipt has both fields `null` and remains a maintenance root until it reaches one terminal state. Restart resumes only that receipt. A newly reachable/shared payload cancels this one cleanup and preserves the trash root; a restore request against an `authorized` cleanup returns `asset_still_reachable`/`trash_manifest_mismatch` rather than racing its removal.

At that terminal retention deadline, maintenance proves the receipt and manifest canonical digests, that every receipt-listed payload is absent, that no reader/restore/reconciliation lease or root selects the deletion ID, and that the current closed root set matches `terminalRootSetSha256`. It writes and flushes `trash/<deletionId>/expiry.json` as `authorized`, removes the manifest and cleanup receipt only after that authorization is durable, then changes the expiry receipt to `complete`. The expiry receipt remains through `completedAt + 30 * 24 * 60 * 60 * 1000`, after which one exact maintenance pass may remove it only if the trash directory contains no payload, manifest, cleanup receipt, or live lease. This order leaves a value-free audit proof across every crash point and makes the cleanup receipt, manifest, and then expiry receipt explicit bounded GC roots. No project delete, candidate mark, generic asset delete, failed import, or background GC can substitute for `emptyTrash` authorization or bypass retained history/catalog, reader-pin, recovery, quarantine, binding, and shared-asset reachability roots.

Target conformance tests must call each legacy-facing route with and without its required target context; prove that project delete is undoable from trash, generic visible-asset delete only creates a candidate, and a shared/recovery/history-reachable asset is not marked. They must issue two candidate replacements from the same base, a candidate mark concurrent with restore, and a cleanup plan concurrent with a lifecycle mutation; exactly one compare-and-swap may publish, every stale caller must return the stated typed result, and no candidate/active state or Blob may be silently dropped. They must also inject failures before and after the trash manifest, candidate catalog, cleanup `authorized`, and cleanup `complete` writes; prove that `batchImageCropSession`, stale/cancelled video generation, and failed canvas-media import discard only their private never-published outputs and use candidate/trash after visibility; and prove that current IndexedDB adapter tests continue to cover current immediate browser deletion rather than being reused as target-lifecycle evidence.

At startup, the runtime acquires maintenance access and applies this deterministic recovery algorithm before accepting writes:

1. If `library/head.json` and its named catalog validate, that catalog is the only visible state.
2. Otherwise, maintenance validates `head.previous.json` as the exact head-pointer format and validates the complete catalog it names. A valid journal is the only allowed fallback: without replacing that journal, `DurableFileOps` writes it to a temporary current-head file, flushes it, atomically replaces `head.json`, and synchronizes the root. It then records read-only recovery for the interrupted transaction and blocks further writes until the recovery is acknowledged. It does not infer a head by scanning commit or project directories. Thus an undurable new root directory entry restores the last proven head instead of rejecting all valid prior commits.
3. Once a visible head has been established by step 1 or 2, an ordinary staging transaction whose intended commit ID equals it is complete; for a library import, its operation ID, request hash and full mapping must also equal the receipt in that catalog before its remaining staging control files are removed. A missing or different receipt fails catalog validation and retains the control record. An ordinary staging transaction whose intended commit ID is not the visible head was never published: maintenance first writes and durably flushes its exact failed-publication quarantine manifest, then releases only that transaction's active staging control. It retains every named materialized payload, publish record, report, and mapping in place or under that quarantine; it does not remove an unreachable payload at this point and never promotes one by scanning. An unpublished import has no applied mapping to return.
4. If neither the current head nor the retained prior-head journal validates, the runtime enters read-only recovery and requires an explicit verified .lumina restore or operator repair. It never selects individual project snapshots from an invalid import.

Those generic rules apply to ordinary project mutations and imports. A `migration` staging record and its `migrations/<candidateKey>.json` evidence are excluded from generic promotion and orphan cleanup: only the same `migrationId`/`candidateKey` durable IndexedDB fence or binding may select it for publication or place it in its own failed-publication quarantine under the browser-cutover rules below. This prevents an unbound scan from deleting, activating, or retaining a different candidate.

Normal crash recovery therefore has two observable outcomes: the old head remains visible and the uncommitted transaction is quarantined, or the new head remains visible with its complete reconciliation receipt retained. A conformance test must inject a host/power failure before and after each numbered publication step and each successful `DurableFileOps` primitive for an import containing multiple projects and assets. After remount/restart it must validate and accept the exact old or exact new full catalog, then call `reconcileLibraryTransaction`: it observes either `not_published` against the unchanged expected catalog or the returned complete source-to-target mapping, never a partial import, staged-only mapping, immediate loss of an unpublished payload, or read-only rejection caused only by a non-durable new directory entry.

### Failed-publication quarantine

`quarantine/<transactionId>/manifest.json` is the durable safety-window record for an unpublished project mutation, library import, #45 candidate, or non-secret #46 candidate. It is written canonically and flushed before any matching fence/control record is cleared. It contains the operation kind, transaction/candidate key, migration ID when present, failure phase/reason class, observed prior and intended catalog revisions plus their `catalogDigest` values, every retained relative payload/control/report path with its digest, `failedAt`, and `retainedUntil`. `retainedUntil` is exactly `failedAt + 30 * 24 * 60 * 60 * 1000` milliseconds. A source-recovery or compatibility window has its own root below and never creates an unbounded extension of this quarantine. Final-path immutable payloads may stay at their existing paths, but the manifest is their only maintenance reachability claim and they are never visible to normal readers or eligible for later promotion.

At or after `retainedUntil`, maintenance takes the write lease, verifies every listed digest and that each listed payload is still unreachable from the exact root set below, and writes and flushes `quarantine/<transactionId>/cleanup.json`. Its canonical value contains the manifest digest, exact UTF-8-path-sorted removed paths/digests, the root-set digest, `checkedAt`, `completedAt` when complete, and `state: 'authorized' | 'complete'`. Only an `authorized` receipt permits deletion of its exact named paths; after every named path is absent, maintenance replaces it with `complete`. A restart resumes only that same authorization: it revalidates the root set, removes only still-present named paths, and then writes `complete`. The complete audit pair (manifest and cleanup receipt) is retained through `completedAt + 30 * 24 * 60 * 60 * 1000` and may then be removed by a separate exact maintenance pass. A missing/mismatched payload, an unexpired reference, or a failed cleanup write leaves the quarantine intact and blocks broad cleanup. No recursive staging cleanup, candidate-directory scan, or "unreachable now" heuristic may delete another transaction's payload.

Credentials are the narrow exception to byte retention: a failed #46 candidate must immediately delete only its candidate-private vault values through the platform vault, because retaining a raw secret for a safety window is forbidden. Its file-library quarantine manifest retains only the value-free vault cleanup result class; the marker, entry digests, index, and cleanup receipt remain only inside the selected OS vault. It contains no secret, secret-derived hash, source path, source-presence bit, vault-entry identifier, or index digest. Its immutable sanitized preference candidate, publish record, and report still follow the normal quarantine rule.

### Catalog retention, pins, and garbage collection

Catalog reachability is a closed, bounded set; `previousCommitId` is provenance, not a recursive retention edge except for the explicitly named, time-bounded frozen-source lineage below, and maintenance never discovers roots by scanning directories. Under the library maintenance lease, the only roots are:

1. The validated `head.json` catalog, its named runtime attachment, and every project snapshot, recovery file, exact metadata version, and Blob it names.
2. The one validated `head.previous.json` catalog, its named runtime attachment, and its transitive payloads, until the next successful serialized `head.json` publication durably replaces that journal. A commit's `previousCommitId` alone is never a root.
3. Each visible unexpired `completedImports` envelope's exact `(receipt.publishedCommitId, receipt.publishedSequence, receipt.publishedCatalogContentSha256, receiptSha256)` catalog, that catalog's attachment, and its direct project/asset/recovery payload closure. The receipt hash is first verified over its inner receipt, then the named catalog is reread, its receipt-excluded content digest is recomputed, and it must contain the exact same envelope; its computed commit SHA-256 is not stored in the receipt. A retained historical catalog's copied receipts never recursively root still older catalogs. The receipt retention is exactly 30 days from `publishedAt`; expiry is removed only by publishing a later serialized catalog.
4. A process-local active reader pin with exact `{ commitId, commitSha256, sequence, expiresAt }`. A pin covers one read/RPC, expires no later than five minutes after acquisition, and may be renewed only by its still-live owner before expiry for a maximum continuous 30-minute read. The runtime drops all pins on restart; a client with an interrupted or longer read must reopen and validate a current catalog rather than revive a persisted pin.
5. The exact prior/target catalogs, their named attachments, candidates, reports, and recovery payloads named by one durable pending, active, or `recovery_failed` cutover fence/binding, but only through its `recoveryRetainedUntil`. For an active #45 binding, this additionally roots the direct `previousCommitId` chain from the current head back to its exact initial target catalog, with every resolved catalog independently hash-validated. That is the frozen-source recovery lineage: every hop must name its immediate predecessor, end at the bound initial catalog, retain runtime ownership of `projects`/`history`/`assets`, and validate as a complete catalog; a loop, missing hop, different branch, or foreign older commit is not a root. The chain is bounded by the fixed compatibility window, not by later activity. For #45 and #46 that timestamp is exactly 30 days after the source-side ownership commit; a failed activation does not renew it. An expired binding/report is removed only after its required permanent active-ownership attachment validates.
6. One ordinary `staging/<transactionId>/publish.json` and its named payloads while its final library write lease is live, plus one matching unexpired quarantine or `maintenance/<transactionId>/gc.json` plan. A final publication lease is at most five minutes; restart or expiry must deterministically publish the named visible transaction or quarantine exactly that transaction. A migration candidate is a root only through item 5, never merely because a matching-looking directory exists.
7. A validated recovery snapshot or trash root: a trash manifest, an `authorized` cleanup receipt, a terminal cleanup receipt before its exact `retainedUntil`, or an authorized/complete expiry receipt before its own exact `retainedUntil`, plus exactly the payloads that record names. Trash is an intentional user-controlled recovery/audit root, not an automatic orphan-retention mechanism.

`control/import-operation-ledger.json` is permanent bounded uniqueness state, not a project/asset reachability root: maintenance may remove only its exact expired allocation entries, never reduce `lastAllocatedSequence` or change its namespace. A claimed allocation protects only its corresponding active operation/receipt; it cannot root an unrelated catalog or payload. All other ordinary immutable catalogs, attachments, commits, snapshots, superseded metadata versions, and Blob payloads are candidates for collection. A maintenance pass first validates `head.json`/`head.previous.json`, resolves expired ordinary staging into the one visible publication or its exact quarantine, drops only expired import receipts through a serialized next catalog, and compacts expired cutover evidence only after the permanent attachment check. It then computes the transitive closure of the seven roots above. The existing migration rule remains stricter: an unbound migration candidate is neither promoted nor treated as ordinary staging/GC; it is a recovery fault requiring its exact source-fence/binding repair. No normal reader, future `previousCommitId`, stale process, or unbound migration directory can keep an ordinary item alive.

For an unrooted immutable catalog/commit/attachment or superseded snapshot/metadata-version/Blob payload, maintenance writes and flushes one canonical `maintenance/<transactionId>/gc.json` before deleting anything. It names the validated visible catalog, a digest of the complete root set, the UTF-8-path-sorted item paths and their existing content digests, `plannedAt`, `notBefore: plannedAt + 30 * 24 * 60 * 60 * 1000`, `completedAt` when terminal, and `state: 'planned' | 'authorized' | 'complete' | 'cancelled'`. The plan itself retains only those exact items until `notBefore`; it cannot gather new paths. At `notBefore`, maintenance recomputes the entire root closure under the write lease. A newly rooted item makes this one plan `cancelled`; otherwise maintenance verifies every listed digest, durably changes the plan to `authorized`, removes only its named still-present paths, and durably changes it to `complete`. Restart resumes that one plan idempotently. A terminal `complete` or `cancelled` plan remains only through `completedAt + 30 * 24 * 60 * 60 * 1000`, then a separate exact maintenance pass may remove it. This gives unreachable historical copies a 30-day safety window while allowing orphan cleanup to progress without a broad sweep.

An asset that is still visible but no longer referenced by its project/history or any other protected reachability root first becomes a deletion candidate. A later pass rechecks the same root closure, writes and flushes a `trash/<deletionId>/manifest.json` containing the last validated snapshots and eligible metadata/Blob digests, and only then publishes the catalog that removes those live references. The old final paths can enter the exact 30-day GC plan only after the trash copy is durable. An explicit empty-trash action repeats the root/digest recheck and uses the exact `authorized` -> `complete`/`cancelled` cleanup receipt followed by the separately durable expiry receipt before deleting any trashed metadata or Blob bytes; it may never delete a Blob merely because its catalog entry was removed. Project and asset trash restore use their stated catalog-pinned authenticated commands; if an ID is occupied, the project restore applies deterministic suffixes and rewrites references like an import. Permanent removal therefore requires explicit empty-trash authorization, while automatically retained staging, quarantine, import-receipt, recovery, reader-pin, superseded-payload, cleanup-receipt, and expiry-receipt roots all have the bounded lifetimes above.


## Browser import operation ownership and capture scope

The current browser `.lumina` import path has only a random `stagingId` on asset records and a global `cleanupStaging()` routine. It is current compatibility behavior, but it is not an operation-recovery protocol and #45 must not use it to sweep a source before migration. The #45-compatible browser release adds a temporary `import-staging` control store plus one durable `BrowserImportOperationV1` record in `meta` at `browser-import:<operationId>`. This store is a bounded browser import implementation detail, never a project owner and never part of the #45 ownership vector.

The browser database has one permanent canonical `BrowserImportOperationLedgerV1` at `browser-import-id-ledger`: `{ format: 'lumina-browser-import-operation-ledger', version: 1, namespace: <CSPRNG lowercase 128-bit hex>, lastAllocatedSequence: <safe integer>, allocations: <allocationId-sorted BrowserImportAllocationV1[]> }`. Its namespace is created exactly once before the first browser import and is never reset by terminal receipt expiry; it is not a user/project/asset record. A caller first persists one lowercase UUID v4 `allocationId` and one non-negative safe-integer Unix-millisecond `createdAt`, then invokes the compatible browser allocator. Under one `meta` transaction, a matching still-live allocation returns its prior result; a new allocation increments and commits `lastAllocatedSequence` before replying with its exact `BrowserImportAllocationV1`. A conflicting `createdAt`/allocation request is `operation_mismatch`. A crash before the transaction commits allocates nothing; a crash after it commits may burn one sequence and is never repaired by reuse. An unclaimed allocation expires exactly 24 hours after `allocatedAt` and is removed only by an exact `meta` cleanup, while the high water survives forever. After secret-free admission, the first `meta`/`import-staging` transaction atomically writes the exact `BrowserImportOperationV1` and changes only its matching allocation to `claimed`:

~~~ts
type BrowserImportAllocationV1 = {
  format: 'lumina-browser-import-allocation';
  version: 1;
  allocationId: string;
  operationId: string; // bi_<namespace>_<base-10 sequence>, no leading zero
  createdAt: number;
  allocatedAt: number;
  expiresAt: number;
  state: 'allocated' | 'claimed';
};

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
  terminalRetention: null | {
    terminalAt: number;
    retainedUntil: number;
  };
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

type BrowserImportReconciliationLeaseV1 = {
  format: 'lumina-browser-import-reconciliation-lease';
  version: 1;
  operationId: string;
  leaseId: string;
  terminalOperationSha256: string;
  expiresAt: number;
};

type BrowserImportExpiryReceiptV1 = {
  format: 'lumina-browser-import-expiry-receipt';
  version: 1;
  operationId: string;
  stagingId: string;
  stagedEntryKeys: readonly string[];
  requestSha256: string;
  manifestSha256: string;
  terminalState: 'published' | 'discarded';
  terminalOperationSha256: string;
  retainedUntil: number;
  state: 'authorized' | 'complete';
  authorizedAt: number;
  completedAt: number | null;
  completionRetainedUntil: number | null;
};
~~~

The record itself is RFC 8785 canonical UTF-8 with no self-hash. `requestSha256` is the digest of the complete `BrowserImportRequestV1` value `{ format: 'lumina-browser-import-request', version: 1, archive: { format: 'lumina-project-export', version: <admitted archive version> }, projects: <UTF-8-ID-sorted { sourceProjectId, revision }[]>, assets: <UTF-8-ID-sorted { sourceAssetId, sourceProjectId, lifecycleState }[]> }`. `manifestSha256` is the digest of the complete `BrowserImportPreparedManifestV1` value `{ format: 'lumina-browser-import-prepared-manifest', version: 1, operationId, requestSha256, projects: <UTF-8-ID-sorted { sourceProjectId, projectSha256, historySha256 }[]>, assets: <UTF-8-ID-sorted { sourceAssetId, sourceProjectId, metadataSha256, bytesSha256, byteCount, lifecycleState }[]>, stagedEntries: <entryKey-sorted complete stagedEntries[]> }`. `projectSha256`, `historySha256`, and `metadataSha256` are hashes of the admitted projections; `bytesSha256` is `raw-bytes-sha256`. Every array is required, sorted as stated, and has no implicit empty/default member. Thus neither digest has a raw archive, raw project/history JSON, raw source metadata, raw archive-entry hash, or secret-derived preimage. The browser verifies `maxBrowserBufferedArchiveEnvelopeBytes` before `arrayBuffer()` and all registry count/byte/MIME limits before this allocation/record transition. `terminalRetention` is `null` for `preparing`/`prepared`; for `published` or `discarded`, `terminalAt === stateChangedAt` and `retainedUntil === terminalAt + 30 * 24 * 60 * 60 * 1000`. That window is both the minimum and maximum normal terminal-reconciliation age and may not be renewed. An expiry receipt copies the terminal record's exact `stagingId` and UTF-8-entry-key-sorted complete `stagedEntryKeys`; it may contain only those opaque control identifiers and the existing value-free digest/state fields. In `authorized`, `completedAt` and `completionRetainedUntil` are both `null`; in `complete`, `completionRetainedUntil === completedAt + 30 * 24 * 60 * 60 * 1000`.

The first `meta`/`import-staging` transaction commits that complete `preparing` record before any staged payload. Before it does, it counts every terminal `BrowserImportOperationV1` record still present, every `BrowserImportExpiryReceiptV1` still present whether `authorized` or `complete`, and every active allocation; the combined limit is 128 per browser database. It first performs only eligible exact-record/allocation expiry cleanup below. A complete receipt whose retention has elapsed but cannot pass its exact cleanup predicates remains counted; expiry never creates an eviction exception. If 128 records remain, it rejects the new allocation before a sequence increment with non-retryable `browser_import_receipt_capacity_exhausted`; it never evicts an unexpired terminal record, active operation, allocation, or reconciliation lease. Every staged project/history payload and Blob is addressed by its `operationId` and opaque `entryKey`; any legacy `assets` staging record also carries that same operation ID. Each staging transaction rereads the record and may write only a listed entry with its exact digest/byte count. A retry with an existing operation ID is idempotent only when the allocation's `createdAt`, `stagingId`, `requestSha256`, `manifestSha256`, and every staged entry match the record, and any stored terminal receipt revalidates exactly; it then resumes or returns the recorded state. A difference is `operation_mismatch` with no mutation. Reuse of a staging ID/entry key by another operation, duplicate owner records, or an entry absent from the manifest is `import_staging_collision`, blocks #45 preflight, and never authorizes a global cleanup.

The final publish transaction spans `projects`, `history`, `assets`, `import-staging`, and `meta`: it validates the complete manifest, allocates the source-to-target maps, writes all live records, removes only that operation's staged entries, and atomically replaces `prepared` with the retained `published` receipt and its exact terminal-retention window. Therefore a crash leaves either `prepared` with one complete resumable payload or `published` with its exact result; it never leaves a guessed partial import. On restart, maintenance reconciles one supplied `operationId`, never every `lifecycleState: 'staging'` record. `prepared` resumes that one publish transaction; `published` returns its retained maps without replay; incomplete/mismatched `preparing` or `prepared` transitions only itself to `discarded`, records the exact removed opaque entry keys, cleans only those entries, and writes the same exact terminal-retention window. Terminal results are available only through that 30-day window.

For a `published` or `discarded` reconciliation, the caller first opens `browser-import-reconcile:<operationId>` in the same `meta` transaction that rereads the terminal operation. It must match the full terminal record SHA-256 and has a random `leaseId` with `expiresAt <= min(now + 5 minutes, terminalRetention.retainedUntil)`; it cannot be created or renewed at/after `retainedUntil`. While this lease is live, reconciliation returns only the exact stored terminal result and cleanup cannot remove the operation. A `preparing`/`prepared` operation is not terminal and remains protected by its existing one-operation resume/discard rules. At or after `retainedUntil`, a new terminal reconciliation returns `browser_import_outcome_expired` and may not replay, recreate, or remap that operation. The allocator parses a valid `bi_` namespace/sequence before any retry: a sequence at or below its durable high water with no live allocation or terminal record returns that same expiry result; a malformed/foreign/above-high-water ID is `operation_mismatch`. A new user-authorized import therefore requires a new allocation ID and a strictly higher operation ID.

Expiry cleanup is exact and durable. After the terminal window, maintenance first proves that the operation is terminal, its full canonical SHA-256 equals the proposed `terminalOperationSha256`, no reconciliation lease is live, no matching migration fence/binding currently selects it, and every listed staging entry is already absent or belongs only to that operation. It writes `browser-import-expiry:<operationId>` as the canonical `BrowserImportExpiryReceiptV1 { state: 'authorized', completedAt: null, completionRetainedUntil: null }` before removing anything. An `authorized` receipt with its terminal operation still present rechecks that operation's full SHA-256, terminal fields, ownership selection, lease absence, and exact staged-entry set; it then uses one `meta`/`import-staging` transaction to remove only that terminal operation, its matching allocation, reconciliation lease, and the receipt-listed direct private staging entries, leaving the `authorized` receipt in place. It never removes published projects, history, assets, mappings in live records, or another operation's record. An `authorized` receipt whose terminal operation is already absent is the post-removal crash branch: it must not dereference the missing operation. Instead it validates the receipt's canonical bytes, operation ID, staging ID, entry-key set, request/manifest/terminal hash/state/cutoff, no live allocation or lease or matching migration fence/binding, and that every directly addressed staging entry is absent; only then may it change that exact receipt to `complete`. Any mismatched receipt, foreign staging entry, live selection, or missing required condition preserves only that receipt for maintenance rather than broad cleanup. The `complete` receipt remains until its exact `completionRetainedUntil`, counts toward the 128-record bound, and may then be removed only by another exact `meta` maintenance transaction that revalidates no operation, allocation, lease, fence, or binding names its operation ID. This receipt is the value-free ownership evidence that one terminal operation, rather than a global staging class, was expired; the permanently retained high water remains after all per-operation evidence is gone.

When more than one interrupted operation exists, preflight sorts records first by numeric `createdAt` ascending and then by the UTF-8 byte order of `operationId`; equal timestamps therefore have one stable order. It reconciles each record in that order without allowing an earlier failure to delete, rewrite, or select a later record. An unresolved/colliding record blocks the #45 fence after recording only its own outcome; a later `published` record remains intact and a later valid operation may be reconciled when its predecessor is resolved. Acceptance tests fix equal `createdAt` values, exercise allocation replay/lost responses, both operation-ID and staging-ID collisions, a permanently burned allocation gap, the 128-record bound, expiry while another receipt is actively leased, and kill/restart before and after each allocation/terminal/expiry state change. They must prove that replay returns the original mapping only before its fixed expiry, a post-expiry ID is deterministically rejected rather than reused, cleanup removes exactly one operation's control evidence but no live result, and an at-cap new import leaves all existing operations intact.

The successful #45 fingerprint starts after that operation reconciliation and contains every remaining browser `AssetMetadata` record with `lifecycleState: 'active'` or `'deletion-candidate'`, whether or not a current node/history references it. Every fingerprinted asset has exactly one transferred metadata frame, its complete Blob frames, one target catalog entry, and matching metadata/byte/lifecycle hashes. `deletion-candidate` remains a deletion candidate in the target; it is neither dropped nor rewritten as `active`. Parsed project/history references still require complete closure and target mappings, but unreferenced active/candidate assets are also preserved because they remain durable asset facts. Thus a successful source fingerprint has no `staging` asset entry and no implicit exclusion. A failed preflight may report its unresolved operation IDs only to maintenance, but it is not a successful migration report or candidate fingerprint.

### #45 canonical project migration evidence and recovery
