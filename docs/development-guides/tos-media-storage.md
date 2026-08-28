# GenerationGateway Temporary Media

Lumina's installed Runtime is the only durable owner of project snapshots,
canvas history, asset metadata, and asset bytes. Browser IndexedDB owns settings
only. GenerationGateway and TOS are a temporary delivery layer for providers
that must fetch image, video, or audio inputs over HTTP; they are not a project
library, migration source, fallback store, or second writer.

Temporary object keys, presigned URLs, provider result URLs, credentials, and
Gateway grants must never enter project snapshots, history, asset metadata,
settings, recovery logs, or persisted generation task handles.

## End-To-End Media Flow

1. The Web app resolves a Runtime asset to a short-lived browser display lease.
2. Local/object-URL bytes are posted to the same-origin media endpoint. For an
   HTTP(S) source, the Web app sends only the source URL through `publish-url`;
   the Gateway validates and fetches it, then republishes the bounded bytes.
3. The Gateway uploads the bytes to a private TOS bucket and returns a short
   presigned GET URL scoped to the provider request.
4. The provider receives that URL. The persisted task handle contains only the
   stable provider task identity and other credential-free recovery metadata.
5. When generation succeeds, the Gateway fetches the explicit provider result
   field and exposes it as a bounded same-origin temporary media lease.
6. The Web app reads that lease and creates a durable Runtime asset. Canvas
   state stores the Runtime asset identity, never the provider or TOS URL.
7. The active browser session releases provider inputs after terminal use.
   Same-origin result leases expire after Runtime import. Gateway expiry and the
   TOS bucket lifecycle policy clean up abandoned media after refreshes,
   crashes, or network loss.

Remote media is therefore copied through the Gateway instead of giving a
provider an arbitrary URL supplied by the browser. Local filesystem roots and
Runtime-managed paths are never exposed to the Gateway, provider, or canvas.

## Gateway Configuration

Set these values only in the GenerationGateway process environment. Do not put
them in Vite variables, browser source, Runtime project data, packaged plugin
metadata, logs, or deployment artifacts served to the browser.

```text
LUMINA_GATEWAY_ORIGIN=https://app.example.com
LUMINA_GATEWAY_PORT=8787
LUMINA_GATEWAY_MEDIA_PROVIDER_IDS=volcengine-seedance
LUMINA_GATEWAY_MAX_MEDIA_BYTES=67108864
LUMINA_GATEWAY_MAX_TEMPORARY_MEDIA_BYTES_PER_SESSION=268435456
LUMINA_GATEWAY_MAX_TEMPORARY_MEDIA_BYTES=536870912
LUMINA_GATEWAY_MEDIA_TTL_MS=86400000

LUMINA_TOS_BUCKET=private-bucket-name
LUMINA_TOS_REGION=cn-beijing
LUMINA_TOS_ENDPOINT=https://tos-cn-beijing.volces.com
LUMINA_TOS_ACCESS_KEY=<gateway-only-access-key>
LUMINA_TOS_SECRET_KEY=<gateway-only-secret-key>
LUMINA_TOS_SECURITY_TOKEN=<optional-sts-token>
LUMINA_TOS_URL_TTL_SECONDS=3600
```

`LUMINA_TOS_SECURITY_TOKEN` is required when the access key and secret key are
temporary STS credentials. `LUMINA_TOS_URL_TTL_SECONDS` defaults to 3600 and is
clamped to 60 through 86400 seconds. The Gateway signs PUT and DELETE requests
itself and never returns TOS credentials to the browser.

The internal shared GitHub installer is an explicit exception to the normal
deployment rule above. Its `package-installer` job maps the repository secrets
`LUMINA_TOS_ACCESS_KEY` and `LUMINA_TOS_SECRET_KEY` to compile-time packaging
inputs. The Runtime bundle then starts its local Gateway with the fixed
`luminanative` bucket, `cn-beijing` region, and
`https://tos-cn-beijing.volces.com` endpoint. The credentials are present only
in the installed Runtime bundle and Gateway process; they are not included in
the Web bundle, plugin metadata, project data, or logs.

This shared package is intended for the current small internal user group. A
new user installing that package does not need to configure TOS separately and
can use provider-reachable reference uploads immediately. Rotating the shared
credentials requires updating the GitHub repository secrets and publishing a
new installer. Local builds and packages without explicit
`LUMINA_EMBEDDED_TOS_ACCESS_KEY` and `LUMINA_EMBEDDED_TOS_SECRET_KEY` inputs
remain unconfigured and fail closed in production.

The resident-media limits apply to non-TOS temporary bytes such as image and
text references. They default to 256 MiB per browser session and 512 MiB for
the Gateway process. Values may lower but cannot raise those compiled caps.
Local FAL reference uploads are separately capped at 50 MiB per image and hold
one slot plus their bytes in the image Provider pipeline budget until the TOS
PUT finishes. TOS upload reuses the admitted Buffer instead of creating another
whole-body copy.

`LUMINA_GATEWAY_MEDIA_TRANSCODER_URL` is optional. When configured, the Gateway
validates its origin and accepts only the expected output media type. Without
it, conversion requests fail with a retryable unavailable response.

Production traffic must reverse-proxy `/api/generation` from the canonical
`LUMINA_GATEWAY_ORIGIN` to the Gateway. The Gateway intentionally does not emit
cross-origin headers.

## Bucket And Lifecycle Requirements

- Keep the bucket private. Provider access is granted only by short-lived,
  object-specific presigned GET URLs.
- Deny public listing and public object ACLs. Restrict Gateway credentials to
  the configured bucket and the `lumina/*/staging/*` object prefix.
- Prefer short-lived STS credentials and rotate long-lived credentials if STS
  is unavailable.
- Configure a bucket lifecycle rule that expires staging objects after a short,
  bounded period. This is the fallback for sessions that cannot call release.
- Keep active `DeleteObject` cleanup on successful, failed, and cancelled tasks.
  A missing object is an idempotent successful release.
- Upload with `Cache-Control: private, max-age=0, no-cache`. Do not treat URL
  expiry as object deletion.

Gateway logs contain operational metadata only. They exclude media bytes, full
source and signed URLs, authorization values, TOS keys and tokens, provider
keys, and prompt text. Transport errors crossing the TOS boundary are reduced
to a generic message so request objects cannot leak secrets.

## Local Development And Tests

Production requires TOS temporary delivery. The in-memory same-origin media
delivery path is allowed only for automated tests or when
`LUMINA_GATEWAY_ALLOW_LOCAL_MEDIA_DELIVERY=1` is explicitly set for a local
loopback development session. It is not a production fallback.

For a loopback fake upstream, use `NODE_ENV=development` and explicitly set
`LUMINA_GATEWAY_TRUSTED_PRIVATE_ORIGINS`; production ignores that exception.

## Verification

```bash
npx vitest run gateway/tos-temporary-media.test.mjs
npx vitest run gateway/server.integration.test.mjs
npm run build
```

The tests cover private upload headers, RFC 3986 signing, TTL bounds, STS token
signing, remote-source publication, same-origin retrieval, active deletion,
idempotent missing-object cleanup, expiry, and secret-redacted failures. Real
credentials and real media must not appear in source-controlled fixtures.
