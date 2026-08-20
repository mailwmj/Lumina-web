export const TEXT_GENERATION_DEFAULT_WIDTH = 520;
// The compact node has 232px of rendered geometry: 13px of effective
// border/edge inset, a 179px labeled prompt section, an 8px gap, and a 32px
// footer. Keeping the minimum equal to that composition prevents an anonymous
// blank band below the controls.
export const TEXT_GENERATION_DEFAULT_HEIGHT = 232;
export const TEXT_GENERATION_MIN_WIDTH = 390;
export const TEXT_GENERATION_MIN_HEIGHT = 232;
export const TEXT_GENERATION_MAX_WIDTH = 1400;
export const TEXT_GENERATION_MAX_HEIGHT = 1000;
export const TEXT_GENERATION_FOOTER_HEIGHT = 32;
export const TEXT_GENERATION_UPSTREAM_TEXT_HEIGHT = 96;
export const TEXT_GENERATION_REFERENCE_IMAGES_HEIGHT = 88;
export const TEXT_GENERATION_PROMPT_HEIGHT = 160;
export const TEXT_GENERATION_PROMPT_WITH_RESULT_HEIGHT = 120;
export const TEXT_GENERATION_RESULT_HEIGHT = 136;

const NODE_VERTICAL_INSET = 13;
const NODE_SECTION_GAP = 8;
const NODE_SECTION_LABEL_HEIGHT = 19;

interface TextGenerationLayoutInput {
  width?: number;
  height?: number;
  hasContext?: boolean;
  hasTextContext?: boolean;
  hasImageContext?: boolean;
  hasResult: boolean;
  isSizeManuallyAdjusted?: boolean;
}

export interface TextGenerationLayout {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  upstreamTextHeight: number;
  referenceImagesHeight: number;
  promptHeight: number;
  resultHeight: number;
}

function clampDimension(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.min(max, Math.max(min, fallback));
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function resolveTextGenerationLayout({
  width,
  height,
  hasContext = false,
  hasTextContext = false,
  hasImageContext = false,
  hasResult,
  isSizeManuallyAdjusted = false,
}: TextGenerationLayoutInput): TextGenerationLayout {
  const showTextContext = hasTextContext || (hasContext && !hasImageContext);
  const showImageContext = hasImageContext;
  const upstreamTextHeight = showTextContext ? TEXT_GENERATION_UPSTREAM_TEXT_HEIGHT : 0;
  const referenceImagesHeight = showImageContext ? TEXT_GENERATION_REFERENCE_IMAGES_HEIGHT : 0;
  const basePromptHeight = hasResult
    ? TEXT_GENERATION_PROMPT_WITH_RESULT_HEIGHT
    : TEXT_GENERATION_PROMPT_HEIGHT;
  const baseResultHeight = hasResult ? TEXT_GENERATION_RESULT_HEIGHT : 0;
  const sectionHeights = [
    showTextContext ? NODE_SECTION_LABEL_HEIGHT + upstreamTextHeight : 0,
    showImageContext ? NODE_SECTION_LABEL_HEIGHT + referenceImagesHeight : 0,
    NODE_SECTION_LABEL_HEIGHT + basePromptHeight,
    hasResult ? NODE_SECTION_LABEL_HEIGHT + baseResultHeight : 0,
    TEXT_GENERATION_FOOTER_HEIGHT,
  ].filter((sectionHeight) => sectionHeight > 0);
  const automaticHeight = NODE_VERTICAL_INSET
    + sectionHeights.reduce((total, sectionHeight) => total + sectionHeight, 0)
    + Math.max(0, sectionHeights.length - 1) * NODE_SECTION_GAP;
  const minHeight = Math.max(TEXT_GENERATION_MIN_HEIGHT, automaticHeight);
  const resolvedWidth = clampDimension(
    isSizeManuallyAdjusted ? width : undefined,
    TEXT_GENERATION_DEFAULT_WIDTH,
    TEXT_GENERATION_MIN_WIDTH,
    TEXT_GENERATION_MAX_WIDTH
  );
  const resolvedHeight = clampDimension(
    isSizeManuallyAdjusted ? height : undefined,
    automaticHeight,
    minHeight,
    TEXT_GENERATION_MAX_HEIGHT
  );
  const additionalHeight = Math.max(0, resolvedHeight - automaticHeight);
  // Give all manually added vertical space to the editable content region so
  // a larger node never leaves an inert band above its controls.
  const promptHeight = hasResult
    ? basePromptHeight
    : basePromptHeight + additionalHeight;
  const resultHeight = hasResult
    ? baseResultHeight + additionalHeight
    : 0;

  return {
    width: resolvedWidth,
    height: resolvedHeight,
    minWidth: TEXT_GENERATION_MIN_WIDTH,
    minHeight,
    upstreamTextHeight,
    referenceImagesHeight,
    promptHeight,
    resultHeight,
  };
}
