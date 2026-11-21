import assert from 'node:assert/strict';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { routingRequest } from '../worker/routing.mjs';

const directory = process.argv[2];
for (const mode of process.argv.slice(3).length ? process.argv.slice(3) : ['drive', 'walk', 'cycle', 'motorcycle', 'tuk']) {
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
  if (mode === 'motorcycle' || mode === 'tuk') {
    const { routes: [southern] } = await routingRequest(bucket, 'routes', {
      mode, coordinates: [coordinates[0], [80.221, 6.032]],
    });
    assert.ok(southern.distance > 100000 && southern.distance < 180000);
    const speed = mode === 'tuk' ? 40 : 80;
    assert.ok(southern.distance * 3.6 / southern.duration <= speed);
  }
  if (mode === 'drive') {
    const { routes: [regional] } = await routingRequest(bucket, 'routes', {
      mode, coordinates: [[79.8612, 6.9271], [80.635, 7.293]], speedLimits: true,
    });
    assert.ok(regional.distance > 80000 && regional.distance < 180000);
    const limits = regional.legs[0].speedLimits;
    assert.ok(limits.some(span => span.speed > 0));
    assert.equal(limits.at(-1).endIndex, regional.geometry.coordinates.length - 1);
    for (const destination of [[81.695, 7.717], [81.233, 8.577]]) {
      const { routes: [regional] } = await routingRequest(bucket, 'routes', {
        mode, coordinates: [coordinates[0], destination],
      });
      assert.ok(regional.distance > 200000 && regional.distance < 400000);
    }
    const observations = route.routes[0].geometry.coordinates.filter((_, i) => i % 8 === 0).slice(0, 5);
    const trace = await routingRequest(bucket, 'match', { coordinates: observations });
    assert.equal(trace.tracepoints.length, observations.length);
  }
  console.log(mode, route.routes[0].distance, 'meters', route.routes[0].duration, 'seconds');
}
