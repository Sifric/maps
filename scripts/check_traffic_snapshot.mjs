import { readFile } from 'node:fs/promises';
import { validateTraffic } from '../worker/traffic.mjs';
const valid = validateTraffic(JSON.parse(await readFile(process.argv[2], 'utf8')));
if (!valid) throw new Error('Use a current, valid traffic observation snapshot.');
console.log('Validated', valid.segments.length, 'traffic segments');
