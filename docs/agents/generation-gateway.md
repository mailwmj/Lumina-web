# GenerationGateway

The Web image path uses the same-origin `/api/generation/jobs` route. Vite
development proxies that path to `gateway/server.mjs`; production deployments
should reverse-proxy the same path to the gateway process on the Web origin.
The gateway intentionally emits no CORS headers.

The first supported provider is the configured `ai-media` OpenAI-compatible
provider and the only enabled model is `ai-media/gpt-image-2`. The upstream base
URL is an operator-side allowlist value (`LUMINA_GATEWAY_AI_MEDIA_BASE_URL`),
never a browser request field. The browser sends its API key in an ephemeral
`Authorization` header for submit and poll; the gateway does not store or log
it. Result URLs are fetched only when they share the configured upstream
origin; redirects and other origins are rejected. Completed results are held
in memory for at most 24 hours, or for a one-hour safety window after the
browser fetches them, while active task mappings may remain for up to seven
days and terminal mappings for 24 hours. The browser downloads the result
before writing it to IndexedDB as a generation asset. The Node gateway keeps
only non-sensitive task metadata in its short-lived state file, applies a
per-source request window and active-task limit, and never writes the API key
or prompt to that file. Set `LUMINA_GATEWAY_STATE_FILE` to choose the
short-lived metadata file location; async tasks with stable upstream IDs can
therefore be polled after a gateway restart. A strict same-site session cookie
binds polling and result retrieval to the submitting browser.

For a non-billing local check, run a fake OpenAI-compatible upstream, start the
gateway with `LUMINA_GATEWAY_AI_MEDIA_BASE_URL` pointing at it, then start Vite
with `LUMINA_GATEWAY_ORIGIN` pointing at the gateway. The route remains
same-origin from the browser's perspective while the fake upstream receives
the forwarded request.
