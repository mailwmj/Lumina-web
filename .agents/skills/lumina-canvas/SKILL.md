---
name: lumina-canvas
description: Use when a user asks Codex to inspect, prepare, run, monitor, or QA image-generation work in the Lumina canvas through Lumina MCP tools.
---

# Lumina Canvas

## Core Principle

Treat Lumina MCP tool schemas and live canvas state as the source of truth. Organize calls by business phase; never impose a fixed total call limit. Reduce round trips that do not add information.

## Workflow

1. Verify that Lumina tools are available. If they are absent after registration, tell the user that the current Codex task must refresh its tool registry. Do not pretend the connection is ready.
2. Read `canvas_get_state` once. On `NO_ACTIVE_CANVAS`, ask the user to keep a project open and enable external Agent access. Do not repeat the same state read without an intervening change.
3. Maintain a structured brief while clarifying references, scene, shot list, shared constraints, model, size, ratio, and output count. Bundle related questions and preserve confirmed choices.
4. Import all approved references in one `canvas_import_images` batch. Preserve the user's reference order.
5. Prepare each logical atomic canvas phase with one `canvas_propose_changes` call. Put complete node data in `create_node` operations and connect same-batch nodes by their `clientId`; do not split work by node, edge, or field merely to make smaller calls.
6. If a proposal or action returns a terminal result, use it directly. Only when `canvas_propose_changes` returns `pending`, poll `canvas_get_change_status`; only when an import, run, or image-read action returns `pending`, poll `canvas_get_action_status`. Re-read full state only when a changed revision or unresolved node identity is actually needed.
7. Summarize the visible setup, including shots and output settings, then obtain explicit user authorization before calling `canvas_run_nodes`. Run all approved independent nodes together.
8. Monitor returned result node IDs with `canvas_wait_for_nodes`. Repeat long-poll waits until all targets are terminal; call count may grow with task duration and result waves. Avoid fixed-interval full-state polling.
9. Read ready results with `canvas_get_node_images`, perform metadata and visual QA against the confirmed brief, and rerun only affected shots after renewed authorization.

## Call Discipline

- Use one proposal per atomic business change, not one proposal per object.
- Let calls scale with clarification, preparation, execution, progress waves, QA, and localized rework.
- Read capabilities once only when the needed node field or connection contract is uncertain.
- Follow numeric limits and enums exposed by the current tool schema; do not maintain a separate allowlist or silently clamp inputs.
- Treat stale revisions as a reason to refresh and rebase the intended phase, not to replay blind mutations.

## Safety Boundaries

- Never run generation from inferred approval. Setup approval and run authorization are distinct.
- Never overwrite reference nodes or create result nodes directly.
- Never expose local media paths returned from internal state.
- Stop and report actionable readiness, validation, provider, or terminal node errors instead of generic retries.
