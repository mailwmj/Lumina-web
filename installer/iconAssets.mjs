import fs from 'node:fs/promises';
import path from 'node:path';

import pngToIco from 'png-to-ico';
import { PNG } from 'pngjs';

const iconsetEntries = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
];

export async function generateWindowsIcon(sourcePath, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, await pngToIco(sourcePath));
}

export async function generateMacIcon(sourcePath, destinationPath) {
  const source = PNG.sync.read(await fs.readFile(sourcePath));
  const chunks = iconsetEntries.map(([type, size]) => {
    const png = PNG.sync.write(resizePng(source, size));
    const chunk = Buffer.allocUnsafe(8 + png.length);
    chunk.write(type, 0, 4, 'ascii');
    chunk.writeUInt32BE(8 + png.length, 4);
    png.copy(chunk, 8);
    return chunk;
  });
  const result = Buffer.allocUnsafe(8 + chunks.reduce((total, chunk) => total + chunk.length, 0));
  result.write('icns', 0, 4, 'ascii');
  result.writeUInt32BE(result.length, 4);
  let offset = 8;
  for (const chunk of chunks) {
    chunk.copy(result, offset);
    offset += chunk.length;
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, result);
}

function resizePng(source, size) {
  const output = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor((y * source.height) / size));
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x * source.width) / size));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const outputOffset = (y * size + x) * 4;
      output.data[outputOffset] = source.data[sourceOffset];
      output.data[outputOffset + 1] = source.data[sourceOffset + 1];
      output.data[outputOffset + 2] = source.data[sourceOffset + 2];
      output.data[outputOffset + 3] = source.data[sourceOffset + 3];
    }
  }
  return output;
}
