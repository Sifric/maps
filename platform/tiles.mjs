import { open } from 'node:fs/promises';
import { PMTiles } from 'pmtiles';

export async function openTiles(path) {
  const file = await open(path, 'r');
  const size = (await file.stat()).size;
  const archive = new PMTiles({
    getKey: () => path,
    async getBytes(offset, length) {
      const bytes = Buffer.alloc(Math.min(length, Math.max(0, size - offset)));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytesRead) };
    },
  });
  let header;
  try {
    header = await archive.getHeader();
    if (header.tileType !== 1) throw new Error('SIFRIC_PMTILES_PATH must contain a vector archive.');
  } catch (error) {
    await file.close();
    throw error;
  }
  return {
    async read(z, x, y) {
      if (z < header.minZoom || z > header.maxZoom || x >= 2 ** z || y >= 2 ** z) return null;
      return (await archive.getZxy(z, x, y))?.data ?? null;
    },
    close: () => file.close(),
  };
}
