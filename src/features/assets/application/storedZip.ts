const TEXT_ENCODER = new TextEncoder();
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_MAX_UINT32 = 0xffffffff;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 1 ? (current >>> 1) ^ 0xedb88320 : current >>> 1;
    }
    table[value] = current >>> 0;
  }
  return table;
})();

export interface StoredZipEntry {
  path: string;
  bytes: Uint8Array;
}

export type StoredZipErrorCode =
  | 'archive_limit'
  | 'archive_file_limit'
  | 'archive_file_name_limit';

export class StoredZipError extends Error {
  constructor(readonly code: StoredZipErrorCode) {
    super(code);
    this.name = 'StoredZipError';
  }
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function assertZipValue(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP_MAX_UINT32) {
    throw new StoredZipError('archive_limit');
  }
}

function setUint32(view: DataView, offset: number, value: number): void {
  assertZipValue(value);
  view.setUint32(offset, value, true);
}

/** Creates a standards-compatible, uncompressed ZIP without base64 expansion. */
export function createStoredZip(entries: readonly StoredZipEntry[]): Blob {
  if (entries.length > 0xffff) {
    throw new StoredZipError('archive_file_limit');
  }

  const encodedEntries = entries.map((entry) => {
    const pathBytes = TEXT_ENCODER.encode(entry.path);
    if (pathBytes.byteLength > 0xffff) {
      throw new StoredZipError('archive_file_name_limit');
    }
    assertZipValue(entry.bytes.byteLength);
    return { ...entry, pathBytes, crc32: crc32(entry.bytes) };
  });
  const localSize = encodedEntries.reduce(
    (total, entry) => total + 30 + entry.pathBytes.byteLength + entry.bytes.byteLength,
    0,
  );
  const centralSize = encodedEntries.reduce(
    (total, entry) => total + 46 + entry.pathBytes.byteLength,
    0,
  );
  const totalSize = localSize + centralSize + 22;
  assertZipValue(localSize);
  assertZipValue(centralSize);
  assertZipValue(totalSize);

  const archive = new Uint8Array(totalSize);
  const view = new DataView(archive.buffer);
  let offset = 0;
  const localOffsets: number[] = [];

  for (const entry of encodedEntries) {
    localOffsets.push(offset);
    setUint32(view, offset, ZIP_LOCAL_FILE_HEADER);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 0, true);
    setUint32(view, offset + 14, entry.crc32);
    setUint32(view, offset + 18, entry.bytes.byteLength);
    setUint32(view, offset + 22, entry.bytes.byteLength);
    view.setUint16(offset + 26, entry.pathBytes.byteLength, true);
    view.setUint16(offset + 28, 0, true);
    archive.set(entry.pathBytes, offset + 30);
    archive.set(entry.bytes, offset + 30 + entry.pathBytes.byteLength);
    offset += 30 + entry.pathBytes.byteLength + entry.bytes.byteLength;
  }

  const centralDirectoryOffset = offset;
  for (const [index, entry] of encodedEntries.entries()) {
    setUint32(view, offset, ZIP_CENTRAL_DIRECTORY_HEADER);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 0, true);
    view.setUint16(offset + 14, 0, true);
    setUint32(view, offset + 16, entry.crc32);
    setUint32(view, offset + 20, entry.bytes.byteLength);
    setUint32(view, offset + 24, entry.bytes.byteLength);
    view.setUint16(offset + 28, entry.pathBytes.byteLength, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    setUint32(view, offset + 38, 0);
    setUint32(view, offset + 42, localOffsets[index] ?? 0);
    archive.set(entry.pathBytes, offset + 46);
    offset += 46 + entry.pathBytes.byteLength;
  }

  setUint32(view, offset, ZIP_END_OF_CENTRAL_DIRECTORY);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  setUint32(view, offset + 12, centralSize);
  setUint32(view, offset + 16, centralDirectoryOffset);
  view.setUint16(offset + 20, 0, true);

  return new Blob([archive], { type: 'application/zip' });
}
