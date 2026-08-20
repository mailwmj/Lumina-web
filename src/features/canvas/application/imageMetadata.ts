function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolvePathname(source: string): string {
  if (/^[a-zA-Z]:\\/.test(source) || source.includes('\\')) {
    return source.replace(/\\/g, '/').split(/[?#]/u, 1)[0] ?? '';
  }

  try {
    return new URL(source).pathname;
  } catch {
    return source.split(/[?#]/u, 1)[0] ?? '';
  }
}

export function resolveImageFileName(source: string | null | undefined, fallback: string): string {
  const normalizedFallback = decodePathSegment(fallback.trim());
  const normalizedSource = typeof source === 'string' ? source.trim() : '';

  if (!normalizedSource || /^(?:blob|data):/iu.test(normalizedSource)) {
    return normalizedFallback;
  }

  const pathname = resolvePathname(normalizedSource);
  if (!pathname || pathname.endsWith('/')) {
    return normalizedFallback;
  }

  const basename = pathname.slice(pathname.lastIndexOf('/') + 1).trim();
  return basename ? decodePathSegment(basename) : normalizedFallback;
}

export function resolveImageFileStem(fileName: string): string {
  const normalizedFileName = fileName.trim();
  const extensionIndex = normalizedFileName.lastIndexOf('.');

  if (extensionIndex <= 0) {
    return normalizedFileName;
  }

  return normalizedFileName.slice(0, extensionIndex);
}

export function resolveImageFileExtension(fileName: string): string | null {
  const normalizedFileName = fileName.trim();
  const extensionIndex = normalizedFileName.lastIndexOf('.');

  if (extensionIndex <= 0 || extensionIndex === normalizedFileName.length - 1) {
    return null;
  }

  return normalizedFileName.slice(extensionIndex + 1).toLowerCase();
}
