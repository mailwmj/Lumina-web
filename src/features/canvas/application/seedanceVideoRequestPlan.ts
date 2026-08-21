export const SEEDANCE_AUTOMATIC_INPUT_LIMITS = {
  image: 9,
  video: 3,
  audio: 3,
} as const;

export type SeedanceMediaType = keyof typeof SEEDANCE_AUTOMATIC_INPUT_LIMITS;
export type SeedanceVideoPlanKind = 'strict-frame' | 'automatic';

export interface SeedanceFirstLastModeAvailability {
  imageCount: number;
  videoCount: number;
  audioCount: number;
  isAvailable: boolean;
}

export type SeedanceVideoContent =
  | {
    type: 'text';
    text: string;
  }
  | {
    type: 'image_url';
    role: 'first_frame' | 'last_frame' | 'reference_image';
    url: string;
  }
  | {
    type: 'video_url';
    role: 'reference_video';
    url: string;
  }
  | {
    type: 'audio_url';
    role: 'reference_audio';
    url: string;
  };

export interface SeedanceConnectedMedia {
  sourceNodeId: string;
  sourceNodeType?: string;
  targetHandle?: string | null;
  type: SeedanceMediaType;
  assetId?: string | null;
  url: string | null;
}

/** A connected text source keeps its position alongside typed media inputs. */
export interface SeedanceConnectedText {
  sourceNodeId: string;
  sourceNodeType?: string;
  targetHandle?: string | null;
  type: 'text';
  text: string;
}

export type SeedanceConnectedInput = SeedanceConnectedMedia | SeedanceConnectedText;

export interface SeedanceVideoReference {
  sourceNodeId: string;
  sourceNodeType?: string;
  targetHandle?: string | null;
  type: SeedanceMediaType;
  url: string;
  referenceIndex: number;
}

export interface SeedanceVideoModelCapabilities {
  family: '1.5' | '2.0';
  variant: 'standard' | 'fast' | 'mini';
  resolutions: readonly ('480p' | '720p' | '1080p' | '4k')[];
  minDuration: number;
  maxDuration: number;
}

export interface SeedanceVideoRequestPlan {
  kind: SeedanceVideoPlanKind;
  model: string;
  resolution: string;
  duration: number;
  content: SeedanceVideoContent[];
  references: SeedanceVideoReference[];
}

export type SeedanceVideoValidationCode =
  | 'prompt_required'
  | 'model_required'
  | 'seedance_2_model_required'
  | 'unsupported_resolution'
  | 'unsupported_duration'
  | 'first_frame_required'
  | 'last_frame_required'
  | 'strict_frame_input_limit'
  | 'strict_frame_requires_images'
  | 'strict_frame_invalid_handle'
  | 'media_url_required'
  | 'image_limit'
  | 'video_limit'
  | 'audio_limit'
  | 'audio_requires_visual_reference';

export type SeedanceVideoPlanResult =
  | { ok: true; plan: SeedanceVideoRequestPlan }
  | { ok: false; error: { code: SeedanceVideoValidationCode } };

export interface BuildSeedanceVideoRequestPlanInput {
  kind: SeedanceVideoPlanKind;
  model: string;
  prompt: string;
  resolution: string;
  duration: number;
  media: readonly SeedanceConnectedMedia[];
  /** Optional text-plus-media snapshot. `media` remains for older callers. */
  inputs?: readonly SeedanceConnectedInput[];
  /** Local node text, appended after connected inputs when provided. */
  localPrompt?: string;
}

export function getSeedanceFirstLastModeAvailability(
  media: readonly SeedanceConnectedMedia[]
): SeedanceFirstLastModeAvailability {
  const imageCount = media.filter((item) => item.type === 'image').length;
  const videoCount = media.filter((item) => item.type === 'video').length;
  const audioCount = media.filter((item) => item.type === 'audio').length;

  return {
    imageCount,
    videoCount,
    audioCount,
    isAvailable: imageCount === 2 && videoCount === 0 && audioCount === 0,
  };
}

const STANDARD_CAPABILITIES: SeedanceVideoModelCapabilities = {
  family: '2.0',
  variant: 'standard',
  resolutions: ['480p', '720p', '1080p', '4k'],
  minDuration: 4,
  maxDuration: 15,
};

const FAST_CAPABILITIES: SeedanceVideoModelCapabilities = {
  family: '2.0',
  variant: 'fast',
  resolutions: ['480p', '720p'],
  minDuration: 4,
  maxDuration: 15,
};

const MINI_CAPABILITIES: SeedanceVideoModelCapabilities = {
  family: '2.0',
  variant: 'mini',
  resolutions: ['480p', '720p'],
  minDuration: 4,
  maxDuration: 15,
};

