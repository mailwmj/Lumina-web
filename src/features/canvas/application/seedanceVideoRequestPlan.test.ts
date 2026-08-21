import { describe, expect, it } from 'vitest';

import {
  buildSeedanceVideoRequestPlan,
  getSeedanceFirstLastModeAvailability,
  getSeedanceModelCapabilities,
  isSeedanceModel,
  type SeedanceConnectedMedia,
} from './seedanceVideoRequestPlan';

function media(
  type: SeedanceConnectedMedia['type'],
  url: string,
  targetHandle = 'target'
): SeedanceConnectedMedia {
  return {
    sourceNodeId: `${type}-${url}`,
    targetHandle,
    type,
    url,
  };
}

function automaticPlan(mediaInputs: SeedanceConnectedMedia[] = [], overrides = {}) {
  return buildSeedanceVideoRequestPlan({
    kind: 'automatic',
    model: 'doubao-seedance-2-0-260128',
    prompt: 'A calm cinematic scene',
    resolution: '720p',
    duration: 5,
    media: mediaInputs,
    ...overrides,
  });
}

describe('Seedance video request plan', () => {
  it('requires exactly one image on each semantic strict-frame handle and maps them by handle', () => {
    const missingLast = buildSeedanceVideoRequestPlan({
      kind: 'strict-frame',
      model: 'doubao-seedance-2-0-260128',
      prompt: 'A lantern drifts across a lake',
      resolution: '720p',
      duration: 5,
      media: [media('image', 'https://media.example/first.png', 'target-first')],
    });
    const reversedEdges = buildSeedanceVideoRequestPlan({
      kind: 'strict-frame',
      model: 'doubao-seedance-2-0-260128',
      prompt: 'A lantern drifts across a lake',
      resolution: '720p',
      duration: 5,
      media: [
        media('image', 'https://media.example/last.png', 'target-last'),
        media('image', 'https://media.example/first.png', 'target-first'),
      ],
    });
    const duplicateFirst = buildSeedanceVideoRequestPlan({
      kind: 'strict-frame',
      model: 'doubao-seedance-2-0-260128',
      prompt: 'A lantern drifts across a lake',
      resolution: '720p',
      duration: 5,
      media: [
        media('image', 'https://media.example/first.png', 'target-first'),
        media('image', 'https://media.example/other-first.png', 'target-first'),
        media('image', 'https://media.example/last.png', 'target-last'),
      ],
    });

    expect(missingLast).toMatchObject({ ok: false, error: { code: 'last_frame_required' } });
    expect(reversedEdges).toMatchObject({
      ok: true,
      plan: {
        content: expect.arrayContaining([
          { type: 'image_url', role: 'first_frame', url: 'https://media.example/first.png' },
          { type: 'image_url', role: 'last_frame', url: 'https://media.example/last.png' },
        ]),
      },
    });
    expect(duplicateFirst).toMatchObject({ ok: false, error: { code: 'strict_frame_input_limit' } });
  });

  it('requires semantic handles for both strict frames', () => {
    const oneFrame = buildSeedanceVideoRequestPlan({
      kind: 'strict-frame',
      model: 'doubao-seedance-2-0-260128',
      prompt: 'The character waves',
      resolution: '720p',
      duration: 5,
      media: [media('image', 'https://media.example/first.png', 'target-first')],
    });
    const twoFrames = buildSeedanceVideoRequestPlan({
      kind: 'strict-frame',
      model: 'doubao-seedance-2-0-260128',
      prompt: 'The character walks forward',
      resolution: '4k',
      duration: 15,
      media: [
        media('image', 'https://media.example/first.png', 'target-first'),
        media('image', 'https://media.example/last.png', 'target-last'),
      ],
    });

    expect(oneFrame).toMatchObject({ ok: false, error: { code: 'last_frame_required' } });
    expect(twoFrames).toMatchObject({
      ok: true,
      plan: {
        content: [
          { type: 'image_url', role: 'first_frame', url: 'https://media.example/first.png' },
          { type: 'image_url', role: 'last_frame', url: 'https://media.example/last.png' },
          { type: 'text', text: 'The character walks forward' },
        ],
      },
    });
  });

  it('reports whether current reference media can switch to first-last mode', () => {
    expect(getSeedanceFirstLastModeAvailability([
      media('image', 'https://media.example/first.png'),
    ])).toMatchObject({ isAvailable: false, imageCount: 1, videoCount: 0, audioCount: 0 });
    expect(getSeedanceFirstLastModeAvailability([
      media('image', 'https://media.example/first.png'),
      media('image', 'https://media.example/last.png'),
    ])).toMatchObject({ isAvailable: true, imageCount: 2 });
    expect(getSeedanceFirstLastModeAvailability([
      media('image', 'https://media.example/one.png'),
      media('image', 'https://media.example/two.png'),
      media('image', 'https://media.example/three.png'),
    ])).toMatchObject({ isAvailable: false, imageCount: 3 });
    expect(getSeedanceFirstLastModeAvailability([
      media('image', 'https://media.example/first.png'),
      media('video', 'https://media.example/reference.mp4'),
      media('audio', 'https://media.example/reference.mp3'),
    ])).toMatchObject({ isAvailable: false, videoCount: 1, audioCount: 1 });
  });

  it('creates text-only and typed automatic reference plans without a mode selection', () => {
    const textOnly = automaticPlan();
    const mixed = automaticPlan([
      media('image', 'https://media.example/reference-1.png'),
      media('video', 'https://media.example/source.mp4'),
      media('audio', 'https://media.example/music.mp3'),
      media('image', 'https://media.example/reference-2.png'),
    ], { prompt: '@图2 follows @视频1 with @音频1' });

    expect(textOnly).toMatchObject({
      ok: true,
      plan: {
        content: [{ type: 'text', text: 'A calm cinematic scene' }],
      },
    });
    expect(mixed).toMatchObject({
      ok: true,
      plan: {
        content: [
          { type: 'image_url', role: 'reference_image', url: 'https://media.example/reference-1.png' },
          { type: 'video_url', role: 'reference_video', url: 'https://media.example/source.mp4' },
          { type: 'audio_url', role: 'reference_audio', url: 'https://media.example/music.mp3' },
          { type: 'image_url', role: 'reference_image', url: 'https://media.example/reference-2.png' },
          { type: 'text', text: '图2 follows 视频1 with 音频1' },
        ],
        references: [
          { type: 'image', referenceIndex: 1 },
          { type: 'video', referenceIndex: 1 },
          { type: 'audio', referenceIndex: 1 },
          { type: 'image', referenceIndex: 2 },
        ],
      },
    });
  });

  it('keeps connected text and typed media in one source order before the local prompt', () => {
    const result = buildSeedanceVideoRequestPlan({
      kind: 'automatic',
      model: 'doubao-seedance-2-0-260128',
      prompt: 'local direction',
      resolution: '720p',
      duration: 5,
      media: [],
      inputs: [
        { sourceNodeId: 'text-1', type: 'text', text: 'first instruction' },
        media('image', 'https://media.example/one.png'),
        { sourceNodeId: 'text-2', type: 'text', text: 'second instruction' },
        media('video', 'https://media.example/source.mp4'),
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        content: [
          { type: 'text', text: 'first instruction' },
          { type: 'image_url', role: 'reference_image', url: 'https://media.example/one.png' },
          { type: 'text', text: 'second instruction' },
          { type: 'video_url', role: 'reference_video', url: 'https://media.example/source.mp4' },
          { type: 'text', text: 'local direction' },
        ],
      },
    });
  });

  it('enforces automatic reference caps and rejects audio without a visual reference', () => {
    const tenImages = automaticPlan(
      Array.from({ length: 10 }, (_, index) =>
        media('image', `https://media.example/image-${index}.png`)
      )
    );
    const fourVideos = automaticPlan(
      Array.from({ length: 4 }, (_, index) =>
        media('video', `https://media.example/video-${index}.mp4`)
      )
    );
    const fourAudios = automaticPlan([
      media('image', 'https://media.example/image.png'),
      ...Array.from({ length: 4 }, (_, index) =>
        media('audio', `https://media.example/audio-${index}.mp3`)
      ),
    ]);
    const audioOnly = automaticPlan([media('audio', 'https://media.example/audio.mp3')]);

    expect(tenImages).toMatchObject({ ok: false, error: { code: 'image_limit' } });
    expect(fourVideos).toMatchObject({ ok: false, error: { code: 'video_limit' } });
    expect(fourAudios).toMatchObject({ ok: false, error: { code: 'audio_limit' } });
    expect(audioOnly).toMatchObject({ ok: false, error: { code: 'audio_requires_visual_reference' } });
  });

  it('applies the supported Seedance 2.0 resolution and duration matrix', () => {
    expect(automaticPlan([], { resolution: '4k', duration: 4 })).toMatchObject({ ok: true });
    expect(automaticPlan([], {
      model: 'doubao-seedance-2-0-fast-260128',
      resolution: '1080p',
    })).toMatchObject({ ok: false, error: { code: 'unsupported_resolution' } });
    expect(automaticPlan([], {
      model: 'doubao-seedance-2-0-mini-260128',
      resolution: '720p',
      duration: 15,
    })).toMatchObject({ ok: true });
    expect(automaticPlan([], { duration: 3 })).toMatchObject({
      ok: false,
      error: { code: 'unsupported_duration' },
    });
  });

  it('routes Seedance 1.5 Pro alongside the 2.0 family', () => {
    const auto = automaticPlan([], {
      model: 'doubao-seedance-1-5-pro-251215',
      resolution: '1080p',
      duration: 8,
    });
    const strict = buildSeedanceVideoRequestPlan({
      kind: 'strict-frame',
      model: 'doubao-seedance-1-5-pro-251215',
      prompt: 'Legacy first frame generation',
      resolution: '720p',
      duration: 5,
      media: [media('image', 'https://media.example/first.png', 'target-first')],
    });

    expect(auto).toMatchObject({ ok: true });
    expect(strict).toMatchObject({ ok: false, error: { code: 'last_frame_required' } });
    expect(isSeedanceModel('volcvideo/doubao-seedance-1-5-pro-251215')).toBe(true);
    expect(getSeedanceModelCapabilities('doubao-seedance-1-5-pro-251215')).toMatchObject({
      family: '1.5',
      resolutions: ['480p', '720p', '1080p'],
      minDuration: 2,
      maxDuration: 12,
    });
  });
});
