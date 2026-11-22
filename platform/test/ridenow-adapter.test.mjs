import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../../worker/private/ridenow-maps.mjs.txt', import.meta.url));
const { createRideNowMaps } = await import('data:text/javascript;base64,' + source.toString('base64'));
const token = 'a'.repeat(43);
const start = [81.73, 7.68];
const stop = [81.74, 7.69];
const finish = [81.75, 7.70];

test('server adapter keeps the RideNow route contract and slices the geometry by leg', async () => {
  const maps = createRideNowMaps({ token, fetchImpl: async (url, options) => {
    assert.equal(url.href, 'https://maps.sifric.workers.dev/developer/api/v1/routes');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { coordinates: [start, stop, finish], mode: 'tuk' });
    const leg = (geometryIndex, distance, duration) =>
      ({ distance, duration, steps: [{ maneuver: { geometryIndex } }] });
    return Response.json({
      graphVersion: 'route-data-release', waypoints: [{ distance: 2 }, { distance: 8 }, { distance: 60 }],
      routes: [{ distance: 390, duration: 58, geometry: { type: 'LineString', coordinates: [start, stop, finish] },
        legs: [leg(1, 180, 25), leg(2, 210, 33)] }],
    });
  } });
  const route = await maps.route({ waypoints: [start, stop, finish], vehicleCategory: 'TUK' });
  assert.equal(route.graphVersion, 'route-data-release');
  assert.equal(route.distanceMeters, 390);
  assert.equal(route.durationSeconds, 58);
  assert.deepEqual(route.legs.map(leg => leg.geometry.coordinates), [[start, stop], [stop, finish]]);
  assert.deepEqual(route.snappedWaypointDistancesMeters, [2, 8, 60]);
  await assert.rejects(maps.route({ waypoints: [start, finish], vehicleCategory: 'VAN' }), {
    code: 'CATEGORY_MAP_NOT_APPROVED',
  });
});

test('dispatch retains candidate indexes and distinguishes a missing route from a provider outage', async () => {
  let status = 200;
  const maps = createRideNowMaps({ token, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/developer/api/v1/matrix');
    assert.deepEqual(JSON.parse(options.body), {
      coordinates: [start, stop, finish], mode: 'drive', sources: [0, 1], destinations: [2], allowUnsnapped: true,
    });
    return Response.json({ durations: [[20], [null]], distances: [[190], [null]],
      sources: [{ distance: 2 }, null], destinations: [{ distance: 10 }] }, { status });
  } });
  const input = { origins: [start, [0, 0], stop], destination: finish, vehicleCategory: 'CAR' };
  assert.deepEqual(await maps.matrix(input), [{ durationSeconds: 20, distanceMeters: 190 }, null, null]);
  status = 503;
  await assert.rejects(maps.matrix(input), { status: 503, code: 'MAPS_UNAVAILABLE' });
  status = 401;
  await assert.rejects(maps.matrix(input), { status: 503, code: 'MAPS_AUTH_FAILED' });
});