const SEEDANCE_15_PRO_CAPABILITIES: SeedanceVideoModelCapabilities = {
  family: '1.5',
  variant: 'standard',
  resolutions: ['480p', '720p', '1080p'],
  minDuration: 2,
  maxDuration: 12,
};

function normalizedModelId(model: string): string {
  const segments = model.trim().toLowerCase().split('/');
  return segments[segments.length - 1] ?? '';
}

export function getSeedance20ModelCapabilities(
  model: string
): SeedanceVideoModelCapabilities | null {
  const modelId = normalizedModelId(model);
  if (!modelId.includes('seedance-2-0')) {
    return null;
  }
  if (modelId.includes('fast')) {
    return FAST_CAPABILITIES;
  }
  if (modelId.includes('mini')) {
    return MINI_CAPABILITIES;
  }
  return STANDARD_CAPABILITIES;
}

export function getSeedanceModelCapabilities(
  model: string
): SeedanceVideoModelCapabilities | null {
  const modelId = normalizedModelId(model);
  if (modelId.includes('seedance-1-5-pro') || modelId.includes('seedance-1.5-pro')) {
    return SEEDANCE_15_PRO_CAPABILITIES;
  }
  return getSeedance20ModelCapabilities(model);
}

export function isSeedance20Model(model: string): boolean {
  return getSeedance20ModelCapabilities(model) !== null;
}

export function isSeedanceModel(model: string): boolean {
  return getSeedanceModelCapabilities(model) !== null;
}

export function isSeedance15ProModel(model: string): boolean {
  return getSeedanceModelCapabilities(model)?.family === '1.5';
}

function withoutReferencePrefixes(prompt: string): string {
  return prompt.replace(/@(?=(?:图|视频|音频)\d+)/g, '');
}

function validationError(code: SeedanceVideoValidationCode): SeedanceVideoPlanResult {
  return { ok: false, error: { code } };
}

function validateResolutionAndDuration(
  input: BuildSeedanceVideoRequestPlanInput,
  capabilities: SeedanceVideoModelCapabilities
): SeedanceVideoPlanResult | null {
  if (!capabilities.resolutions.includes(input.resolution as '480p' | '720p' | '1080p' | '4k')) {
    return validationError('unsupported_resolution');
  }
  if (!Number.isInteger(input.duration)
    || input.duration < capabilities.minDuration
    || input.duration > capabilities.maxDuration) {
    return validationError('unsupported_duration');
  }
  return null;
}

function materializeReferences(
  media: readonly SeedanceConnectedMedia[]
): SeedanceVideoReference[] | SeedanceVideoPlanResult {
  const nextIndexes: Record<SeedanceMediaType, number> = {
    image: 0,
    video: 0,
    audio: 0,
  };
  const references: SeedanceVideoReference[] = [];

  for (const item of media) {
    const url = item.url?.trim();
    if (!url) {
      return validationError('media_url_required');
    }
    nextIndexes[item.type] += 1;
    references.push({
      sourceNodeId: item.sourceNodeId,
      sourceNodeType: item.sourceNodeType,
      targetHandle: item.targetHandle,
      type: item.type,
      url,
      referenceIndex: nextIndexes[item.type],
    });
  }

  return references;
}

function buildStrictFrameContent(
  references: readonly SeedanceVideoReference[],
  textEntries: readonly string[],
  localPrompt: string
): SeedanceVideoPlanResult {
  if (references.length > 2) {
    return validationError('strict_frame_input_limit');
  }
  if (references.some((reference) => reference.type !== 'image')) {
    return validationError('strict_frame_requires_images');
  }

  const firstFrames = references.filter((reference) => reference.targetHandle === 'target-first');
  const lastFrames = references.filter((reference) => reference.targetHandle === 'target-last');
  if (firstFrames.length > 1 || lastFrames.length > 1) {
    return validationError('strict_frame_input_limit');
  }
  if (references.some((reference) => (
    reference.targetHandle !== 'target-first' && reference.targetHandle !== 'target-last'
  ))) {
    return validationError('strict_frame_invalid_handle');
  }

  const firstFrame = firstFrames[0];
  if (!firstFrame) {
    return validationError('first_frame_required');
  }
  const lastFrame = lastFrames[0];
  if (!lastFrame) {
    return validationError('last_frame_required');
  }

  const content: SeedanceVideoContent[] = [
    { type: 'image_url', role: 'first_frame', url: firstFrame.url },
    { type: 'image_url', role: 'last_frame', url: lastFrame.url },
  ];
  for (const text of textEntries) {
    content.push({ type: 'text', text });
  }
  if (localPrompt) {
    content.push({ type: 'text', text: localPrompt });
  }

  return {
    ok: true,
    plan: {
      kind: 'strict-frame',
      model: '',
      resolution: '',
      duration: 0,
      content,
      references: [...references],
    },
  };
}

