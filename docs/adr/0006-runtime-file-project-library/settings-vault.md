---
status: accepted
parent: ../0006-runtime-file-project-library.md
---

# 运行时文件项目库：设置与凭据库

> **权威范围**：#46 清理、非秘密偏好、平台凭据库、settings cutover 和恢复 本文中的规范性条款是 ADR-0006 对该主题的唯一权威来源；根 ADR 只保留决定、状态、历史和导航索引。

## #46 settings sanitizer and evidence

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
  historySchema: {
    format: 'lumina-project-history';
    version: 1;
    projectRevision: string;
  };
  historySourcePresence: 'stored' | 'absent';
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

Pre-fence checks resolve every IndexedDB import operation without sweeping unrelated state; after the durable fence, the coordinator admits the complete read-only project/history/asset snapshot and creates only the staged history projections specified above. A successful capture contains one `SourceProjectEvidenceV1.historySchema`, `historySourcePresence`, and admitted history projection for every project, every remaining admitted AssetMetadata record with its exact `active` or `deletion-candidate` lifecycle state and complete Blob, plus every asset ID recursively referenced from admitted non-recovery nodes or retained history by the current `.lumina` exporter rules (`assetId`, `previewAssetId` and `lastFrameAssetId`). `SourceProjectEvidenceV1.assetIds` is the complete set of captured assets whose admitted `projectId` matches that project, not only the reference closure. A referenced ID without complete metadata and bytes fails validation. Any malformed/orphan history record, remaining `staging` record, operation without one owner, unresolved candidate-bound recovery evidence, or failed project admission fails preflight before the source fingerprint/candidate exists; it is never included as a successful `staging` evidence item or silently rewritten as `active`. A valid absent history is the explicit staged projection, not a failure and not a source write. Project IDs, asset IDs, each project's complete owned asset ID list, and transfer mappings are sorted by UTF-8 byte order before hashing.

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
      "projects": [{ "sourceSchema": "<observed/effective/version-mapping tuple>", "historySourcePresence": "<stored | absent>", "recovery": "<ProjectRecovery object or null, exactly observed>" }],
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
      "retainedUntil": "<source-side ownership commit plus 30 days>"
    }
  }
}
~~~

Before the #45 source-side commit, the runtime recomputes the complete admitted project/asset fingerprint with this same versioned algorithm and requires it to equal `source.fingerprint`; it also verifies the staged catalog against every report entry, every no-redaction-admitted candidate-bound recovery evidence/raw recovery file, every catalog-bound immutable metadata format/version/path/digest, and every non-staging asset mapping before it writes the three `validation` values. A failure before the durable ownership/epoch transaction creates the exact candidate quarantine and clears only its matching fence/attempt sidecars, leaving every browser user store under its prior ownership as defined above.

After the #45 ownership/epoch transaction commits, the frozen `projects`, `history`, and `assets` stores remain an explicitly read-only recovery/forensic source for the whole `cutover.indexedDbRecovery.compatibilityRelease` window, even when later file-library catalogs advance. They are never reopened as adapters, made writable, used as a silent browser fallback, or treated as a rollback head. `settings` remains on its normal browser path until #46. A read-only recovery use is eligible only while `now <= cutover.indexedDbRecovery.retainedUntil`, the running runtime still recognizes that compatibility release, and all of the following are true under the maintenance lease: the report validates at its named library path; the matching `CutoverBindingV1` envelope is `active`, has the report's migration/key/report/catalog/catalog-digest/expected epoch, matching `recoveryRetainedUntil`, and frozen ownership; the exact initial catalog/head named by `target.initialCatalog`, `initialCatalogDigest`, and `initialHeadSha256` validates; the current head validates and its retained frozen-source lineage is the direct complete chain back to that initial catalog; every lineaged catalog keeps project/history/asset runtime ownership, while a later #46 attachment may change only the separately bound settings vector; and a fresh v1 admission plus admitted-source-fingerprint computation against the frozen source exactly equals `source.fingerprint`, including every candidate-bound recovery evidence/schema/history-presence mapping and every active/deletion-candidate asset.

The initial catalog is the immutable base, and the pinned current catalog is the authoritative aggregate of all target deltas. A maintenance recovery may use the frozen source only to compare that base, produce an explicitly labelled admitted forensic/recovery export, or create one user-authorized new full catalog whose `previousCommitId` is the pinned current head. For the latter it performs a three-way check of the initial catalog, current catalog, and frozen source: a target object changed after cutover is preserved and any conflicting source restoration is rejected; a requested additive restore receives deterministic new IDs/reference rewrites like an import; every restored asset receives a new immutable metadata document and catalog link. It may never move `head.json` back to the initial catalog, overwrite a later target delta, overwrite a current asset metadata version, or select the source as an active writer. An ordinary `.lumina` export remains subject to #46's complete sanitizer contract; #45 recovery evidence is not proof that ordinary export sanitization has occurred. Any failed comparison or merge refuses recovery without attaching a second writer.

