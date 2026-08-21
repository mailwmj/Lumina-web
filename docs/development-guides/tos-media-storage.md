# GenerationGateway Temporary Media

Lumina keeps project assets in browser IndexedDB. When a provider requires a
public image, video, or audio input, the Web app sends a bounded copy to the
same-origin GenerationGateway. The gateway creates a temporary, session-bound
media URL for the allowed provider and removes it on release or expiry. That URL
is never stored in project data, history, settings, or logs.

## Gateway Configuration

Set these values on the gateway process, not in browser source or deployment
artifacts:

```text
LUMINA_GATEWAY_ORIGIN=https://app.example.com
LUMINA_GATEWAY_PORT=8787
LUMINA_GATEWAY_MEDIA_PROVIDER_IDS=volcengine-seedance
LUMINA_GATEWAY_MAX_MEDIA_BYTES=67108864
LUMINA_GATEWAY_MEDIA_TTL_MS=86400000
LUMINA_GATEWAY_MEDIA_TRANSCODER_URL=https://transcoder.example.com
```

`LUMINA_GATEWAY_MEDIA_TRANSCODER_URL` is optional. When configured, the
gateway validates its origin and accepts only the expected output media type.
Without it, conversion requests fail with a recoverable unavailable result.

The gateway uses its canonical Origin to create temporary URLs. Production
traffic must reverse-proxy `/api/generation` from that exact Origin to the
gateway. The gateway intentionally does not emit cross-origin headers.

## Lifecycle And Limits

- Only image, audio, and video MIME types accepted by `gateway/server.mjs` are
  eligible.
- Each request is bounded by `LUMINA_GATEWAY_MAX_MEDIA_BYTES`; provider IDs are
  allowlisted.
- A temporary URL carries a random grant, is bound to the submitting session,
  and expires no later than `LUMINA_GATEWAY_MEDIA_TTL_MS`.
- The browser releases temporary media after a task succeeds, fails, or is
  cancelled. Expiry cleanup remains the fallback.
- Gateway logs record operational metadata only. They exclude content, full
  URLs, authorization values, provider keys, and prompt text.

## Local Development

Run the gateway in one shell with its browser Origin configured, then run Vite
in another shell with its proxy target configured as shown in the root README.
For a loopback fake upstream, use `NODE_ENV=development` and explicitly set
`LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS`; production ignores that exception.

## Verification

```bash
npx vitest run gateway
npm run build
```

Use the gateway integration tests for publish, retrieve, release, expiry,
transcoding, and rejection cases. Do not test provider credentials or real
media in source-controlled fixtures.
