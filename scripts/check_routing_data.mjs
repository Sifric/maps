import assert from 'node:assert/strict';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { routingRequest } from '../worker/routing.mjs';

const directory = process.argv[2];
for (const mode of ['drive', 'walk', 'cycle']) {
  const file = join(directory, mode + '.bin');
  const { size, mtimeMs } = await stat(file);
  const etag = String(mtimeMs);
  const bucket = {
    head: async () => ({ size, etag }),
    async get(_key, { range: { offset, length } }) {
      const handle = await open(file);
      try {
        const data = new Uint8Array(length);
        const read = await handle.read(data, 0, length, offset);
        assert.equal(read.bytesRead, length);
        return new Response(data);
      } finally {
        await handle.close();
      }
    },
  };
  const coordinates = [[79.8612, 6.9271], [79.8744, 6.903]];
  const route = await routingRequest(bucket, 'routes', { mode, coordinates });
  assert.ok(route.routes[0].distance > 2500 && route.routes[0].distance < 15000);
  assert.ok(route.routes[0].geometry.coordinates.length > 5);
  assert.ok(route.routes[0].geometry.coordinates.every(point => point.every(Number.isFinite)));
  assert.ok(route.routes[0].legs[0].steps.length >= 2);
  const matrix = await routingRequest(bucket, 'matrix', { mode, coordinates });
  assert.equal(matrix.distances[0][0], 0);
  assert.equal(matrix.distances[0][1], route.routes[0].distance);
  console.log(mode, route.routes[0].distance, 'meters', route.routes[0].duration, 'seconds');
}
