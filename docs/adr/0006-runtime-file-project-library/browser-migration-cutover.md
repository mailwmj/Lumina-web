---
status: accepted
parent: ../0006-runtime-file-project-library.md
---

# 运行时文件项目库：浏览器迁移与 Cutover

> **权威范围**：每 store 归属、启动、陈旧标签 fence、#45 快照/cutover、项目事实准入和迁移恢复 本文中的规范性条款是 ADR-0006 对该主题的唯一权威来源；根 ADR 只保留决定、状态、历史和导航索引。

## Browser support scope

The current pre-cutover browser project library is a single configured, connected Chrome profile at the registered canonical Origin. Only the `connected-chrome-codex-entry` release-evidence record with `supportScope: 'pre-cutover-connected-chrome-shared-library-codex'` can prove that Codex reaches that same IndexedDB project library. A disconnected Chrome, any Edge profile, the Codex in-app Chromium, and the current system-default-browser manual entry are not substitutes; the latter remains an explicitly unsupported current gap until it is configured to target that connected Chrome profile.

The latest and previous stable Chrome and Edge records instead carry `supportScope: 'web-renderer-compatibility'`. They prove the Web renderer and its representative flows on those browser versions only. They do not prove a shared IndexedDB library, profile continuity, Codex continuity, or that Edge has access to the connected Chrome profile. The release gate must require and validate these scopes separately, so retaining Chrome-and-Edge renderer evidence cannot be used to overstate browser-library support.

After the future #45 file-library cutover, project continuity is through the runtime-owned library rather than any browser profile or IndexedDB store. Browser support for that target is a separate runtime-client acceptance question: a later contract must name its runtime protocol/version and evidence scope before it can claim a browser is supported for file-library continuity. The current Chrome/Edge `web-renderer-compatibility` records neither grant nor preclude that future support.

## Browser migration and cutover

The browser-only IndexedDB implementation is the current durable implementation and is transitional only relative to this accepted target. Migration is a future one-time, user-visible operation, not a background sync mechanism. It has two independently committed stages: #45 moves only project facts, and #46 later separates the mixed browser settings record. There is no whole-database `storageMode` switch.

### Per-store ownership and bound cutover state

The durable control record in the IndexedDB `meta` store is an ownership ledger, not project or settings evidence. It contains the owner/state for each durable data store and a monotonic `storageModeEpoch`. The ledger is written only under the exclusive migration lease; `meta` remains the coordination store so the ledger can describe different owners without pretending that the whole database froze. It is deliberately distinct from runtime identity metadata.

Every committed store transition has one canonical `lumina-cutover-binding-record` envelope in that ledger. Its `binding: CutoverBindingV1` names a random lowercase UUID v4 `migrationId`, one opaque `t_` `candidateKey`, `candidateDigest`, `reportSha256`, the exact target `CatalogRevision`, and its distinct `catalogDigest`. It also records the transition scope, the prepared fence schema version, and `recoveryRetainedUntil`, which is exactly the source-side ownership-commit timestamp plus `30 * 24 * 60 * 60 * 1000` milliseconds, and `activation: 'pending' | 'active' | 'recovery_failed'`; the envelope carries the derived `bindingSha256` defined above. Every binding whose target owns project facts additionally names the exact `{ attachmentKey, attachmentSha256, libraryId, libraryRootId }` in its target catalog. A #46 binding names the next attachment too, copies the prior and target `PreferencesPointerV1` digests, exact prior and target vault-active-marker digests, and selected vault platform from that immutable candidate, never a pointer body, marker body, vault entry reference, or attachment body. A later #46 binding is added alongside the retained #45 binding rather than replacing it. `pending` means the IndexedDB ownership commit has happened but the named target is not yet active; only `active` permits ordinary target attachment; `recovery_failed` is read-only and requires maintenance repair.

The binding contains no project ID, asset ID, setting object, credential, secret-presence bit, or raw secret. The UUID/key are opaque selectors and the candidate, report, catalog, and binding digests are integrity values only. Normal clients, MCP, diagnostics, logs and runtime identity metadata do not expose them. The binding is retained only through `recoveryRetainedUntil`; it is not the permanent ordinary-client attachment record. The transaction that changes a binding from `pending` to `active` also writes this permanent `meta` record. Before later compacting that binding, maintenance validates and preserves the same record in the ownership-ledger transaction that removes the binding:

