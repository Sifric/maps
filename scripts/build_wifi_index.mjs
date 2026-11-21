import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizeMac } from '../worker/wifi-location.mjs';

const rows = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!Array.isArray(rows) || !rows.length || rows.length > 20000) throw new Error('Supply 1 to 20000 authorized observations.');
const index = Object.create(null);
for (const { macAddress, longitude, latitude, radiusMeters } of rows) {
  const mac = normalizeMac(macAddress);
  if (!mac || ![longitude, latitude, radiusMeters].every(Number.isFinite) ||
      longitude < 78 || longitude > 82.5 || latitude < 5 || latitude > 10.5 || radiusMeters < 25 || radiusMeters > 500) {
    throw new Error('An observation is invalid.');
  }
  const hash = createHash('sha256').update(mac).digest('hex');
  if (index[hash]) throw new Error('Duplicate access point.');
  index[hash] = [longitude, latitude, radiusMeters];
}
const output = JSON.stringify(index);
if (Buffer.byteLength(output) > 2_000_000) throw new Error('Index exceeds the Worker input limit.');
await writeFile(process.argv[3], output, { mode: 0o600 });
