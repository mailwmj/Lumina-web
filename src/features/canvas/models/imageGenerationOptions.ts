import type { AspectRatioOption, ResolutionOption } from './types';

export const IMAGE_GENERATION_RESOLUTION_VALUES = ['1K', '2K', '4K'] as const;

export const IMAGE_GENERATION_RESOLUTION_OPTIONS: ResolutionOption[] =
  IMAGE_GENERATION_RESOLUTION_VALUES.map((value) => ({ value, label: value }));

export const IMAGE_GENERATION_ASPECT_RATIO_VALUES = [
  '1:1',
  '5:4',
  '9:16',
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '4:5',
  '3:4',
  '2:3',
] as const;

export const IMAGE_GENERATION_ASPECT_RATIO_OPTIONS: AspectRatioOption[] =
  IMAGE_GENERATION_ASPECT_RATIO_VALUES.map((value) => ({ value, label: value }));

export function resolveImageGenerationResolution(
  requestedResolution: string | undefined
): ResolutionOption {
  return (
    IMAGE_GENERATION_RESOLUTION_OPTIONS.find(
      (option) => option.value === requestedResolution
    ) ?? IMAGE_GENERATION_RESOLUTION_OPTIONS[1]
  );
}

export function pickClosestImageGenerationAspectRatio(targetRatio: number): string {
  const safeTargetRatio = Number.isFinite(targetRatio) && targetRatio > 0 ? targetRatio : 1;
  let closestValue: string = IMAGE_GENERATION_ASPECT_RATIO_VALUES[0];
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const aspectRatio of IMAGE_GENERATION_ASPECT_RATIO_VALUES) {
    const [width, height] = aspectRatio.split(':').map(Number);
    const ratio = width / height;
    const distance = Math.abs(Math.log(ratio / safeTargetRatio));
    if (distance < closestDistance) {
      closestDistance = distance;
      closestValue = aspectRatio;
    }
  }

  return closestValue;
}
