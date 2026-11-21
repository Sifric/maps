import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { transitCoverage, transitRoute } from '../../worker/transit.mjs';
import { verifyPremise, validateAddress } from '../../worker/address.mjs';
import { annotateTraffic, validateTraffic } from '../../worker/traffic.mjs';
import { locateByWifi } from '../../worker/wifi-location.mjs';
import { nativeStyle } from '../../worker/native-style.mjs';

const bucket = value => ({ get: async () => value && Object.assign(new Response(JSON.stringify(value)), { size: 1000 }) });
const a = [79.86, 6.92], b = [79.88, 6.92], c = [79.90, 6.92];

test('transit uses active dates and permits a transfer only with enough time', async () => {
  const data = {
    agency: 'Example', source: 'https://example.test', stops: [['A', ...a], ['B', ...b], ['C', ...c]],
    routes: { bus1: ['1', 'First bus', '3'], bus2: ['2', 'Next bus', '3'] },
    days: { '2026-11-21': [
      [300, 600, 0, 1, 'first', 'bus1', true, true],
      [660, 840, 1, 2, 'missed', 'bus2', true, true],
      [780, 960, 1, 2, 'next', 'bus2', true, true],
    ] },
  };
  const result = await transitRoute(bucket(data), { coordinates: [a, c], departureTime: '2026-11-21T00:00:00+05:30' });
  assert.equal(result.legs.length, 2);
  assert.equal(result.arrivalTime, '2026-11-20T18:46:00.000Z');
  assert.deepEqual(await transitCoverage(bucket(data), Date.parse('2026-11-22T00:00:00Z') / 1000), {
    agency: 'Example', firstServiceDate: '2026-11-21', lastServiceDate: '2026-11-21',
    lastArrivalTime: '2026-11-20T18:46:00.000Z', expired: true,
  });
  await assert.rejects(transitRoute(bucket(data), { coordinates: [a, c], departureTime: '2026-11-22T00:00:00+05:30' }), { status: 404 });
});

test('premise classification comes from a mapped house, street and postal area', async () => {
  const body = { addressLines: ['14 Main Street'], locality: 'Kandy', postalCode: '20000' };
  const id = createHash('sha256').update('14\nmain street').digest('hex').slice(0, 24);
  const index = bucket({ [id]: [['kandy', '20000', 'residential']] });
  const value = await verifyPremise(validateAddress(body), body, index);
  assert.equal(value.precision, 'mapped-premise');
  assert.equal(value.propertyType, 'residential');
  assert.equal(value.deliverability, 'unverified');
});

test('traffic estimates expire, report closure, and avoid double-counting overlaps', async () => {
  const report = { observedAt: new Date().toISOString(), source: 'Fixture',
    segments: [{ from: a, to: b, factor: 2, closed: false }, { from: a, to: c, factor: 2, closed: false }] };
  const reply = () => Response.json({ routes: [{ duration: 100, geometry: { coordinates: [a, b, c] } }] });
  const result = await (await annotateTraffic(bucket(report), reply())).json();
  assert.equal(result.routes[0].trafficDuration, 200);
  report.segments[0].closed = true;
  await assert.rejects(annotateTraffic(bucket(report), reply()), { status: 409 });
  const detour = { duration: 160, geometry: { coordinates: [a, [a[0], a[1] + .01], c] } };
  const options = await reply().json();
  options.routes.push(detour);
  const open = await (await annotateTraffic(bucket(report), Response.json(options), report, true)).json();
  assert.equal(open.routes[0].duration, 160);
  assert.equal(validateTraffic({ ...report, observedAt: '2000-01-01T00:00:00Z' }), null);
  assert.equal((await (await annotateTraffic(bucket(null), reply())).json()).liveTraffic.status, 'unavailable');
});

test('Wi-Fi requires distinct cooperating access points and preserves their privacy', async () => {
  const accessPoints = ['00:10:20:00:00:01', '00:10:20:00:00:02', '00:10:20:00:00:03'].map(macAddress => ({ macAddress }));
  const known = Object.fromEntries(accessPoints.map(({ macAddress }, i) => [
    createHash('sha256').update(macAddress).digest('hex'), [79.86 + i * 0.0001, 6.92, 40],
  ]));
  const value = await locateByWifi(bucket(known), accessPoints);
  assert.equal(value.matchedAccessPoints, 3);
  assert.doesNotMatch(JSON.stringify(value), /00:10:20/);
  await assert.rejects(locateByWifi(bucket(null), accessPoints), { status: 503 });
});

test('native style generates the six supported type and theme combinations', () => {
  for (const type of ['default', 'satellite', 'terrain']) {
    for (const theme of ['light', 'dark']) {
      const style = nativeStyle({ sources: {}, layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
        { id: 'roads', type: 'line' },
      ] }, new URLSearchParams({ type, theme }));
      assert.ok(style.layers.length);
      assert.equal(style.layers[0].paint['background-color'], theme === 'dark' ? '#172e3e' : '#fff');
      if (type === 'satellite') assert.equal(style.sources.imagery.type, 'raster');
      if (type === 'terrain') assert.equal(style.sources.relief.type, 'raster-dem');
    }
  }
});
