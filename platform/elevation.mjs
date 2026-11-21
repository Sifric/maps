import { open } from 'node:fs/promises';
import { join } from 'node:path';

export async function sampleElevation(directory, lon, lat) {
  const west = Math.floor(lon);
  const south = Math.floor(lat);
  const name = `${south < 0 ? 'S' : 'N'}${String(Math.abs(south)).padStart(2, '0')}${west < 0 ? 'W' : 'E'}${String(Math.abs(west)).padStart(3, '0')}.hgt`;
  let tile;
  try {
    tile = await open(join(directory, name), 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const samples = Math.sqrt((await tile.stat()).size / 2);
    if (![1201, 3601].includes(samples)) throw new Error('Invalid SRTM tile size.');
    const row = Math.round((south + 1 - lat) * (samples - 1));
    const column = Math.round((lon - west) * (samples - 1));
    const value = Buffer.alloc(2);
    const { bytesRead } = await tile.read(value, 0, 2, 2 * (row * samples + column));
    if (bytesRead !== 2) throw new Error('Incomplete SRTM sample.');
    const meters = value.readInt16BE();
    return meters === -32768 ? null : { elevationMeters: meters, sampleSpacingArcSeconds: 3600 / (samples - 1), source: 'SRTM HGT' };
  } finally {
    await tile.close();
  }
}
