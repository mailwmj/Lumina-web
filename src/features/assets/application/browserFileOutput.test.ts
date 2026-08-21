import { describe, expect, it, vi } from 'vitest';

import { outputBrowserFiles } from './browserFileOutput';
import {
  outputBrowserAssetFiles,
  outputBrowserMediaFiles,
  outputBrowserUrlFiles,
} from './browserMediaOutput';

interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;

  while (view.getUint32(offset, true) === 0x04034b50) {
    const byteCount = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.push({
      path: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      bytes: bytes.slice(dataStart, dataStart + byteCount),
    });
    offset = dataStart + byteCount;
  }

  return entries;
}

describe('browser file output', () => {
  it('downloads a stable ZIP and reports every source file name and hash', async () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as CSSStyleDeclaration,
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement;
    let archive: Blob | null = null;
    const objectUrlApi = {
      createObjectURL: vi.fn((blob: Blob) => {
        archive = blob;
        return 'blob:archive';
      }),
      revokeObjectURL: vi.fn(),
    };

    const result = await outputBrowserFiles({
      intent: 'download',
      archiveFileName: 'selected-media.zip',
      files: [
        { id: 'second', fileName: '02-video.mp4', blob: new Blob(['video'], { type: 'video/mp4' }) },
        { id: 'first', fileName: '01-image.png', blob: new Blob(['image'], { type: 'image/png' }) },
      ],
    }, {
      documentRef: {
        createElement: vi.fn(() => anchor),
        body: { appendChild: vi.fn() },
      },
      objectUrlApi,
    });

    expect(result).toMatchObject({
      disposition: 'zip-download',
      files: [
        {
          id: 'second',
          fileName: '02-video.mp4',
          sha256: '0cab1c9617404faf2b24e221e189ca5945813e14d3f766345b09ca13bbe28ffc',
        },
        {
          id: 'first',
          fileName: '01-image.png',
          sha256: '6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d',
        },
      ],
      failures: [],
    });
    expect(anchor.download).toBe('selected-media.zip');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(archive).not.toBeNull();

    const entries = readZipEntries(new Uint8Array(await archive!.arrayBuffer()));
    expect(entries.map((entry) => entry.path)).toEqual(['02-video.mp4', '01-image.png']);
    expect(new TextDecoder().decode(entries[0]?.bytes)).toBe('video');
    expect(new TextDecoder().decode(entries[1]?.bytes)).toBe('image');
  });

  it('makes duplicate ZIP entry names deterministic before downloading', async () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as CSSStyleDeclaration,
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement;
    let archive: Blob | null = null;

    const result = await outputBrowserFiles({
      intent: 'download',
      archiveFileName: 'duplicates.zip',
      files: [
        { id: 'first', fileName: 'photo.png', blob: new Blob(['first']) },
        { id: 'second', fileName: 'photo.png', blob: new Blob(['second']) },
      ],
    }, {
      documentRef: {
        createElement: vi.fn(() => anchor),
        body: { appendChild: vi.fn() },
      },
      objectUrlApi: {
        createObjectURL: vi.fn((blob: Blob) => {
          archive = blob;
          return 'blob:duplicates';
        }),
        revokeObjectURL: vi.fn(),
      },
    });

    expect(result.files.map((file) => file.fileName)).toEqual(['photo.png', 'photo (2).png']);
    expect(readZipEntries(new Uint8Array(await archive!.arrayBuffer())).map((entry) => entry.path))
      .toEqual(['photo.png', 'photo (2).png']);
  });

  it('restores directory permission, avoids file name collisions, and continues after one write fails', async () => {
    const existingNames = new Set(['photo.png']);
    const writes: string[] = [];
    const directory = {
      queryPermission: vi.fn(async () => 'prompt' as const),
      requestPermission: vi.fn(async () => 'granted' as const),
      getFileHandle: vi.fn(async (fileName: string, options?: { create?: boolean }) => {
        if (!options?.create) {
          if (existingNames.has(fileName)) {
            return {
              createWritable: async () => {
                throw new Error('existing files must not be opened for writing');
              },
            };
          }
          const error = new Error('not found');
          error.name = 'NotFoundError';
          throw error;
        }
        existingNames.add(fileName);
        return {
          createWritable: async () => ({
            write: async () => {
              writes.push(fileName);
              if (fileName === 'broken.png') {
                throw new Error('disk full');
              }
            },
            close: async () => undefined,
          }),
        };
      }),
    };

    const result = await outputBrowserFiles({
      intent: 'directory',
      archiveFileName: 'unused.zip',
      directory,
      files: [
        { id: 'first', fileName: 'photo.png', blob: new Blob(['one']) },
        { id: 'broken', fileName: 'broken.png', blob: new Blob(['two']) },
        { id: 'last', fileName: 'photo.png', blob: new Blob(['three']) },
      ],
    });

    expect(directory.requestPermission).toHaveBeenCalledOnce();
    expect(writes).toEqual(['photo (2).png', 'broken.png', 'photo (3).png']);
    expect(result).toMatchObject({
      disposition: 'directory',
      permission: 'granted',
      files: [
        { id: 'first', fileName: 'photo (2).png' },
        { id: 'last', fileName: 'photo (3).png' },
      ],
      failures: [
        { id: 'broken', fileName: 'broken.png', reason: 'write_failed' },
      ],
    });
  });

  it('falls back to a ZIP download when directory access is unavailable', async () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as CSSStyleDeclaration,
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement;

    const result = await outputBrowserFiles({
      intent: 'directory',
      archiveFileName: 'fallback.zip',
      files: [
        { id: 'one', fileName: 'one.png', blob: new Blob(['one']) },
        { id: 'two', fileName: 'two.png', blob: new Blob(['two']) },
      ],
    }, {
      documentRef: {
        createElement: vi.fn(() => anchor),
        body: { appendChild: vi.fn() },
      },
      objectUrlApi: {
        createObjectURL: vi.fn(() => 'blob:fallback'),
        revokeObjectURL: vi.fn(),
      },
      fileSystemAccess: null,
    });

    expect(result).toMatchObject({
      disposition: 'zip-download',
      permission: 'unsupported',
      failures: [],
    });
    expect(anchor.download).toBe('fallback.zip');
  });

  it('reports an invalidated directory permission as a denied result', async () => {
    const directory = {
      queryPermission: vi.fn(async () => {
        throw new Error('permission handle is no longer valid');
      }),
      requestPermission: vi.fn(),
      getFileHandle: vi.fn(),
    };

    await expect(outputBrowserFiles({
      intent: 'directory',
      archiveFileName: 'unused.zip',
      directory,
      files: [{ id: 'photo', fileName: 'photo.png', blob: new Blob(['photo']) }],
    })).resolves.toMatchObject({
      disposition: 'directory',
      permission: 'denied',
      files: [],
      failures: [{ id: 'photo', fileName: 'photo.png', reason: 'permission_denied' }],
    });
    expect(directory.requestPermission).not.toHaveBeenCalled();
  });

  it('keeps the selected asset order and reports an unavailable asset without blocking the ZIP', async () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as CSSStyleDeclaration,
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement;
    let archive: Blob | null = null;
    const repository = {
      read: vi.fn(async (assetId: string) => ({
        'asset-one': new Blob(['one']),
        'asset-three': new Blob(['three']),
      })[assetId] ?? null),
    };

    const result = await outputBrowserAssetFiles({
      intent: 'download',
      archiveFileName: 'canvas-media.zip',
      repository,
      files: [
        { id: 'one', assetId: 'asset-one', fileName: '01-one.png' },
        { id: 'missing', assetId: 'asset-missing', fileName: '02-missing.png' },
        { id: 'three', assetId: 'asset-three', fileName: '03-three.mp4' },
      ],
    }, {
      documentRef: {
        createElement: vi.fn(() => anchor),
        body: { appendChild: vi.fn() },
      },
      objectUrlApi: {
        createObjectURL: vi.fn((blob: Blob) => {
          archive = blob;
          return 'blob:assets';
        }),
        revokeObjectURL: vi.fn(),
      },
    });

    expect(result).toMatchObject({
      disposition: 'zip-download',
      files: [{ id: 'one' }, { id: 'three' }],
      failures: [{ id: 'missing', fileName: '02-missing.png', reason: 'asset_unavailable' }],
    });
    expect(readZipEntries(new Uint8Array(await archive!.arrayBuffer())).map((entry) => entry.path))
      .toEqual(['01-one.png', '03-three.mp4']);
  });

  it('keeps mixed asset and source media in selection order when a source-only media file fails', async () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as CSSStyleDeclaration,
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement;
    let archive: Blob | null = null;

    const result = await outputBrowserMediaFiles({
      intent: 'download',
      archiveFileName: 'mixed-media.zip',
      files: [
        { id: 'asset', assetId: 'asset-photo', fileName: '01-photo.png' },
        { id: 'missing', source: 'blob:missing', fileName: '02-missing.mp4' },
        { id: 'source', source: 'blob:source', fileName: '03-source.mp4' },
      ],
    }, {
      repository: {
        read: vi.fn(async () => new Blob(['photo'], { type: 'image/png' })),
      },
      fetchFile: vi.fn(async (url: string) => {
        if (url === 'blob:missing') {
          throw new Error('source missing');
        }
        return {
          ok: true,
          blob: async () => new Blob(['video'], { type: 'video/mp4' }),
        };
      }),
      environment: {
        documentRef: {
          createElement: vi.fn(() => anchor),
          body: { appendChild: vi.fn() },
        },
        objectUrlApi: {
          createObjectURL: vi.fn((blob: Blob) => {
            archive = blob;
            return 'blob:mixed-media';
          }),
          revokeObjectURL: vi.fn(),
        },
      },
    });

    expect(result).toMatchObject({
      disposition: 'zip-download',
      files: [{ id: 'asset' }, { id: 'source' }],
      failures: [{ id: 'missing', fileName: '02-missing.mp4', reason: 'source_read_failed' }],
    });
    expect(readZipEntries(new Uint8Array(await archive!.arrayBuffer())).map((entry) => entry.path))
      .toEqual(['01-photo.png', '03-source.mp4']);
  });

  it('keeps readable URL sources in order when another source cannot be loaded', async () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as CSSStyleDeclaration,
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement;
    let archive: Blob | null = null;

    const result = await outputBrowserUrlFiles({
      intent: 'download',
      archiveFileName: 'storyboard.zip',
      files: [
        { id: 'first', fileName: '01.png', url: 'blob:first' },
        { id: 'missing', fileName: '02.png', url: 'blob:missing' },
        { id: 'last', fileName: '03.png', url: 'blob:last' },
      ],
      fetchFile: vi.fn(async (url: string) => {
        if (url === 'blob:missing') {
          throw new Error('source missing');
        }
        return {
          ok: true,
          blob: async () => new Blob([url]),
        };
      }),
    }, {
      documentRef: {
        createElement: vi.fn(() => anchor),
        body: { appendChild: vi.fn() },
      },
      objectUrlApi: {
        createObjectURL: vi.fn((blob: Blob) => {
          archive = blob;
          return 'blob:storyboard';
        }),
        revokeObjectURL: vi.fn(),
      },
    });

    expect(result).toMatchObject({
      disposition: 'zip-download',
      files: [{ id: 'first' }, { id: 'last' }],
      failures: [{ id: 'missing', fileName: '02.png', reason: 'source_read_failed' }],
    });
    expect(readZipEntries(new Uint8Array(await archive!.arrayBuffer())).map((entry) => entry.path))
      .toEqual(['01.png', '03.png']);
  });

  it('keeps a single storyboard frame in its requested ZIP archive', async () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as CSSStyleDeclaration,
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement;
    let archive: Blob | null = null;

    const result = await outputBrowserUrlFiles({
      intent: 'download',
      archiveFileName: 'storyboard.zip',
      forceArchive: true,
      files: [{ id: 'frame', fileName: '01.png', url: 'blob:frame' }],
      fetchFile: vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(['frame']),
      })),
    }, {
      documentRef: {
        createElement: vi.fn(() => anchor),
        body: { appendChild: vi.fn() },
      },
      objectUrlApi: {
        createObjectURL: vi.fn((blob: Blob) => {
          archive = blob;
          return 'blob:storyboard';
        }),
        revokeObjectURL: vi.fn(),
      },
    });

    expect(result.disposition).toBe('zip-download');
    expect(anchor.download).toBe('storyboard.zip');
    expect(readZipEntries(new Uint8Array(await archive!.arrayBuffer())).map((entry) => entry.path))
      .toEqual(['01.png']);
  });

  it('derives a browser asset extension from its Blob MIME type when the caller has no extension', async () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as CSSStyleDeclaration,
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement;

    const result = await outputBrowserAssetFiles({
      intent: 'download',
      archiveFileName: 'unused.zip',
      repository: {
        read: vi.fn(async () => new Blob(['webp'], { type: 'image/webp' })),
      },
      files: [{ id: 'generated', assetId: 'asset-generated', fileName: 'generated-image' }],
    }, {
      documentRef: {
        createElement: vi.fn(() => anchor),
        body: { appendChild: vi.fn() },
      },
      objectUrlApi: {
        createObjectURL: vi.fn(() => 'blob:generated'),
        revokeObjectURL: vi.fn(),
      },
    });

    expect(result.files).toEqual([expect.objectContaining({
      id: 'generated',
      fileName: 'generated-image.webp',
    })]);
    expect(anchor.download).toBe('generated-image.webp');
  });
});
