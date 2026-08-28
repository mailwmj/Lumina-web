# GenerationGateway

The local Runtime file library is the durable owner of projects, canvas
history, asset metadata, and long-lived asset bytes. Browser IndexedDB remains
the separate settings store. Browser clients may submit and render generation
work, but the Gateway never owns projects, canvas history, or long-lived
assets. It owns only bounded temporary operational state: whitelisted task
mappings and temporary media under the retention rules below.

Managed Web image providers use the same-origin `/api/generation/jobs` route.
The remaining supported image protocols use the constrained
`/api/generation/image-provider` transport, and remote image results are
materialized through `/api/generation/image-provider/result`. Text and
Seedance use `/api/generation/text` and `/api/generation/video` respectively.
Vite development proxies these paths to `gateway/server.mjs`; production
deployments reverse-proxy the same paths to the Gateway process on the Web Origin.
`LUMINA_GATEWAY_ORIGIN` is required and must be that canonical Origin. The
gateway intentionally emits no CORS headers; task-changing requests must carry
the matching Origin and browser clients use same-origin credentials.

The Gateway has two explicitly registered image providers: `ai-media` with its
sole enabled model `ai-media/gpt-image-2`, and `chaomo` for namespaced
`chaomo/*` image models. Their upstream base URLs are operator-side allowlist
values (`LUMINA_GATEWAY_AI_MEDIA_BASE_URL` and
`LUMINA_GATEWAY_CHAOMO_BASE_URL` respectively), never browser request fields.
Chaomo model discovery uses the same-origin
`GET /api/generation/providers/chaomo/models` route; its submit, poll, and
result routes remain under `/api/generation/jobs`. The browser sends its API key
in an ephemeral `Authorization` header for discovery, submit, and poll; the
gateway does not store or log it. Resumable async provider IDs must be a UUID,
ULID, or 16-64 character hexadecimal value, optionally prefixed with `job`,
`task`, `image`, `generation`, `request`, `provider`, or `upstream`; all other
values are rejected rather than persisted. Every outbound hop validates its scheme, exact configured origin and port,
DNS answers, public address class, redirect response and bounded decoded body.
The connection is pinned to the validated DNS answer, so a second DNS lookup
cannot turn a permitted hostname into a private address. Result URLs must share
the configured upstream origin; redirects, other origins, unsupported media
types and oversized decoded bodies are rejected.

Completed results and temporary input media are retained for at most 24 hours;
after a client has written a result as a Runtime project asset, it confirms
through the same-origin result route and its safety window is at most one hour.
Transcode output is streamed back and is not cached. Active task mappings have
a hard seven-day cap and terminal mappings a 24-hour cap. The client downloads
the result before the Runtime AssetRepository writes it as a generation asset.
The Node gateway keeps only a whitelisted, non-sensitive task mapping in
`LUMINA_GATEWAY_STATE_FILE`; async tasks with stable upstream IDs can therefore
be polled after a gateway restart. A Provider-supplied poll path is persisted
only when it is a bounded, credential-free base-relative path and accompanies a
validated stable upstream task ID. Successful managed image bytes are stored in
a bounded raw result file, not in the JSON state file. Before that task JSON is
committed, one atomic self-describing recovery spool holds only a `safeTask`
snapshot, byte length, SHA-256, content type, and the image bytes. It recovers
the result if either the raw result commit or the task JSON commit is
interrupted, without a second billable submission. Invalid, oversized,
hash-mismatched, expired, or unreferenced spool files are removed.
A strict same-site, HttpOnly session cookie
is bound to the submitting source IP. By default that address is the socket
peer; `LUMINA_GATEWAY_TRUST_PROXY=1` is only appropriate behind a proxy that
removes untrusted `X-Forwarded-For` headers.

After a stable upstream task ID exists, network failures and HTTP
`408/425/429/5xx` responses retain the original running task and use bounded
exponential backoff. Five consecutive transient failures set
`requires_manual_requery`; the explicit `requery` operation polls that same
upstream task once and never submits a replacement generation request.

Each source may retain at most 400 non-terminal generation tasks, including
tasks currently executing and tasks waiting in the in-memory FIFO queue. The
Gateway executes at most 50 tasks at once by default; a terminal result or
failure releases one slot and starts the next queued task. Configure these
limits with `LUMINA_GATEWAY_MAX_PENDING_TASKS_PER_SOURCE` and
`LUMINA_GATEWAY_MAX_CONCURRENT_TASKS`. Both accept positive integers up to 400.
The former `LUMINA_GATEWAY_MAX_CONCURRENT_TASKS_PER_SOURCE` and
`LUMINA_GATEWAY_MAX_ACTIVE_TASKS_PER_PROVIDER` names remain compatibility
fallbacks when the new variables are absent.

Queued request bodies and ephemeral Provider keys exist only in Gateway
memory. They are excluded from task state and logs. After a Gateway restart, a
queued task or a running task without a validated stable Provider task ID is
marked `submission_interrupted` and is never submitted again automatically;
a running task with a stable Provider task ID retains the existing poll-only
recovery behavior. A full queue returns the safe `429 queue_capacity_exceeded`
contract with `Retry-After`. The request-window limit remains independently
configurable through `LUMINA_GATEWAY_MAX_REQUESTS_PER_WINDOW` and defaults to
10,000 requests per minute so 50 actively polled tasks do not exhaust it.