function buildAutomaticContent(
  references: readonly SeedanceVideoReference[],
  orderedInputs: readonly SeedanceConnectedInput[],
  textEntries: readonly string[],
  localPrompt: string
): SeedanceVideoPlanResult {
  const counts: Record<SeedanceMediaType, number> = {
    image: 0,
    video: 0,
    audio: 0,
  };
  for (const reference of references) {
    counts[reference.type] += 1;
  }
  if (counts.image > SEEDANCE_AUTOMATIC_INPUT_LIMITS.image) {
    return validationError('image_limit');
  }
  if (counts.video > SEEDANCE_AUTOMATIC_INPUT_LIMITS.video) {
    return validationError('video_limit');
  }
  if (counts.audio > SEEDANCE_AUTOMATIC_INPUT_LIMITS.audio) {
    return validationError('audio_limit');
  }
  if (counts.audio > 0 && counts.image === 0 && counts.video === 0) {
    return validationError('audio_requires_visual_reference');
  }

  const referenceBySource = new Map(
    references.map((reference) => [reference.sourceNodeId, reference]),
  );
  const content: SeedanceVideoContent[] = [];
  for (const input of orderedInputs) {
    if (input.type === 'text') {
      const text = withoutReferencePrefixes(input.text).trim();
      if (text) content.push({ type: 'text', text });
      continue;
    }
    const reference = referenceBySource.get(input.sourceNodeId);
    if (!reference) continue;
    if (reference.type === 'image') {
      content.push({ type: 'image_url', role: 'reference_image', url: reference.url });
    } else if (reference.type === 'video') {
      content.push({ type: 'video_url', role: 'reference_video', url: reference.url });
    } else {
      content.push({ type: 'audio_url', role: 'reference_audio', url: reference.url });
    }
  }
  // Keep compatibility for callers that only provide the media list.
  if (orderedInputs.length === 0) {
    for (const reference of references) {
      if (reference.type === 'image') {
        content.push({ type: 'image_url', role: 'reference_image', url: reference.url });
      } else if (reference.type === 'video') {
        content.push({ type: 'video_url', role: 'reference_video', url: reference.url });
      } else {
        content.push({ type: 'audio_url', role: 'reference_audio', url: reference.url });
      }
    }
  }
  if (orderedInputs.length === 0) {
    for (const text of textEntries) content.push({ type: 'text', text });
  }
  if (localPrompt) content.push({ type: 'text', text: localPrompt });

  return {
    ok: true,
    plan: {
      kind: 'automatic',
      model: '',
      resolution: '',
      duration: 0,
      content,
      references: [...references],
    },
  };
}

export function buildSeedanceVideoRequestPlan(
  input: BuildSeedanceVideoRequestPlanInput
): SeedanceVideoPlanResult {
  const model = input.model.trim();
  const orderedInputs = input.inputs ?? input.media;
  const connectedTextEntries = orderedInputs
    .filter((item): item is SeedanceConnectedText => item.type === 'text')
    .map((item) => withoutReferencePrefixes(item.text).trim())
    .filter(Boolean);
  const localPrompt = withoutReferencePrefixes(
    input.localPrompt ?? input.prompt,
  ).trim();
  const prompt = [...connectedTextEntries, localPrompt].filter(Boolean).join('\n\n');
  if (!prompt) {
    return validationError('prompt_required');
  }
  if (!model) {
    return validationError('model_required');
  }

  const capabilities = getSeedanceModelCapabilities(model);
  if (!capabilities) {
    return validationError('seedance_2_model_required');
  }

  const settingsError = validateResolutionAndDuration(
    input,
    capabilities
  );
  if (settingsError) {
    return settingsError;
  }

  const referencesResult = materializeReferences(
    orderedInputs.filter((item): item is SeedanceConnectedMedia => item.type !== 'text'),
  );
  if (!Array.isArray(referencesResult)) {
    return referencesResult;
  }

  const contentResult = input.kind === 'strict-frame'
    ? buildStrictFrameContent(referencesResult, connectedTextEntries, localPrompt)
    : buildAutomaticContent(
      referencesResult,
      orderedInputs,
      connectedTextEntries,
      localPrompt,
    );
  if (!contentResult.ok) {
    return contentResult;
  }

  return {
    ok: true,
    plan: {
      ...contentResult.plan,
      model,
      resolution: input.resolution,
      duration: input.duration,
    },
  };
}
