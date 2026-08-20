import { describe, expect, it, vi } from 'vitest';

import { downloadBrowserImage } from './browserImageDownload';

describe('browser image download', () => {
  it('starts a browser download from an asset Object URL', () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as CSSStyleDeclaration,
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement;
    const documentRef = {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    };

    downloadBrowserImage('blob:asset-1', 'photo.png', documentRef);

    expect(anchor.href).toBe('blob:asset-1');
    expect(anchor.download).toBe('photo.png');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
  });

  it('fails with a clear error when the source is missing', () => {
    expect(() => downloadBrowserImage('', 'photo.png', {
      createElement: vi.fn(),
      body: { appendChild: vi.fn() },
    })).toThrow('Image source is unavailable for download.');
  });
});
