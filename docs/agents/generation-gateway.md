# GenerationGateway

The current browser IndexedDB library is the durable store. ADR-0006 specifies
a future runtime file project library for #43-#45; browser clients may submit
and render generation work, but the Gateway never owns projects, canvas,
history, or long-lived assets. It owns only bounded temporary operational
state: whitelisted task mappings and temporary media under the retention rules
below.

The Web image path uses the same-origin `/api/generation/jobs` route. Vite
development proxies that path to `gateway/server.mjs`; production deployments
should reverse-proxy the same path to the gateway process on the Web origin.
`LUMINA_GATEWAY_ORIGIN` is required and must be that canonical Origin. The
gateway intentionally emits no CORS headers; task-changing requests must carry
the matching Origin and browser clients use same-origin credentials.

The first supported provider is the configured `ai-media` OpenAI-compatible
provider and the only enabled model is `ai-media/gpt-image-2`. The upstream base
URL is an operator-side allowlist value (`LUMINA_GATEWAY_AI_MEDIA_BASE_URL`),
never a browser request field. The browser sends its API key in an ephemeral
`Authorization` header for submit and poll; the gateway does not store or log
it. Resumable async `ai-media` IDs must be a UUID, ULID, or 16-64 character
hexadecimal value, optionally prefixed with `job`, `task`, `image`,
`generation`, `request`, `provider`, or `upstream`; all other values are
rejected rather than persisted. Every outbound hop validates its scheme, exact configured origin and port,
DNS answers, public address class, redirect response and bounded decoded body.
The connection is pinned to the validated DNS answer, so a second DNS lookup
cannot turn a permitted hostname into a private address. Result URLs must share
the configured upstream origin; redirects, other origins, unsupported media
types and oversized decoded bodies are rejected.

Completed results and temporary input media are retained for at most 24 hours;
after a client has written a result as a current browser project asset, it
confirms through the same-origin result route and its safety window is at most
one hour. The target file adapter will preserve that confirmation contract.
Transcode output is streamed back and is not cached. Active task mappings have
a hard seven-day cap and terminal mappings a 24-hour cap. The client downloads
the result before the current browser AssetRepository writes it as a generation
asset. The target runtime adapter will replace that write path only after
#43-#45 land. The Node
gateway keeps only a whitelisted, non-sensitive task mapping in
`LUMINA_GATEWAY_STATE_FILE`; async tasks with stable upstream IDs can therefore
be polled after a gateway restart. A strict same-site, HttpOnly session cookie
is bound to the submitting source IP. By default that address is the socket
peer; `LUMINA_GATEWAY_TRUST_PROXY=1` is only appropriate behind a proxy that
removes untrusted `X-Forwarded-For` headers.

Per-source rate, per-source active-task and Provider active-task limits return
the same safe `429` error contract with `Retry-After`. Operational logs are
JSONL records with a retention timestamp plus only request ID, operation,
Provider, status, duration and byte count, retained for seven days. Set
`LUMINA_GATEWAY_LOG_FILE` to choose the log location. Prompts, media, base64, credentials, authorization headers,
full URLs, fragments and raw upstream responses are excluded from both logs
and task state.

For a non-billing local check, run a fake OpenAI-compatible upstream, start the
gateway with `LUMINA_GATEWAY_AI_MEDIA_BASE_URL` pointing at it, then start Vite
with `LUMINA_GATEWAY_ORIGIN` pointing at the gateway. The route remains
same-origin from the browser's perspective while the fake upstream receives
the forwarded request. Private destinations remain blocked in production. For
a loopback fake only, set `NODE_ENV=development` and
`LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS` to that exact `127.0.0.1` or
`localhost` origin; production ignores this development-only exception.