~~~ts
type PermanentActiveOwnershipV1 = {
  format: 'lumina-permanent-active-ownership';
  version: 1;
  storageModeEpoch: number;
  storeOwnership: Record<'projects' | 'history' | 'assets' | 'settings', string>;
  projectLibrary: null | {
    libraryId: string;
    libraryRootId: string;
    formatVersion: 1;
    attachment: { attachmentKey: string; attachmentSha256: string };
  };
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

### Runtime-owned project-library attachment and bootstrap

`RuntimeLibraryAttachmentV1` is the permanent, non-secret runtime-owned companion to the browser `PermanentActiveOwnershipV1`; it is not installation/runtime identity metadata and it is not migration evidence. It is immutable canonical `RFC8785-JCS-SHA256-v1` JSON at `attachments/<attachmentKey>.json` and has this exact shape:

~~~ts
type RuntimeLibraryAttachmentV1 = {
  format: 'lumina-runtime-library-attachment';
  version: 1;
  attachmentKey: string; // one runtime-generated b_ LibraryKey
  libraryId: string;
  libraryRootId: string;
  runtimeIdentity: {
    installationId: string;
    registeredOrigin: string; // canonical Origin serialization
  };
  storageModeEpoch: number;
  storeOwnership: Record<'projects' | 'history' | 'assets' | 'settings', string>;
};

type BrowserAttachmentRepairV1 = {
  format: 'lumina-browser-attachment-repair';
  version: 1;
  repairId: string; // one lowercase UUID v4
  browserEvidence: 'cleared';
  cutoverSchemaVersion: number;
  attachment: { attachmentKey: string; attachmentSha256: string };
  library: { libraryId: string; libraryRootId: string };
  storageModeEpoch: number;
  storeOwnership: Record<'projects' | 'history' | 'assets' | 'settings', string>;
  settingsCoordinator: 'recreated-empty-browser-live' | 'not-recreated-frozen';
  repairedAt: number;
};
~~~

The record contains no project/asset ID, project or asset hash, catalog payload, migration ID, candidate key/digest, report, setting, credential, vault entry, secret-presence bit, or raw secret. A catalog's `runtimeAttachment` is either `null` only before the first #45 transition, or exactly `{ attachmentKey, attachmentPath: 'attachments/<attachmentKey>.json', attachmentSha256 }`; the attachment does not name its catalog and therefore has no digest cycle. The commit SHA-256 commits that reference. After #45 every normal catalog publication copies the exact active reference. #46 stages a new attachment with the next full ownership vector/epoch and publishes one `ownership-attachment` catalog containing the unchanged project, asset, and retained-import maps plus that new reference. This is a normal `DurableFileOps` head publication, so an interrupted host/power failure exposes the prior complete catalog/attachment or the new complete catalog/attachment, never an attachment visible by directory scan.

For #45 and #46, candidate validation must compare the attachment body and digest to the candidate, report, target catalog, binding, and proposed `PermanentActiveOwnershipV1`: `libraryId`, `libraryRootId`, canonical installation ID/origin, all four ownership values, and `storageModeEpoch` must match exactly. The source-side pending binding includes the same attachment reference. Activation requires the target head/catalog to name that exact attachment before the one `meta` transaction marks the binding active and writes the matching permanent record. A later ordinary project catalog may advance its own `CatalogRevision` only while retaining the same attachment reference; a later ownership transition is the only operation allowed to replace it.

On normal startup, the runtime obtains only the one configured root/library ID and stable runtime identity from installation metadata. It resolves that known root through the managed-root checks, validates `library.json`'s `libraryId` and `libraryRootId`, then validates `head.json`, its exact catalog, and the catalog-named attachment's canonical bytes/path/digest. It verifies the attachment's installation ID and canonical registered Origin against the stable identity metadata. The runtime never opens, reads, scans, or otherwise accesses browser IndexedDB; it trusts this file-library attachment/head for provisional read-only bootstrap and requires the browser-resident coordinator to supply the ledger cross-check below before accepting a target write. No bootstrap step scans another library, attachment, commit, migration, browser Origin, or Chrome profile.

~~~ts
type BrowserLedgerChallengeV1 = {
  format: 'lumina-browser-ledger-challenge';
  version: 1;
  assertionId: string; // lowercase UUID v4, single use until expiry
  installationId: string;
  registeredOrigin: string;
  library: { libraryId: string; libraryRootId: string };
  attachment: { attachmentKey: string; attachmentSha256: string };
  targetCatalog: CatalogRevision;
  issuedAt: number;
  expiresAt: number; // issuedAt + 60 seconds
  nonce: string; // 256-bit base64url CSPRNG value
};

type BrowserLedgerAssertionV1 = {
  format: 'lumina-browser-ledger-assertion';
  version: 1;
  assertionId: string;
  challengeSha256: string; // hash of the complete challenge object
  installationId: string;
  registeredOrigin: string;
  library: { libraryId: string; libraryRootId: string };
  attachment: { attachmentKey: string; attachmentSha256: string };
  observedAt: number;
  observation: 'present' | 'cleared' | 'invalid';
  openedDatabaseVersion: number | null;
  permanentOwnership: PermanentActiveOwnershipV1 | null;
  permanentOwnershipSha256: string | null;
  retainedBindings: readonly {
    bindingSha256: string;
    activation: 'pending' | 'active' | 'recovery_failed';
    storageModeEpoch: number;
    storeOwnership: Record<'projects' | 'history' | 'assets' | 'settings', string>;
    targetCatalog: CatalogRevision;
    catalogDigest: string;
    attachment: { attachmentKey: string; attachmentSha256: string; libraryId: string; libraryRootId: string } | null;
  }[];
};
~~~

The runtime exposes `beginBrowserLedgerAssertion` only on the existing authenticated loopback bridge session. It creates the canonical challenge above, binds it to the already validated file attachment/current catalog and bridge session, and sends it only to the coordinator at its exact registered Origin. The coordinator is the only actor that opens the browser `IDBFactory`: it verifies the challenge origin/installation/attachment, opens `lumina-web` at the current compatible schema, and reads the ownership ledger, permanent record, and retained binding summaries in one `meta` readonly transaction. It then sends the canonical assertion through `submitBrowserLedgerAssertion` on that same authenticated bridge session. The transport proof is checked outside the assertion bytes, is bound to the assertion ID, Origin, session, nonce, and expiry, and is never put in a catalog, `meta` record, diagnostic, or log. `challengeSha256` and the assertion's canonical SHA-256 are computed with `RFC8785-JCS-SHA256-v1`; neither object self-hashes.

For `observation: 'present'`, every included permanent/binding value is reread from the same transaction and the assertion must contain the complete permanent record, its digest, and all retained binding summaries in UTF-8 binding-digest order. A normal existing database with missing/malformed ledger data reports `invalid` without raw values. `cleared` is permitted only when the coordinator observed `onupgradeneeded.oldVersion === 0`, aborts that upgrade without creating a database, and reports no fabricated ledger. The coordinator must not write, recreate, migrate, or repair a source store while producing an assertion. A lost assertion response is replayed with the same bytes and authenticated session until the 60-second challenge expiry; the runtime returns the exact cached result for a duplicate assertion ID/SHA-256. A new challenge is required after expiry or runtime restart.

The runtime accepts a `present` assertion only when its challenge/session/origin/identity/attachment/current catalog all match, its permanent record and every retained active binding agree with the file attachment, ownership vector, and a nondecreasing epoch, and no `recovery_failed` binding covers an owned store. It then returns `ledger_verified` and enables target writes for that attachment epoch. A matching `pending` binding whose target catalog/attachment is already the current head returns retryable `attachment_activation_pending`: the browser coordinator keeps the ownership/activation lease and the runtime blocks all target mutations until the coordinator completes the one `meta` activation transaction. An absent/expired assertion returns retryable `browser_ledger_assertion_required`; a failed bridge/origin/nonce proof returns non-retryable `browser_ledger_assertion_denied`; `invalid`, a mismatch, a lower epoch, or a `recovery_failed` binding returns non-retryable `target_attachment_invalid`. In every non-verified branch, the runtime is the write blocker and the coordinator must not attach a writable file adapter. Neither actor chooses browser fallback or rewrites the other side during normal startup.

A cleared browser database is a distinct repair case, not proof that ownership can return to the browser. After #45, a matching `observation: 'cleared'` assertion against a valid known root/attachment makes the runtime return `browser_attachment_repair_required` and requires explicit local maintenance authorization. This repair is eligible only from an assertion backed by an open whose `onupgradeneeded.oldVersion === 0`; a nonempty database with a missing/different ledger is an `invalid` assertion/invariant mismatch preserved for operator repair, not evidence that its frozen source records are clear. The repair reopens only at the current cutover schema and uses that exact-version upgrade transaction to seed the complete ledger and `PermanentActiveOwnershipV1` from the attachment's existing epoch (never `0`), and write one immutable canonical `BrowserAttachmentRepairV1` at `browser-attachment-repair:<repairId>`. Its attachment/library/ownership/epoch values must exactly equal the attachment and seeded permanent record; `cutoverSchemaVersion` must equal the opened database version, and `settingsCoordinator` is `recreated-empty-browser-live` if and only if the resulting settings owner is browser-live, otherwise it is `not-recreated-frozen`. A concurrent ledger, attachment, epoch, ownership, or schema mismatch aborts without a partial repair. The receipt contains no project/asset identifier or hash, setting object, credential, vault locator, migration selector, or secret. The repair never recreates or writes the frozen `projects`, `history`, or `assets` stores or source records. While #45 leaves `settings` browser-live, the authorized repair may recreate only its `meta` and `settings` coordinator surfaces: `settings-storage` starts absent and a compatible settings adapter may save newly entered browser-owned values, but it may not infer, recover, or transfer the cleared values. After #46 the repair recreates no `settings` store or record; ordinary settings attach only through the validated preferences pointer and vault attachment.

If a `present` browser assertion reports `meta` that differs from the file attachment, normal startup never overwrites either record. Within the retention window, maintenance may repair the permanent record only when the retained active binding independently matches both sides; otherwise it preserves both records for explicit operator repair. After compaction, explicit local maintenance authorization may repair a proven browser-clear case only from the known-root attachment and stable identity, never from an unbound candidate or a scanned historic catalog. The repair retains the attachment epoch and owners, never recreates a frozen writer, never writes a fake cutover binding, and never resets a mode to browser-live. A lower-epoch catalog/attachment against a surviving ledger is an anti-rollback failure. If both independent browser evidence and the file-root evidence were externally replaced with an older backup, absence alone cannot prove a downgrade safe: normal attachment remains blocked and only an explicit verified restore/operator-repair workflow may proceed. Installation metadata remains a locator/identity only; it must not cache the attachment key/digest, owner vector, epoch, catalog, project/asset evidence, or migration evidence to circumvent these checks.

Conformance tests must delete the browser database after #45 and after #46, verify no automatic repair or frozen-store recreation, then exercise the authorized repair and assert the canonical `BrowserAttachmentRepairV1` and seeded ledger have the attachment's exact library/root/ownership/epoch and the current schema version. They must test missing/malformed attachment, wrong root ID, installation ID/origin mismatch, lower-epoch attachment, permanent-record mismatch, a retained binding-assisted repair, and a post-compaction repair. They must also prove that the runtime can validate only the root/head/attachment before receiving a challenge-bound assertion, never calls an IndexedDB API, blocks writes for a missing/expired/mismatched/invalid assertion, accepts exactly one matching challenge/session/origin assertion, returns the cached result on an exact retry, and requires a new challenge after restart/expiry. Each case proves that normal readers attach only when both durable sides agree, that a #45 cleared settings record is absent but browser-live after authorized repair, and that #46 never falls back from preferences/vault to a recreated settings record.

| IndexedDB store | Before #45 | After successful #45 | After successful #46 |
| --- | --- | --- | --- |
| `projects`, `history`, `assets` | Browser adapters are the sole normal writer. | Runtime file-library adapters own live project facts. The IndexedDB stores remain retained, frozen read-only recovery evidence. | Unchanged. |
| `settings` | Browser settings adapter owns the live mixed `settings-storage` record. | Still browser-owned and live. #45 neither sanitizes/migrates settings nor transfers any credential or token. | Non-secret preferences are owned by the runtime preferences file and provider credentials/tokens by platform credential storage. The IndexedDB settings store then becomes frozen read-only recovery evidence. |
| `meta` | Browser schema/control records. | Ownership/epoch ledger and migration coordination. | Same coordination role with the next ownership/epoch ledger. |

Each ownership change advances `storageModeEpoch`; #45 records the project/history/asset transition while recording `settings` as browser-live, and #46 records the settings transition. A frozen store is not a normal browser read fallback: its bytes remain only for the bounded maintenance recovery contract below.

### Exclusive stale-tab fence and durable snapshot barrier

Both stages use the same exclusive migration lease. The migration-capable release reserves two strictly monotonic database versions: `fenceSchemaVersion` and a later `cutoverSchemaVersion`. The former is a durable pre-snapshot write barrier, not an advisory BroadcastChannel message. A lease holder announces preparation, rejects new compatible source write work as retryable `migration_in_progress`, and requires each compatible tab to account for every open transaction. A tab either lets an in-flight write commit before acknowledgement or explicitly aborts it and reports that operation as interrupted; it acknowledges only after it closes its IndexedDB connection.

The holder then opens `lumina-web` at `fenceSchemaVersion`. Its schema-version upgrade transaction writes one `migration-fence:<migrationId>` record in `meta` containing the `migrationId`, `candidateKey`, exact affected-store scope and `state: 'snapshot-fenced'`. Every compatible `projects`, `history` or `assets` source write transaction must include `meta` in the same `readwrite` IndexedDB transaction, read that record before its first source mutation, and fail with typed retryable `migration_in_progress` with no source-store side effect when its store is fenced. The shared `meta` scope serializes a previously admitted write with the barrier transaction: a write that passed the check commits before the barrier and is in the snapshot; after the barrier commits, every later compatible write sees the fence. This is the required source-write fence even for a deployed compatible bundle that did not receive the in-memory announcement.

A compatible `settings` transaction also verifies the ownership ledger in its transaction, but a #45 fence does not include `settings`: while its ledger owner is browser-live it continues to write the mixed `settings-storage` record. It may be briefly interrupted by `versionchange` and then retries only after reopening at the current compatible schema and confirming that settings is still browser-live. No #45 credential transfer, settings sanitizer, whole-database freeze, or settings write rejection is permitted.

Every compatible connection installs `versionchange` handling that stops new transactions and closes the connection. The fence schema upgrade gives a pre-fence bundle that reopens its prior version `VersionError`; it must surface an upgrade-required state and must not fall back to an unversioned open, recreate/delete the database, choose another Origin, or attempt any direct write. A stale connection that cannot acknowledge/close blocks the fence upgrade. The lease has a bounded deadline; expiry aborts the pending upgrade, so no snapshot starts. A timed-out `onupgradeneeded` rechecks the lease and aborts, so it can never commit later. The source snapshot begins only after the durable fence commits and reads only the stores in its scope.

### Final source commit, activation, and recovery

Once the fenced source snapshot, report and exactly one staged candidate validate, the holder repeats the close acknowledgement and opens `lumina-web` at `cutoverSchemaVersion`. Its single IndexedDB schema-version upgrade transaction retains every source record and atomically writes the complete per-store ownership vector, the next `storageModeEpoch`, and the full canonical `CutoverBindingV1` envelope with `activation: 'pending'`. It verifies that the durable fence has the same `migrationId`, `candidateKey`, scope, candidate/report/catalog digests, target catalog, and target attachment reference before doing so. This is the source-side commit point; it does not publish a target by inference or by scanning staging, and no #45 operation may have mutated a user record or Blob before it.

After that transaction commits, only the named candidate is eligible. Under the maintenance lease, startup or the original holder uses the binding to apply this deterministic rule:

1. If the target head is exactly the bound `targetCatalog`, its computed `catalogDigest` matches, and that catalog names the bound attachment with its exact digest, validate the one named candidate and report, atomically mark the same binding `active` and write the matching `PermanentActiveOwnershipV1`, then release only that candidate's active staging control files.
2. If the target head is exactly the candidate record's validated prior catalog and exactly one `staging/<candidateKey>/publish.json` matches every bound ID, candidate/report/catalog digest, target catalog, and target attachment, publish that candidate once, atomically mark the binding `active` and write the matching `PermanentActiveOwnershipV1`, then release only its active staging control files.
3. A missing, duplicate, malformed or digest-mismatched named candidate/report, or any other target head, marks the binding `recovery_failed`. It neither promotes a different candidate nor revives a browser writer. Unrelated staging transactions remain subject to the normal library recovery rules and are not deleted or selected by this migration recovery path.

Before the final source-side transaction, a crash, validation failure, blocked timeout or explicit cancellation creates the exact candidate's failed-publication quarantine, then removes only that attempt's fence, lease/acknowledgement, transfer-progress/ready, and candidate-bound recovery records as specified above. Startup observes a matching durable fence with no `CutoverBindingV1` as exactly that pre-commit case: it creates that quarantine, writes the exact abort receipt, and never publishes the candidate. Ownership remains browser-live, and the compatible browser adapter resumes source writes; the schema is intentionally not downgraded, so old bundles continue to receive `VersionError`. A crash before the fence transaction leaves the prior database version and ownership intact. After the final source-side transaction, affected stores are frozen even if the process crashes before target publication; recovery follows the three rules above and never rolls back ownership. Recovery may compare, create a user-authorized descendant recovery catalog, or produce the labelled admitted forensic export defined below, but cannot reattach an affected store as a browser writer.

New compatible clients read the complete ownership vector and exact `storageModeEpoch` inside every transaction and rebuild their adapter after an epoch mismatch or `versionchange`. A requested write to a frozen store returns typed non-retryable `frozen_store_write` with the store and observed epoch, not a retry or a browser fallback. Acceptance tests for each transition must prove an in-flight admitted write is captured, an aborted write is reported interrupted, the durable fence rejects a post-fence stale compatible write, every compatible tab acknowledges and closes, an unresponsive connection times out with no ownership/epoch change, and `versionchange` closes a racing connection. They must inject crashes before the fence, between fence and source commit, and after source commit; verify an old-version reopen gets `VersionError` without a fallback write; and verify a new client gets the typed frozen-store rejection. The #45 fixture must also begin with an absent history record, prove that only the staged projection is hashed/transferred and that a failed attempt leaves all user-store key sets/values/Blob bytes unchanged while candidate `meta` sidecars are removed; it additionally proves compatible settings writes succeed before and after the project/history/assets commit. The #46 case proves settings freezes only after its own epoch commit.

### #45 project library cutover

The browser-resident `BrowserMigrationCoordinator` is the only migration participant that opens `lumina-web`: it runs at the registered Origin, owns the exclusive lease, `versionchange` close protocol, schema-version fence, `meta` write barrier, and the one multi-store read-only source snapshot. It opens the affected stores through the browser's `IDBFactory`, reads the fenced `ProjectRecord`, history, `AssetMetadata`, immutable Blob values, and only its matching `meta` recovery/coordination evidence from that snapshot, runs `lumina-project-migration-admission-v1` there, and never includes `settings` in #45. The runtime never opens, reads, scans, or otherwise accesses browser IndexedDB directly; it receives only the admitted project/history/metadata projection and eligible Blob bytes.

The current protocol/manual launcher is not that source-selection proof: `installedRuntime` delegates `lumina://open` to the OS-default browser, which may be Edge or a different Chrome profile. It is therefore an unsupported current gap for shared connected-Chrome continuity and cannot be counted as #45 acceptance evidence. Before target #45 acceptance, the launcher path must be configured to target the user-approved connected-Chrome executable/profile and prove, before the fence, that the coordinator is at the registered Origin in that same profile; a missing/mismatched proof fails closed and asks for repair/connection rather than opening another browser context. This is a prerequisite contract only; this ADR does not implement that launcher change. `canvas_open` remains the distinct current plugin path that opens or focuses a URL in the already connected Chrome.

After user approval and the durable source fence, the coordinator requests one authenticated, single-use `BrowserMigrationTransferV1` capability from the local runtime. The capability is bound to the installation ID, exact registered Origin, existing authenticated bridge session, `migrationId`, `candidateKey`, transfer protocol version, scope, and a finite expiry. The runtime accepts frames only from its loopback peer carrying that capability and the exact Origin/bridge proof; it does not expose this route to MCP, another Origin, a different installation, or an unauthenticated local process. Capability values and frame bodies are excluded from logs and diagnostics.

The transfer uses ordered, versioned frames. JSON payloads are RFC 8785 canonical UTF-8 representations of the admitted projection; each Blob is sent as raw byte chunks with a fixed admitted `assetId`, offset, total byte count, and raw-byte SHA-256. Every frame has exactly `{ format: 'lumina-browser-migration-frame', version: 1, migrationId, candidateKey, sequence, kind, payloadDescriptor, payloadSha256, previousFrameSha256, frameSha256 }`. `payloadDescriptor` is exactly `{ encoding: 'rfc8785-jcs-json' }` for JSON or `{ encoding: 'raw-bytes', assetId, offset, totalByteCount }` for a Blob chunk. The `frameSha256` preimage is exactly the `RFC8785-JCS-SHA256-v1` canonical object containing every listed member except `frameSha256`; all of those members are required, including `payloadDescriptor`, `payloadSha256`, and `previousFrameSha256`. `payloadSha256` is the digest of the canonical JSON payload or raw Blob chunk. Sequence is a non-negative safe integer and starts at `0`: `begin` is sequence `0` and its `previousFrameSha256` is the fixed initial predecessor `0c1e563eb7547b8703779582176571ca4df0386a3285a510b6874456f662960a`, the `RFC8785-JCS-SHA256-v1` digest of `{ format: 'lumina-browser-migration-frame-chain-anchor', version: 1 }`. At every later sequence, `previousFrameSha256` equals the immediately preceding frame's `frameSha256`; no frame hashes itself.

The canonical order is exactly: `begin`; for each `source.fingerprintManifest.projects` member ordered by its UTF-8 project ID, one `project` frame followed immediately by its one `history` frame; for each `source.fingerprintManifest.assets` member ordered by its UTF-8 asset ID, one `asset-metadata` frame followed immediately by all of that asset's `asset-bytes` frames at offsets starting at `0` and increasing by the raw payload length; then one `complete` trailer. Thus the kind sequence is `begin`, zero or more `project`/`history` pairs, zero or more `asset-metadata`/one-or-more-`asset-bytes` groups, then `complete`. The `begin` payload also carries one positive safe-integer `assetChunkByteLength`; every non-final non-empty chunk has exactly that length, the final non-empty chunk is no longer than it, and a zero-byte Blob has exactly one zero-byte chunk at offset `0` with total byte count `0`. No frame may be omitted, interleaved, repeated, or follow `complete`. `begin` carries the browser-calculated candidate binding material, the chunk length, fence schema version, scope, expected next `storageModeEpoch`, target ownership vector, retention deadline, and current `CatalogRevision` plus `catalogDigest`; the runtime only validates, stores, and returns that material and never reads IndexedDB to invent it. The canonical JSON `complete` payload is exactly `{ format: 'lumina-browser-migration-complete', version: 1, sourceFingerprint, finalFrameSha256, frameCount }`: `finalFrameSha256` is the preceding non-`complete` frame's hash and must equal the trailer header's `previousFrameSha256`, never the trailer's own hash. `frameCount` is a safe integer that counts every frame including `begin` and `complete`, is at least `2`, and requires `complete.sequence === frameCount - 1`. The trailer's independently computed header hash is named `completeFrameSha256`; it is not present in the trailer payload. After it, the runtime constructs the immutable candidate `publish.json` and report and independently recomputes every frame, candidate, catalog, asset-reference, report, and binding-material digest.

The coordinator chooses `assetChunkByteLength <= admission-registry-v1.json.limits.maxTransferChunkPayloadBytes`; the runtime rejects a JSON payload above `maxTransferJsonPayloadBytes`, a raw chunk above `maxTransferChunkPayloadBytes`, a canonical header above `maxTransferHeaderBytes`, or a combined frame above `maxTransferFrameBytes` before staging it. It also totals every accepted canonical JSON/raw payload byte and rejects the candidate with `migration_transfer_too_large` before the aggregate exceeds `maxBrowserMigrationTransferAggregateBytes`. A per-asset declared count above `maxDurableLibraryAssetBytes`, a registry count/MIME violation, or a frame limit has the same no-candidate outcome. These target limits intentionally do not route a large local asset through the 64 MiB Gateway temporary-media path.

Before returning an acknowledgement, the runtime durably stages the exact admitted payload and its canonical header, then advances one candidate-local progress record that binds every accepted sequence to its kind, `payloadSha256`, `frameSha256`, and predecessor. On restart or reconciliation it rehashes the staged payloads and headers from the fixed initial predecessor, requires contiguous sequences and the canonical order, derives exactly one `nextSequence` and expected predecessor, and quarantines only that candidate on a gap, duplicate, bad hash, wrong order, illegal chunk boundary, or trailer inconsistency. A retry of the same sequence and exact header/payload returns `already_accepted`; a different hash, payload, gap, duplicate, expired capability, or mismatched binding rejects and quarantines that one candidate without selecting another. Once the trailer's source fingerprint, predecessor, count, and `completeFrameSha256` validate, the runtime must durably write one canonical `lumina-browser-migration-candidate-ready` receipt before it sends any `candidate_ready` response. The receipt contains `{ migrationId, candidateKey, scope, sourceFingerprint, finalFrameSha256, completeFrameSha256, frameCount, candidateDigest, reportSha256, targetCatalog, catalogDigest, bindingMaterial }`, where `bindingMaterial` is exactly the `begin` material and no field is inferred later. It is the only response evidence, references the named immutable candidate/report, and contains no source payload or secret.

`reconcileBrowserMigrationCandidate` is the lost-response protocol. The browser calls it with the same authenticated bridge proof and `{ migrationId, candidateKey, sourceFingerprint, finalFrameSha256, completeFrameSha256, frameCount }`; `migrationId` is the idempotency key and maps to exactly one candidate key under the active fence. A matching ready receipt is revalidated against its candidate, complete trailer, report, target catalog, `catalogDigest`, and binding material, then returns the exact same `candidate_ready` value. A matching partial candidate returns `receiving` with its exact `nextSequence` and expected `previousFrameSha256` (and therefore the highest accepted sequence/frame hash), so the coordinator retransmits only from that sequence using the original ordered frames. A matching candidate with no accepted first frame returns `not_received`, so the coordinator may replay from sequence `0`. A mismatched query, duplicate ready receipt, or a ready receipt whose material differs from the fence rejects and quarantines only that candidate; it never substitutes another candidate or asks the runtime to read IndexedDB. The coordinator stores its acknowledged next sequence/predecessor, source fingerprint, final and complete trailer hashes, frame count, and the returned ready receipt in its matching `migration-fence` record. It may perform the final ownership upgrade only when that persisted receipt exactly matches a fresh reconciliation response and the fenced source fingerprint.

This handles a lost `candidate_ready` response without a second snapshot or a second candidate. If the browser process or lease dies before the final ownership binding, startup follows the pre-binding rule: it quarantines this one ready or partial candidate and clears this one fence; it does not automatically resume or promote it. If the source-side binding already committed, the existing pending-binding activation rules take over. This handoff is therefore retryable while its live fence exists, deterministic after a crash, and never grants the runtime an IndexedDB read path or a source-store write path.

1. While the ownership ledger marks `projects`, `history`, and `assets` as browser-live, their IndexedDB adapters are their only writers. Preflight makes the BrowserMigrationCoordinator acquire the exclusive lease, install the durable fence above, and take a read-only snapshot of only those stores. The #45 runtime never writes that source. The live settings record is outside this snapshot and remains browser-writable after the fence ends.
2. The BrowserMigrationCoordinator transfers every admitted ProjectRecord projection, admitted retained-history projection, and every non-staging admitted AssetMetadata/Blob in the successful source fingerprint through `BrowserMigrationTransferV1`, including unreferenced `active` and `deletion-candidate` assets with their exact lifecycle state. The runtime stages and validates the received values with the .lumina importer/exporter rules: admission version, parseable project/history JSON, declared schema/revision, complete asset-reference closure, matching metadata, byte counts, and SHA-256.
3. The runtime creates the project-library migration report described below at `migrations/<candidateKey>.json`, validates the unpublished catalog candidate against it, and stores no raw pre-admission project/history/metadata value, settings object, credential, token, or secret-derived value. The one immutable `staging/<candidateKey>/publish.json` must name the same `migrationId`, report path and `reportSha256`, exact prior/target `CatalogRevision`, and both prior/target `catalogDigest` values; its `candidateDigest` is the RFC 8785 hash of that immutable record and is copied with the report/catalog/binding material into the binding before the source-side commit. No other candidate can satisfy that binding.
4. Only after the staged target, immutable unpublished catalog candidate, and report validate does the final schema-version upgrade atomically persist the #45 ownership vector, `storageModeEpoch`, and its `pending` binding. The runtime then uses the activation rule above before attaching project/history/asset clients to file adapters. The corresponding browser stores remain frozen recovery evidence for the one compatibility release required by #45; `settings` remains live in IndexedDB.

### #45 fenced staged history projection and ProjectRecovery parity

The current Web adapter reads an absent `history/<projectId>` record as the in-memory string `{"past":[],"future":[]}`; that fallback is current compatibility behavior, not a durable #45 source representation. #45 must never materialize that fallback by writing `history/<projectId>`. After the durable fence commits, the coordinator takes one read-only `projects`/`history`/`assets`/`meta` snapshot in UTF-8 project-ID order and creates a candidate-local `HistorySnapshotProjectionV1` for every captured project. A present history record supplies its observed string; an absent one supplies only the staged projection `{ sourcePresence: 'absent', historyJson: '{"past":[],"future":[]}' }`. It is sent in the history frame and persisted only in runtime candidate/target files, never as a new source record. The effective defaults for every following v1 preimage are: observed absent project `schemaVersion` -> effective `1`; observed absent project `revision` -> effective `"r0"`; history schema -> `lumina-project-history` version `1`; and the parsed empty history value -> `{ past: [], future: [] }`.

An orphan history record, a history record whose `projectId` differs from its key, a non-string history value, malformed JSON, or a project/history mismatch is `history_snapshot_invalid`. A secret-bearing present history is not replaced with the empty projection; it reaches the normal fail-closed admission rule. An absent record is valid only through the exact `sourcePresence: 'absent'` projection above. The coordinator rejects the attempt if a captured project has anything other than one valid stored history or that one exact staged absence projection, or if an orphan record exists. The snapshot, frames, fingerprint, report, target manifests, and recovery validation all carry the same project count, history count, source-presence flag, effective schema/revision defaults, and history hashes. No pre-fence pass writes a project, history, asset, settings, or Blob record.

The current Web adapter deliberately strips `ProjectRecord.recovery` from `StoredProjectRecord`, and its `migration_failed` state is an in-memory set that disappears on restart. A #45-compatible browser release must make an observed recovery durable in the explicit browser `meta` ledger, without changing a user store. When its source mapper observes `unsupported_schema` or `migration_failed`, it writes or revalidates one `BrowserProjectRecoveryObservationV1` at `project-recovery-observation:<projectId>`; it includes the source schema mapping, source-presence/schema fields that bind the staged history projection, recovery value, and no-redaction-admitted canonical project/history digests. The mapper returns `recovery_observation_persistence_failed` rather than exposing a memory-only recovery state if that `meta` write cannot commit. A source change that no longer matches the observation invalidates it before that project is considered migratable; a later fresh mapper pass must replace it, never reuse a stale observation.

~~~ts
type BrowserProjectRecoveryObservationV1 = {
  format: 'lumina-browser-project-recovery-observation';
  version: 1;
  projectId: string;
  observedStoredSchemaVersion: number | null;
  effectiveSchemaVersion: number;
  schemaMapping: 'missing-to-v1' | 'zero-to-v1' | 'identity-v1' | 'unsupported';
  historySourcePresence: 'stored' | 'absent';
  historySchema: {
    format: 'lumina-project-history';
    version: 1;
    projectRevision: string;
  };
  recovery: ProjectRecovery;
  projectSha256: string;
  historySha256: string;
  observedAt: number;
};
~~~

After the fenced read-only snapshot validates, the coordinator writes a candidate-bound copy in `meta`, not in a user store. Each `migration-project-recovery:<migrationId>:<projectId>` record is canonical `BrowserProjectRecoveryEvidenceV1` and has the exact shape:

~~~ts
type BrowserProjectRecoveryEvidenceV1 = {
  format: 'lumina-browser-project-recovery';
  version: 1;
  migrationId: string;
  candidateKey: string;
  projectId: string;
  observedStoredSchemaVersion: number | null;
  effectiveSchemaVersion: number;
  schemaMapping: 'missing-to-v1' | 'zero-to-v1' | 'identity-v1' | 'unsupported';
  historyProjection: {
    sourcePresence: 'stored' | 'absent';
  };
  historySchema: {
    format: 'lumina-project-history';
    version: 1;
    projectRevision: string;
  };
  recovery: ProjectRecovery;
  projectSha256: string;
  historySha256: string;
  observationSha256: string;
  recordedAt: number;
};
~~~

`observedStoredSchemaVersion: null` means the field was absent, not `0`; the source mapper records `missing-to-v1`, `zero-to-v1`, or `identity-v1` only after it validates the effective v1 document. A non-v1 source schema records `unsupported` and `recovery: { reason: 'unsupported_schema' }`. `historySchema.projectRevision` is the effective project revision used by the exact v1 history preimage, including an absent-source projection. `observationSha256` is the canonical digest of the exact `BrowserProjectRecoveryObservationV1` it copies; the sidecar may contain only that binding/digest and the schema/recovery/presence fields shown, never raw project JSON, history JSON, Blob bytes, settings, or a secret-derived value. Before either the durable observation or candidate-bound evidence writes its source hashes, the source must pass the later-defined `lumina-project-migration-admission-v1` no-redaction mode; this prevents a credential-bearing raw representation from becoming browser migration evidence. A compatible tab that knows a pending `migration_failed` state must persist/revalidate its observation before it acknowledges a migratable source. The coordinator then requires every fenced project either to have this exact matching candidate-bound evidence or to prove from the observed source schema and validated mapper that recovery is `null`; an unsupported schema can never silently become `null`. A historical memory-only failure that vanished before the compatible durable-observation release is not reconstructible evidence and blocks the initial #45 migration rather than being guessed.

Attempt-scoped records are limited to `migration-fence:<migrationId>`, its lease/acknowledgements/transfer progress/ready receipt, and `migration-project-recovery:<migrationId>:<projectId>`. Before the ownership commit, abort first writes and flushes the named file-library quarantine, then one `meta` transaction guarded by that same fence removes exactly those candidate-scoped records and writes one value-free canonical `migration-abort:<migrationId>` receipt `{ format: 'lumina-browser-migration-abort', version: 1, migrationId, candidateKey, quarantineManifestSha256, removedMetaKeys: <UTF-8-byte-sorted exact keys>, abortedAt }`. It never removes another attempt's records or a still-valid `project-recovery-observation:<projectId>`. After the ownership commit, the candidate-bound records become read-only evidence retained with that binding through its compatibility window; target snapshot manifests persist the same observed/effective schema, history projection/schema, recovery value, and evidence digest. When recovery is non-null, the target also persists the matching no-redaction-admitted evidence and unmodified credential-free source project/history representations under that project's `recovery/r_<key>*` paths, hashes all three, and reopens the target `ProjectRecord` in the same read-only `ProjectRecovery` state after every runtime restart. It never runs an unsupported or failed source through a best-effort project rewrite.

For a pre-commit failed #45 attempt, “IndexedDB unchanged on failure” means the key set, serialized values, and Blob bytes of `projects`, `history`, `assets`, and `settings` are exactly as before the attempt; no missing history is added, no user record/Blob is rewritten or deleted, and the ownership vector and `storageModeEpoch` remain unchanged. The durable `fenceSchemaVersion` may remain because IndexedDB versions cannot be downgraded, and `meta` may retain only the pre-existing valid recovery observations plus the value-free abort receipt; its candidate sidecars/fence/lease/progress are gone. This is the target contract pending the required live #45 amendment; it does not claim that the current adapter has already implemented it.

### #45 secret-free project admission

`lumina-project-migration-admission-v1` is a fail-closed candidate- and target-write admission rule for project facts. It is deliberately narrower than the #46 settings/ordinary-export sanitizer: it admits only a safe project/history/asset projection to the #45 file-library candidate or a later runtime-file mutation, does not read or transform `settings`, does not create a preferences file or vault entry, and does not certify a normal `.lumina` export as URL-sanitized. #46 still owns the complete `lumina-settings-credential-free-v1` settings and ordinary-export URL rule and all credential-vault migration.

For an existing browser library, the BrowserMigrationCoordinator applies this rule to the fenced in-memory snapshot before it computes any canonical project/history/metadata hash, source fingerprint, transfer-frame JSON digest, request/manifest digest, runtime candidate, report, or target file. For a browser `.lumina` import, the compatible importer applies it after bounded archive-structure and Blob-byte verification, but before it creates `BrowserImportOperationV1`, stages a payload, calculates a durable/canonical request or manifest digest, or writes imported project/history/asset records; direct runtime `applyLibraryTransaction` imports apply the same rule before their admitted-payload/request digest or any staging. Streaming an untrusted archive only to prove ZIP framing or a Blob byte count may use transient raw bytes; it must not retain or copy an archive-entry hash, text value, parser error, or other raw-derived value into an operation record, source store, fingerprint, frame, candidate, report, quarantine, diagnostic, or log before admission succeeds.

The rule parses every serializable project value (`id`, `name`, revision/schema fields, nodes, edges, viewport, and retained history) and every AssetMetadata value, especially `sourceMetadata`, with duplicate-member detection and the canonical UTF-8 rules above. A versioned project/history/node schema registry must classify every member as a known scalar, user text, URL, asset reference, container, or optional sensitive member; an unknown node type, history entry, or object member has no pass-through interpretation and fails admission. `AssetSourceMetadata` is the one explicit exception: its key grammar, scalar-only value types, bounds, normalization, and unknown/nested rejection are exactly those in the registry and [structure contract](./library-schema.md#project-fact-admission-and-resource-limits), rather than a fixed list of current adapter keys. User text is not exempt: it is scanned as below. This preserves safe current scalar-map entries without assuming that a current importer/exporter can safely carry arbitrary JSON.

The policy normalizes a member name by retaining ASCII letters and digits, lowercasing them, and removing all other characters. A name containing one of `apikey`, `token`, `secret`, `password`, `authorization`, `credential`, `cookie`, `privatekey`, `clientsecret`, `accesskey`, `gatewayurl`, `signature`, or `signedurl` is sensitive. The same classifier applies to every grammar-valid `AssetSourceMetadata` key; its map values are never optional-sensitive, so a sensitive key fails rather than being omitted. The only lossy redaction permitted by v1 is to omit that complete member subtree when the registry marks that exact member optional-sensitive; a required or unclassified member fails with `project_secret_admission_failed`. No redaction record contains the source member name, path, value, length, presence bit, raw hash, or a secret-derived hash.

Every URL-classified string, and every user-text or `AssetSourceMetadata` string scalar whose trimmed ASCII prefix matches `^[A-Za-z][A-Za-z0-9+.-]*://`, `data:`, or `blob:`, must parse as an absolute `http:` or `https:` URL. It is admitted unchanged only when username, password, fragment, and query are all empty. An optional-sensitive URL member with any of those components is omitted; every other such URL fails. A user-text or `AssetSourceMetadata` scalar also fails when it is an ASCII-case-insensitive authorization value (`Bearer`, `Basic`, or `Token` followed by non-whitespace data), a three-segment base64url JWT, or a key-shaped token beginning (ASCII-case-insensitively) `sk-`, `rk-`, `pk-`, `AKIA`, `ghp_`, `github_pat_`, or `xox` followed by at least eight identifier characters. A registry field whose grammar cannot establish a non-credential value must fail rather than return an "unknown but allowed" result. These conservative rules may require a user to remove or re-enter ambiguous data; they may not silently persist it.

Admission produces either one parsed/redacted logical projection or the fixed value-free error `project_secret_admission_failed`. On success the browser discards the raw tree before handoff and computes every downstream hash only from the admitted projection using `RFC8785-JCS-SHA256-v1`; successful evidence records only the fixed admission version, never a redaction list/count. On failure it creates no operation/candidate/fingerprint/report and follows the ordinary pre-commit cleanup path (clear only its matching fence and keep browser ownership live). Thus a secret-bearing source remains recoverable only in the existing browser source until the user repairs it; it never becomes a runtime-file fact or migration evidence.

`ProjectRecovery` has the stricter no-redaction mode. Before `BrowserProjectRecoveryEvidenceV1` writes its source hashes, the raw recovery project/history representations must pass the same classifier with zero omitted members and no URL/token finding. Otherwise the sidecar is not written and #45 preflight fails before a fence/candidate; the runtime never preserves a redacted value as an "unmodified" recovery file. A recovery project that passes this mode retains the existing exact-source parity contract. Normal projects and imported projects use the admitted projection in their canonical hashes, transfer frames, source fingerprint, and target files; count/map parity is over that projection and every omitted optional-sensitive member is absent from both source evidence and target, never implicitly restored.

### Normal runtime project-fact admission

The same rule is mandatory for every future live runtime-file write, not only a browser migration or archive import. It does not retroactively change the current IndexedDB adapters. The target `applyProjectMutation` obtains the pinned visible record under the library lease, constructs the complete post-mutation project and retained-history values, and applies the rule before it creates `publish.json`, stages a payload, computes a project/history/manifest/catalog digest, or changes a catalog. This applies to `saveSnapshot`, `updateViewport`, and `rename` even when the caller changed only one field: retained history and every serializable field remain part of the proposed fact. `delete` validates only its project identity, expected revision, and catalog membership; it creates no new project/history/asset fact and cannot be blocked by attempting to re-admit a record it is removing.

The target `AssetRepository.write` is not a bypass around that command boundary. Before it allocates a persistent asset entry, stages or hashes Blob bytes, or writes metadata, the adapter assembles the complete proposed `AssetMetadata` (including runtime-generated ID/lifecycle fields and every `sourceMetadata` member) and applies the same registry and classifier. A lifecycle update such as `setDeletionCandidates` likewise admits the complete changed metadata before its next catalog digest. A multi-fact runtime command admits the complete post-mutation project/history projection and every new or changed metadata projection as one pre-publication set; it verifies the admitted project-to-asset reference closure before any member is staged.

The only v1 sanitization is the existing registry-authorized omission of an exact optional-sensitive subtree. A required, unclassified, malformed, URL/token-bearing, or otherwise unsafe member is never repaired, URL-rewritten, partially persisted, or converted into a deletion candidate: `applyProjectMutation` returns its defined `{ code: 'rejected', reason: 'project_secret_admission_failed' }` result and target `AssetRepository.write` rejects with `AssetRepositoryWriteError { code: 'project_secret_admission_failed', retryable: false }`. Neither result means a stale revision or a retryable storage failure, and neither schedules an automatic retry. The fixed error may be shown to the user, but its raw input, member path, length, hash, and parser details must not enter a catalog, staging record, fingerprint, report, diagnostic, or log.

Only after every proposed project/history/metadata value succeeds may the runtime discard the raw parsed values, derive asset references, and calculate `RFC8785-JCS-SHA256-v1` project/history/metadata/manifest/catalog bytes. `raw-bytes-sha256` of a Blob is calculated only after its assembled metadata has been admitted; byte staging and persistence happen after those digests. #46 remains solely responsible for complete ordinary-export URL sanitization, so this v1 rule must not be weakened into a best-effort archive sanitizer or claimed to prove that current exports removed every arbitrary credential-bearing URL.

Target conformance tests must submit the same unsafe project/history/user-text/`sourceMetadata` fixture through a browser migration, direct archive import, each non-delete `applyProjectMutation` variant, `AssetRepository.write`, and a lifecycle update. They must prove the permitted optional-sensitive omission is identical in every admitted projection; every other fixture returns the fixed rejection (`AssetRepositoryWriteError.retryable === false` for the asset path) with no Blob hash, staging entry, catalog revision, persisted metadata, or raw-derived log/evidence. A delete fixture for an already-visible record must still remove it from the live catalog without creating a newly admitted representation; its trash/cleanup lifecycle is defined below.



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

For a recovery project, the no-redaction admission verifier may parse only to reject a secret-bearing value; after it passes, neither its project strings nor its staged history projection is rewritten. Its project and history hashes are instead the following exact values; the `recovery` and source-schema values must equal the durable `BrowserProjectRecoveryEvidenceV1` sidecar. This is the representation copied to the target recovery files:

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
  historySchema: recoveryEvidence.historySchema,
  sourcePresence: recoveryEvidence.historyProjection.sourcePresence,
  historyJson: snapshotHistoryProjection.historyJson,
};
~~~

The normal history hash is this exact value, where `historyProjection` is the one fenced staged projection and `historySchema.projectRevision` is the same effective revision as the paired project canonical value. An absent source record is parsed into the stated empty `history` value only in this projection; its `sourcePresence` remains part of the preimage and it is never represented as an omitted history, implicit default, or source-store write:

~~~ts
const historyCanonicalValue = {
  format: 'lumina-migration-history-v1',
  sourcePresence: historyProjection.sourcePresence,
  historySchema: {
    format: 'lumina-project-history',
    version: 1,
    projectRevision: admitted.revision ?? 'r0',
  },
  history: historyProjection.history,
};
~~~

The asset metadata hash is the hash of this exact object, where `admittedAsset` is the one post-admission AssetMetadata projection; the asset byte hash is `raw-bytes-sha256` of the Blob byte sequence:

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

That source-evidence `metadataSha256` is not a substitute for a target catalog's metadata digest: source IDs can be remapped during import and the catalog must instead name the independently serialized `AssetMetadataDocumentV1` above. Before a target catalog publishes, it recomputes both forms, proves that the admitted logical fields/lifecycle and Blob bytes match the source-to-target mapping, and binds only the target-document format/version/path/digest in the catalog. A reader resolves metadata exclusively from that catalog entry; it never opens `assets/<assetKey>/metadata.json` or substitutes a newer version by asset key.
