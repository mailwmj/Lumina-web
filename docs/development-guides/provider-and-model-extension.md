# Provider And Model Extension

Lumina runs provider integrations from the browser and the constrained
GenerationGateway. Project data and long-lived assets remain in the
runtime-managed project library; provider credentials stay in the platform
credential vault and must not enter exports, diagnostics, task handles, or logs.

## Image Models

1. Add one model definition under
   `src/features/canvas/models/image/<provider>/`.
2. Declare `displayName`, `providerId`, supported resolution and aspect ratios,
   defaults, and `resolveRequest` mapping.
3. Register provider metadata under
   `src/features/canvas/models/providers/` and expose the model through the
   model registry.
4. Extend `webImageApi.ts` only for a documented request/response protocol.
   Preserve ordered references, model limits, and credential-free task handles.
5. Add a focused request or polling test using an injected `fetch` function.

Custom provider base URLs are browser-direct. The official same-origin gateway
only accepts its configured provider and operation allowlist; do not route an
arbitrary user URL through it.

## Text Providers And Polish

- `webTextApi.ts` owns model discovery and text request shapes.
- `TextApisSettings.tsx` calls browser discovery and stores only the user's
  selected non-secret configuration through the runtime settings seam.
- `textGenerationService.ts` and `textPolishService.ts` keep text generation,
  image/video polish, and node-local polish behavior separate.
- Reject product limits before a request; never silently truncate ordered image
  references or replace a selected model.

## Video Providers

- `webVideoApi.ts` owns provider request mapping, task polling, and cancellation.
- `webGenerationGateway.ts` selects direct browser provider paths or the
  same-origin gateway without copying provider routing into components.
- For public-input providers, create temporary media through the browser media
  gateway and release it after the task completes.
- Persist a stable, opaque task handle only when refresh recovery can poll the
  original provider task. Otherwise mark the task interrupted after reload.

## Verification

Run the smallest focused provider tests first, then:

```bash
npx tsc --noEmit
npx vitest run
npx vitest run gateway
npm run build
```

Verify success, provider failure, malformed response, cancellation, recovery,
offline rejection, and the configured model's input limits. Do not use live
keys or billable providers in automated tests.
