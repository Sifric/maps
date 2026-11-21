import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleApi } from '../api.mjs';
import { openPlaces } from '../places.mjs';

test('search, details, nearby and time zone work with Unicode and explicit precision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sifric-places-'));
  const file = join(directory, 'places.json');
  await writeFile(file, JSON.stringify([[123, 'Colombo', 79.86, 6.92, 'other', '', 'கொழும்பு']]));
  const places = await openPlaces(file);
  const get = path => handleApi(new Request('https://sifric.test/api/v1' + path), places, {});
  try {
    assert.equal((await (await get('/places/search?q=' + encodeURIComponent('கொழும்பு'))).json()).items[0].id, 123);
    assert.equal((await get('/places/124')).status, 404);
    assert.equal((await (await get('/places/123')).json()).label, 'கொழும்பு');
    const nearby = await (await get('/geocode/reverse?lon=79.86&lat=6.92')).json();
    assert.equal(nearby.precision, 'indexed-place');
    assert.equal(nearby.items[0].distanceMeters, 0);
    const timezone = await (await get('/timezone?lon=79.86&lat=6.92&timestamp=2026-11-21T00:00:00Z')).json();
    assert.equal(timezone.offset, '+05:30');
    assert.equal((await get('/timezone?lon=&lat=6.92')).status, 400);
    assert.equal((await get('/elevation?lon=79.86&lat=6.92')).status, 503);
  } finally {
    places.close();
    await rm(directory, { recursive: true, force: true });
  }
});
