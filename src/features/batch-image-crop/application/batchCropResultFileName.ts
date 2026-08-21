function normalizedStem(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  const stem = (lastDot > 0 ? fileName.slice(0, lastDot) : fileName).trim();
  const safe = [...stem]
    .map((character) => (character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character))
    .join('')
    .replace(/^[_ .]+|[_ .]+$/g, '');
  return safe || 'image';
}

export function createBatchCropResultFileName(
  sourceFileName: string,
  target: { width: number; height: number },
): string {
  return `${normalizedStem(sourceFileName)}_${target.width}x${target.height}.jpg`;
}