At compatibility-window expiry, maintenance may remove only the named report, binding, and frozen-source lineage roots after validating the permanent `PermanentActiveOwnershipV1` ownership/epoch record; ordinary catalog retention then applies. Advancing the file library never by itself expires, deletes, or weakens the frozen IndexedDB evidence. The source records are not auto-deleted at expiry or compaction: their eventual deletion remains a separately authorized, explicit data-deletion operation with its own evidence and must never be disguised as target GC.

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

After both provisional destinations validate, #46 stages the required next `ownership-attachment` catalog and performs the next `cutoverSchemaVersion` IndexedDB upgrade transaction. It advances `storageModeEpoch`, changes only `settings` from browser-live to frozen recovery evidence, retains the record without exposing it to ordinary clients, and atomically writes its full `pending` `CutoverBindingV1`. The pending binding must match the report, candidate digest, exact prior and target attachment catalogs, target attachment digest, expected epoch, source fence, prior/target preference-pointer digests, selected vault platform/mapping, and prior/target active-marker digests. This is the only point after which an attachment catalog or candidate preference pointer may be published and browser settings writes may not resume.

Under the maintenance lease, activation is always ordered as follows: validate the exact pending binding and all targets; durably publish the named `ownership-attachment` catalog/head; durably publish the named `PreferencesPointerV1`; replace the fixed vault active marker with the same candidate-scoped target marker; then atomically write that binding as `active` and its matching full `PermanentActiveOwnershipV1` attachment in IndexedDB `meta`. Each step is idempotent. Before the attachment catalog is published, the coordinator drains target project clients; from that publication until the final meta transaction they receive only retryable `attachment_activation_pending`, so no ordinary client attaches the new project, preference, or credential target against a partial ownership vector. Startup and the original holder must resolve every observable crash state with this table; they never select a file or vault collection by directory scan.

| Durable observation for the one bound `(migrationId, candidateKey)` | Required validation and action | Result |
| --- | --- | --- |
| Matching settings fence, no binding | The fence is the only selector. At any preparation phase, accept only the direct-name `not_prepared` result before a current index exists, or run indexed cleanup only for its candidate and require the value-free `all_indexed_entries_absent` receipt before removing its prepared marker/provisional paths. Each present immutable preference, publish, or report record must have the exact ID/key; a malformed one is retained only in this candidate's invalid quarantine, never promoted. When any immutable non-secret payload exists, write and flush that candidate's value-free quarantine manifest before clearing only that fence. | Settings remains browser-live; retry starts a new preparation. |
| `pending`; current library head is the bound prior attachment catalog, current preference pointer is the bound prior pointer, fixed active marker is the bound prior digest, and the candidate marker is `prepared` | Validate binding/report/candidate/catalog/attachment/epoch, frozen source hash, preference format/version/SHA-256, target-pointer digest, exact prepared-marker probe, and matching in-vault seed/current index. Publish only the bound target attachment catalog with `DurableFileOps`, then continue. | Resume at the next row's pointer publication. |
| `pending`; current library head is the exact bound target attachment catalog, current preference pointer is the bound prior pointer, fixed active marker is the bound prior digest, and the candidate marker is `prepared` | Revalidate the same predicates including the matching attachment and in-vault seed/current index. Publish only the target pointer with `DurableFileOps`, then continue. | Resume at the next row's marker activation. |
| `pending`; current library head is the exact bound target attachment catalog, current pointer is the exact target pointer, fixed active marker is the bound prior digest, and the candidate marker is `prepared` | Revalidate the same predicates including the matching attachment and in-vault seed/current index, replace only the fixed active marker with the bound target marker, then atomically mark that binding `active` and write its matching full permanent attachment. | Runtime projects, preferences, and credentials become attachable. |
| `pending`; current library head is the exact bound target attachment catalog, current pointer is the exact target pointer, and fixed active marker is the bound target digest | Revalidate the same predicates including the matching attachment and in-vault seed/current index, then atomically mark that binding `active` and write its matching full permanent attachment. | Resume completes without a second catalog, pointer, or vault write. |
| `active`; current library head has the bound attachment, current pointer has the bound preferences owner, fixed active marker is the bound target digest, and the permanent attachment matches | Revalidate the immutable initial preference candidate/report, binding/source predicates, attachment, and current owner-preserving pointer/target; remove only candidate transfer/staging control files. Retain the immutable initial candidate, active private prefix/marker, report, and binding for their stated retention. | Ordinary target remains active; later pointer updates keep the same owner and attachment. |
| Any other head/catalog/attachment, pointer, vault state, missing/mismatched report or candidate, wrong epoch/source hash, or extra object claiming the same migration ID while a matching binding exists | Mark only that binding `recovery_failed`, keep settings frozen, and expose no projects, preferences, or credentials through that attachment. | Terminal maintenance repair; no browser writer or fallback is restored. |

