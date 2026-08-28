# Provider And Model Extension

Lumina's browser adapters build and parse provider-specific request contracts,
while the constrained same-origin GenerationGateway performs provider network
access. The local Runtime owns project snapshots, history, asset metadata, and
long-lived asset bytes; browser IndexedDB owns settings only. Credentials must
stay out of project data, exports, diagnostics, task handles, and logs.

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

Custom provider base URLs are never fetched directly by the browser. Supported
protocols use the same-origin image-provider route, whose Gateway policy allows
only fixed protocol, method, base-relative path, body, and result shapes. Do not
turn this into an arbitrary URL or header proxy; a new protocol requires both a
browser adapter and a matching Gateway policy with process-level tests.

## Text Providers And Polish

- `webTextApi.ts` owns model discovery and text request shapes.
- `TextApisSettings.tsx` calls browser discovery and stores the current selected
  configuration through the browser settings adapter. #45 does not change that
  path; the target runtime settings seam is not implemented until #46.
- `textGenerationService.ts` and `textPolishService.ts` keep text generation,
  image/video polish, and node-local polish behavior separate.
- Reject product limits before a request; never silently truncate ordered image
  references or replace a selected model.

## Video Providers

- `webVideoApi.ts` owns provider request mapping, task polling, and cancellation.
- `webGenerationGateway.ts` selects the matching same-origin Gateway operation
  without copying provider routing into components.
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
