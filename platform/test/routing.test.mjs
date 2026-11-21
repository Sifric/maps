import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handleApi } from '../api.mjs';

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
