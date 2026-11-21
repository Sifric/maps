import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleApi } from '../api.mjs';

test('configured geocoder and fleet optimizer receive Sri Lanka requests', async () => {
  const calls = [];
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push([url, chunks.length ? JSON.parse(Buffer.concat(chunks)) : null]);
    res.setHeader('content-type', 'application/json');
    const place = { display_name: 'Colombo', lon: '79.86', lat: '6.92' };
    res.end(JSON.stringify(url.pathname.endsWith('/search') ? [place] : url.pathname.endsWith('/reverse') ? place : { code: 0, routes: [] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SIFRIC_NOMINATIM_URL: server + '/geocoder', SIFRIC_VROOM_URL: server + '/solver' };
  const request = (path, init) => handleApi(new Request('http://sifric.test/api/v1' + path, init), {}, env);
  try {
    assert.equal((await (await request('/geocode?q=Colombo')).json()).items[0].lon, 79.86);
    assert.equal(calls[0][0].searchParams.get('countrycodes'), 'lk');
    assert.equal((await (await request('/geocode/reverse?lon=79.86&lat=6.92')).json()).source, 'Nominatim');
    const payload = { vehicles: [{ id: 1, start: [79.86, 6.92], capacity: [2] }], jobs: [{ id: 2, location: [79.87, 6.93], time_windows: [[0, 1000]] }] };
    const response = await request('/optimize', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[2][1], payload);
    payload.jobs[0].location = [0, 0];
    assert.equal((await request('/optimize', { method: 'POST', body: JSON.stringify(payload) })).status, 400);
    assert.equal(calls.length, 3);
  } finally {
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('HGT elevation reads the expected signed sample and reports missing coverage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sifric-hgt-'));
  const side = 1201;
  const tile = Buffer.alloc(side * side * 2);
  tile.writeInt16BE(214, (600 * side + 600) * 2);
  tile.writeInt16BE(-32768, (600 * side + 300) * 2);
  await writeFile(join(directory, 'N07E080.hgt'), tile);
  const get = lon => handleApi(new Request(`http://sifric.test/api/v1/elevation?lon=${lon}&lat=7.5`), {}, { SIFRIC_ELEVATION_DIR: directory });
  try {
    assert.equal((await (await get(80.5)).json()).elevationMeters, 214);
    assert.equal((await get(80.25)).status, 404);
    assert.equal((await get(81.5)).status, 404);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