Generation business JSON request bodies are capped at 1 MiB. On the managed
`/api/generation/jobs` path, reference images are not base64-encoded into that
JSON: the browser uploads each original image through `/api/generation/media`,
then submits only ordered opaque media keys. Each
decoded reference image is capped at 50 MiB, with a 250 MiB aggregate cap for
one image-generation request. This allows five 30 MiB references while keeping
one queued multipart request bounded. The Gateway also limits resident
temporary media to 256 MiB per session and 512 MiB process-wide by default.
Uploads with a valid `Content-Length` reserve both limits before reading the
body; chunked uploads reserve incrementally, including the aggregation copy.
Failed, rejected, and disconnected uploads release their reservation.
`LUMINA_GATEWAY_MAX_GENERATION_REQUEST_BYTES`,
`LUMINA_GATEWAY_MAX_TEMPORARY_MEDIA_BYTES_PER_SESSION`, and
`LUMINA_GATEWAY_MAX_TEMPORARY_MEDIA_BYTES` may lower their respective limits
but cannot raise the compiled safety caps. Capacity exhaustion returns `429
temporary_media_capacity_exceeded`; malformed, expired, cross-session, or
unsupported references return `400 invalid_generation_request`.

The constrained image protocol transport accepts only `openai-images`,
`fhl-images`, `gemini-native`, `fal`, `grsai`, `kie`, `runninghub`, `bltcy`, and
`ppio`. Each protocol has fixed base-relative method/path shapes for model
discovery, uploads, submit, poll, and result retrieval. The Gateway rebuilds
Provider authentication and never forwards browser-selected arbitrary headers,
methods, paths, redirects, or origins. Multipart and JSON reference images keep
the same 50 MiB per-image, ten-image, and 250 MiB aggregate limits; non-image
metadata is capped at 1 MiB.

This transport has an independent four-request concurrency cap, a 768 MiB
resident-byte budget, and a five-minute outbound deadline that includes DNS
resolution and transport. The concurrency and resident-byte limits are shared
by authenticated Provider requests, remote result materialization, and local
`fal-reference` uploads while TOS accepts them. Result-materialization JSON is
capped at 32 KiB and the downloaded image is capped at 50 MiB. Provider JSON
responses that can carry a 50 MiB base64 result are capped at approximately
68 MiB. Before a billable Provider request or poll, the Gateway reserves the
worst-case response/parse budget; when that reservation is unavailable, it does
not call the Provider. Configure lower
or operationally appropriate values with
`LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_CONCURRENT_REQUESTS`,
`LUMINA_GATEWAY_MAX_IMAGE_PROVIDER_PROXY_RESIDENT_BYTES`, and
`LUMINA_GATEWAY_IMAGE_PROVIDER_PROXY_TIMEOUT_MS`; compiled maxima remain in
force. Capacity failures return `429 image_provider_proxy_capacity_exceeded`
with `Retry-After`. Provider result URLs are accepted only when they were
observed in a recent JSON response for the same Gateway session and protocol.
The capability is claimed before the download, rejects concurrent reuse,
expires after ten minutes, and is consumed after one successful same-origin
media grant or a deterministic invalid result. A transient Provider or local
capacity failure releases the claim for a bounded retry within that same TTL,
so the result route is not a general public image proxy.

Operational logs are JSONL records with a retention timestamp plus only
request ID, operation, Provider, status, duration and byte count, retained for
seven days. Set
`LUMINA_GATEWAY_LOG_FILE` to choose the log location. Prompts, media, base64, credentials, authorization headers,
full URLs, fragments and raw upstream responses are excluded from both logs
and task state.

User-added OpenAI-compatible image providers require no product release. A
`custom-openai:*` settings entry is registered at runtime through the
same-origin `POST /api/generation/providers/custom` route, then uses
`GET /api/generation/providers/models?provider=...` for discovery and the
normal job routes for submit and polling. Registration is limited to the
existing OpenAI image protocol, a validated HTTP(S) base URL, the fixed
`/models`, `/images/generations`, and `/images/edits` paths, one browser
session, and 32 entries per session. The Gateway keeps only this ephemeral
endpoint mapping; it never persists the base URL or API key. A changed endpoint
is rejected while its current session has an active task, so polling cannot
switch providers mid-job.

This is not a general proxy: arbitrary methods, paths, headers, result origins,
and protocol declarations are not accepted. A new image protocol needs a
dedicated browser request/poll/result adapter, a matching Gateway path policy,
and process-level contract tests. Browser Provider calls must not fall back to
direct CORS access.

FAL edit requests require cloud-reachable reference URLs. Local canvas, blob,
and data URL references are uploaded under the fixed `fal-reference` media
scope to the configured private TOS bucket and represented by a short-lived
presigned GET URL. Each upload is an image capped at 50 MiB and shares the image
Provider concurrency and resident-byte limits above. The client keeps the
opaque release key only in its live task
closure, releases it on submit failure or any terminal task state, and never
persists the key or signed URL in a task handle. A browser refresh loses that
closure, so the Gateway TTL and cleanup path remain the final owner of deletion.
Production fails closed when TOS delivery is unavailable; it never sends a
loopback media URL to FAL.

Native installers do not embed shared TOS access keys or secret keys. The
installed Gateway reads `LUMINA_TOS_*` only from its startup environment. A
default installation without those deployment-managed values therefore cannot
publish provider-reachable FAL or Seedance references and returns the explicit
unavailable contract instead of selecting another storage service.

For a non-billing local check, run a fake OpenAI-compatible upstream, start the
gateway with `LUMINA_GATEWAY_AI_MEDIA_BASE_URL` pointing at it, then start Vite
with `LUMINA_GATEWAY_ORIGIN` pointing at the gateway. The route remains
same-origin from the browser's perspective while the fake upstream receives
the forwarded request. Private destinations remain blocked in production. For
a loopback fake only, set `NODE_ENV=development` and
`LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS` to that exact `127.0.0.1` or
`localhost` origin; production ignores this development-only exception.
