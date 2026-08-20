export interface BrowserDocumentLike {
  createElement(tagName: string): HTMLAnchorElement;
  body: { appendChild(element: HTMLAnchorElement): void };
}

export function downloadBrowserImage(
  source: string,
  fileName: string,
  documentRef: BrowserDocumentLike = document,
): void {
  const normalizedSource = source.trim();
  if (!normalizedSource) {
    throw new Error('Image source is unavailable for download.');
  }
  const normalizedFileName = fileName.trim();
  if (!normalizedFileName) {
    throw new Error('A file name is required for image download.');
  }

  const anchor = documentRef.createElement('a');
  anchor.href = normalizedSource;
  anchor.download = normalizedFileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  documentRef.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}
