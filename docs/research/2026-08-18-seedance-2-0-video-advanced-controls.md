# Seedance 2.0 video advanced controls: API contract and current node behavior

Research date: 2026-08-18. Scope: the advanced controls shown by Lumina's `Seedance 视频生成` node. All API claims below come from primary Volcengine documentation.

## Official request endpoint

Create a task with `POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`; query it with `GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{task_id}`. The create endpoint accepts top-level `resolution`, `duration`, `generate_audio`, `watermark`, `seed`, `camera_fixed`, and `tools` fields in addition to `model` and `content`.[^create]

## Control mapping

| Lumina control | Official Seedance 2.0 capability | Lumina behavior before simplification | Meaning / constraint |
| --- | --- | --- | --- |
| Output audio | `generate_audio: boolean` (default `true`) | `hasAudio` becomes `extraParams.hasaudio`, then Rust serializes it as `generate_audio`. | Direct API control. `true` asks the model to generate synchronized voice, sound effects, and background music; `false` requests silent output. This is separate from an audio reference input (`content` item with role `reference_audio`).[^create][^tutorial] |
| Watermark | `watermark: boolean` (default `false`) | `watermark` is sent as the same top-level field. | Direct API control. `true` adds the provider's AI-generated watermark at bottom right; `false` omits it. It is not the same as a prompt instruction such as "do not generate a third-party logo/watermark".[^create][^prompt] |
| Resolution | `resolution: string` | Node's resolution selector is sent as `resolution`. | Direct API control. Seedance 2.0 supports `480p`, `720p`, `1080p`, and `4k`; Fast and Mini support `480p` and `720p`. |
| Duration | `duration: integer` | Node's duration selector is sent as `duration`. | Direct API control. The current 2.0 series documentation lists 4--15 seconds for all three variants.[^tutorial] |
| Web search | `tools: [{"type": "web_search"}]` | `enableWebSearch` becomes that exact `tools` array. | Direct API capability, but only for **pure text input**. The model decides whether to search based on the prompt; it may improve freshness but adds latency. The actual count is returned in `usage.tool_usage.web_search`; `0` means it did not search.[^tutorial] |
| "Camera fixed" checkbox | `camera_fixed: boolean` exists in the generic endpoint | The checkbox is disabled for Seedance 2.0. Existing values would still serialize as `camera_fixed`, normally `false`. | Correctly unavailable for Seedance 2.0: the official field supports Seedance 1.5 Pro / 1.0 Pro / 1.0 Pro Fast only, and is unsupported with reference images. Even where supported, the service appends a fixed-camera instruction to the prompt and does not guarantee the effect.[^create] |
| Lens, framing, angle, and speed presets | No `shot_type`, `shot_size`, `angle`, `camera_movement`, or `camera_speed` request fields | Selecting a preset stores node metadata and prepends its Chinese wording to the prompt. It is not serialized as an independent Seedance parameter. | Prompt semantics, not a hard API constraint. Official guidance explicitly recommends standard prompt terms such as `中景`、`特写`、`全景`、`缓慢推镜`、`平稳横移`、`固定镜头`, and advises one movement per shot.[^prompt] |

## Research implications

1. The top "镜头 > 相机固定" preset and the lower "相机固定" checkbox have different meanings. The first is prompt text and is valid for Seedance 2.0; the second is a provider field and is intentionally unavailable for Seedance 2.0.
2. The current UI shows the web-search switch for all Seedance 2.0 uses, including the automatic node's image/video/audio references. That conflicts with the official **pure-text-only** constraint. It should be hidden or disabled once any reference input is connected, and any persisted `enableWebSearch` value should be cleared or rejected before submit.
3. Lens presets only prepend text when chosen. Changing or unselecting a preset does not remove previously prepended wording, so a prompt can retain contradictory lens instructions. This is local UI behavior, not an API behavior.

## Implementation status

Lumina's visible video nodes now support only Seedance 2.0 series APIs. The
control rail contains model, resolution, duration, prompt polish, and generate.
Lens/framing/angle/speed, audio, watermark, fixed-camera, web-search, seed,
and draft controls are intentionally absent. Submit requests explicitly use
`generate_audio: true` and `watermark: false`; connected content still selects
automatic reference roles, while the dedicated first/last-frame ports retain
their strict roles.

## Sources

[^create]: Volcengine Ark, [Create video-generation task](https://docs.volcengine.com/docs/82379/1520757), accessed 2026-08-18; page updated 2026-08-17 19:12:44.
[^tutorial]: Volcengine Ark, [Doubao Seedance 2.0 series tutorial](https://docs.volcengine.com/docs/82379/2291680), accessed 2026-08-18; page updated 2026-08-17 13:54:22.
[^prompt]: Volcengine Ark, [Doubao Seedance 2.0 series prompt guide](https://docs.volcengine.com/docs/82379/2222480), accessed 2026-08-18; page updated 2026-08-17 18:55:44.