The exact validation set in every non-cleanup row is: the immutable report and publish record have the same migration ID/candidate key/report SHA/candidate digest; the pending or active binding has the same scope, prior/target catalogs, attachment reference, ownership, epoch, retention, pointer digests, target preferences owner, mapping version, platform, and prior/target active-marker digests; the target catalog names a canonical attachment whose library/root/identity, owner vector, and epoch match that binding; the frozen `settings-storage` record recomputes to `source.sha256`; the immutable initial `preferences/candidates/<candidateKey>.json` has the report's exact format/version/SHA-256; before activation `preferences/head.json` is either the bound prior pointer or the exact target pointer, while an active target has the bound preferences owner and a valid current target of its own declared version/SHA-256; the active permanent project-library and settings attachments have that same owner vector/epoch/marker; and the deterministic selected OS collection validates precisely the bound candidate marker plus its matching immutable seed and current value-free index in the stated `prepared` or `active` state without returning secret material. No partial catalog or pointer publication falls outside these branches: an attachment catalog or pointer to a candidate with no matching pending/active binding is an invariant failure. It enters an unbound read-only maintenance state, does not synthesize or select a binding, and never permits ordinary attachment; operator repair must first prove the predecessor or preserve the evidence for manual repair.

`recovery_failed` is terminal for normal startup. Maintenance may retry the same candidate only after every failed predicate becomes true, or explicitly abandon exactly that candidate. Abandoning first restores the bound prior pointer through `DurableFileOps` and restores the bound prior fixed active marker only when their journals and bound prior digests validate. It then uses the candidate's index to obtain its `all_indexed_entries_absent` receipt and remove its prepared marker, writes and flushes its value-free quarantine manifest for the named non-secret preference candidate, staging files, publish control file, and report, and releases only that candidate control. In the same `meta` transaction that records the terminal failure, it replaces any active permanent settings attachment with `settings: null` and `storeOwnership.settings: 'frozen-recovery-failed'`, so no ordinary target can attach after rollback. A later user-approved repair prepares a new candidate from frozen evidence and writes a new permanent settings attachment only on its own active transition; it never reenables an IndexedDB settings writer. If either prior target cannot be proved, maintenance preserves the named evidence for operator repair rather than guessing, selecting, or deleting another candidate.

`lumina.runtime.maintenance.getSettingsMigrationReportV1(migrationId)` is a local maintenance-only endpoint, unavailable to MCP and ordinary settings clients. With the maintenance lease it returns `eligible` only when all of these predicates hold: the named immutable report validates; the matching binding is `active` with the same migration/key/candidate digest/catalog/epoch, pointer digests, active-marker digest, matching `recoveryRetainedUntil`, and frozen `settings` ownership; the immutable initial preference candidate has the report's exact format/version/SHA-256; the current preference pointer has the same bound owner and a valid current target; an OS-vault probe re-validates the same fixed active marker, immutable index seed, and current value-free index without returning values, entry IDs, or source-presence data; a fresh sanitized hash of the frozen `settings-storage` record equals `source.sha256`; the running runtime recognizes `recovery.compatibilityRelease`; and `now <= recovery.retainedUntil`. Its `unavailable` result identifies only the failed predicate class (`binding`, `report`, `pointer`, `preferences`, `vault`, `source_hash`, `compatibility`, or `retention`) and contains no settings, secret, vault-entry, index, or source-presence data. These predicates, report fields, pointer, vault validation, and binding are the frozen-settings ownership evidence required for a recovery test.

Acceptance tests must inject a crash after each preparation write, after the pending ownership commit, after attachment-catalog publication, after preference-pointer publication, after fixed-marker activation, and after the active-binding/permanent-record transaction. Each restart must take exactly one table branch, resume idempotently or clean only its one candidate, and prove no ordinary client can read a partial target or write frozen settings. They must also prove wildcard provider IDs produce stable distinct entry digests, duplicate/malformed IDs reject before target preparation, and a failed candidate deletes only its indexed private entries while retaining its non-secret quarantine. The vault fake must make collection/prefix enumeration throw: remove a provider configuration from current preferences after preparation, crash after any indexed deletion, restart, and prove `reset`, rollback, and abandon delete/recheck every indexed candidate entry by direct derived name, preserve the value-free in-vault cleanup receipt, and never call enumeration. A data-preserving v1 upgrade, payload relocation, Repair, and reinstall fixture must retain the exact installation ID and thereby use the same v1 collection/marker/index names; missing or changed identity metadata must fail with `vault_namespace_identity_invalid` without creating, scanning, or falling back to a collection, while a legacy-form target stays untouched. Read/update/delete/reset must touch only the currently selected prefix; an update must index a new allowed locator before its value write. They must fabricate an attachment catalog or candidate pointer without a binding and prove the unbound maintenance state attaches no target. A crash or timeout before the final #46 transaction leaves settings browser-live after exact cleanup; after it commits, settings cannot regain an IndexedDB writer. A settings recovery action may compare the frozen record, rebuild a new candidate, or perform a user-approved credential re-entry through the platform vault, but it never attaches the frozen record as the normal settings adapter or silently retransfers a credential. Normal clients then receive the same non-retryable `frozen_store_write` rejection for settings writes. At report expiry, maintenance first validates and retains the full `PermanentActiveOwnershipV1`, a live attachment catalog, preferences pointer with its matching owner and valid target, and the deterministic fixed active marker; it may then remove only the named report and binding. The permanent record, active attachment, vault prefix/marker/index, preferences, and frozen settings evidence remain, so normal attachment never depends on expired recovery evidence.
