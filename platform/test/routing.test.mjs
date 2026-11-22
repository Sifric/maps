import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { handleApi } from '../api.mjs';
import { solveRoute } from '../../worker/routing.mjs';

const calls = [];
const upstream = createServer((req, res) => {
  calls.push(new URL(req.url, 'http://localhost'));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ code: 'Ok', durations: [[10]], distances: [[120]] }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${upstream.address().port}/profile`;
const env = { SIFRIC_OSRM_DRIVE_URL: base, SIFRIC_OSRM_WALK_URL: base };
const coordinates = [[79.86, 6.92], [79.87, 6.93]];
const post = (path, body) => handleApi(new Request(`https://maps.test/api/v1/${path}`, {
  method: 'POST', body: JSON.stringify(body),
}), {}, env);

try {
  assert.equal((await post('routes', { mode: 'tuk', coordinates })).status, 503);
  assert.equal((await post('routes', { mode: 'drive', coordinates: [['79.86', 6.92], coordinates[1]] })).status, 400);
  assert.equal((await post('matrix', { coordinates, sources: [2] })).status, 400);
  assert.equal((await post('routes', { coordinates, padding: 'a'.repeat(65536) })).status, 413);
  const matrix = await post('matrix', { coordinates, sources: [0], destinations: [1] });
  assert.equal(matrix.status, 200);
  assert.equal((await matrix.json()).durations[0][0], 10);
  assert.equal(calls[0].pathname, '/profile/table/v1/driving/79.86,6.92;79.87,6.93');
  assert.equal(calls[0].searchParams.get('annotations'), 'duration,distance');
  assert.equal(calls[0].searchParams.get('sources'), '0');
  assert.equal(calls[0].searchParams.get('destinations'), '1');
  assert.equal((await post('roads/nearest', { coordinates: [coordinates[0]] })).status, 200);
  assert.equal((await post('roads/match', { mode: 'walk', coordinates })).status, 200);
  console.log('Routing API checks passed');
} finally {
  upstream.close();
}

test('a disconnected nearest vertex can be recovered without building off-network geometry', async () => {
  const longitude = [79.86, 79.8602, 79.8642, 79.864, 79.868];
  const latitude = 6.92;
  const column = values => ({ length: values.length, get: index => values[index] });
  const cells = new Uint32Array(500 * 600 + 1);
  const cellNodes = longitude.map((lon, index) => ({
    index, cell: Math.floor((latitude - 5) * 100) * 500 + Math.floor((lon - 78) * 100),
  })).sort((a, b) => a.cell - b.cell);
  for (const { cell } of cellNodes) cells[cell + 1]++;
  for (let i = 1; i < cells.length; i++) cells[i] += cells[i - 1];
  const graph = {
    ranks: column([0, 1, 2, 3, 4]), terminalNodes: column([]), terminalRanks: column([]),
    cells: column(cells), cellNodes: column(cellNodes.map(({ index }) => index)),
    lon: column(longitude), lat: column(longitude.map(() => latitude)),
    forward: {
      offsets: column([0, 0, 1, 2, 2, 2]), heads: column([2, 4]), weights: column([25000, 30000]),
      first: column([0, 1]), second: column([0xffffffff, 0xffffffff]),
    },
    backward: { offsets: column([0, 0, 0, 0, 0, 0]) },
    transitions: column([0, 1]), heads: column([2, 4]), meters: column([450, 425]),
    geometryLengths: column([0, 0]),
  };
  const points = [[longitude[0], latitude], [longitude[3], latitude], [longitude[4], latitude]];
  const shape = async () => new Map();
  for (const options of [{}, { optimizeWaypointOrder: true }]) {
    const result = await solveRoute(graph, points, undefined, undefined, shape, false, undefined, options);
    assert.deepEqual(result.waypoints.map(point => point.vertex), [1, 2, 4]);
    assert.equal(result.routes[0].duration, 55);
    assert.deepEqual(result.routes[0].geometry.coordinates.map(point => point[0]),
      [longitude[1], longitude[2], longitude[4]]);
    if (options.optimizeWaypointOrder) assert.deepEqual(result.optimizedIntermediateWaypointIndices, [0]);
  }
  const matrix = await solveRoute(graph, points, [0], [2], shape);
  assert.deepEqual(matrix.distances, [[null]]);
  const withUnsnapped = await solveRoute(graph, [[80, 7], [longitude[1], latitude], points[2]],
    [0, 1], [2], shape, false, undefined, { allowUnsnapped: true });
  assert.deepEqual(withUnsnapped.distances, [[null], [875]]);
  assert.equal(withUnsnapped.sources[0], null);
});
