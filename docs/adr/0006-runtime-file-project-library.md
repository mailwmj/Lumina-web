---
status: accepted
---

# Runtime-first project and asset persistence

## Decision

The installed local Runtime is the sole durable owner of Lumina project complete snapshots, canvas history, asset metadata, and asset bytes. The Web application and Codex canvas companion are clients of a narrow logical API. The API never exposes filesystem roots, paths, directory listings, arbitrary file access, or path-bearing errors.

The Runtime service provides only the operations required by the current product: list/open/create/save complete snapshots, update viewport, rename/delete projects, and write/read/delete project-owned assets. Project publication is atomic: readers see either the previous complete head or the new complete head, never a partial snapshot. Startup recovers an interrupted publication only from known managed staging and recovery evidence. Asset reads verify admitted bytes; asset deletion is allowed only when the current snapshot and retained history no longer reference the asset.

## Editor ownership

The Runtime maintains one exclusive editor lease per project. A Chrome session may acquire and renew a project lease, while sessions editing different projects may proceed independently. Codex receives ownership for that same project only after explicit Chrome handoff and uses a short-lived, action-bound one-shot delegation for each durable mutation. A user-initiated force takeover atomically replaces the target project's current Chrome or Codex lease; the displaced lease and all of its project delegations immediately become invalid. Delegations are consumed once and are never replayed after an ambiguous transport failure. Disconnect, lease expiry, failed action, explicit release, handoff abort, and Runtime shutdown revoke the affected project authority. Generation authorization is a separate current confirmation and is not implied by the editor lease.

## Browser boundary

Legacy browser IndexedDB project/history/assets records are intentionally ignored. The application does not open, migrate, interpret, fallback-read, or dual-write them, and does not erase them. IndexedDB settings remain separate from this decision until their own migration is designed. Browser Object URLs are display leases only. Project archive import/export and caller-visible revision/OCC contracts are not supported.

## Security and operational constraints

Runtime sessions, editor leases, Codex delegations, provider credentials, signed URLs, and GenerationGateway temporary state are transient. They must not be stored in project snapshots, history, asset metadata, logs intended for project recovery, or browser durable project data. All IDs crossing the API are opaque logical identifiers. Request bodies and streamed asset bodies are bounded. Managed-root, traversal, symlink, junction/reparse, write-lock, integrity, and crash-recovery defenses remain Runtime-internal.

The detailed historical migration and maintenance contracts under this directory are superseded by this document and must not be used to reintroduce browser ownership, revisions, trash, reader pins, replay ledgers, general GC, or archive interchange.
