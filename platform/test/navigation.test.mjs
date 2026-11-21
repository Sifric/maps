import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const sdk = await readFile(new URL('../../worker/private/sifric-navigation.js.txt', import.meta.url));
const { createSifricNavigation, formatSifricManeuver } =
  await import(`data:text/javascript;base64,${sdk.toString('base64')}`);

const start = [79.86, 6.93];
const turn = [79.865, 6.93];
const end = [79.865, 6.935];
const route = {
  geometry: { type: 'LineString', coordinates: [start, turn, end] },
  duration: 180,
  legs: [{ steps: [
    { maneuver: { type: 'depart', location: start }, name: 'First Road' },
    { maneuver: { type: 'turn', modifier: 'left', location: turn }, name: 'Second Road' },
    { maneuver: { type: 'arrive', location: end } },
  ] }],
};

function devices() {
  let callback;
  let locationError;
  const cleared = [];
  return {
    geolocation: {
      watchPosition(success, error) { callback = success; locationError = error; return 17; },
      clearWatch(id) { cleared.push(id); },
    },
    fix([longitude, latitude], timestamp, accuracy = 5) {
      callback({ coords: { longitude, latitude, accuracy }, timestamp });
    },
    locationError(error) { locationError(error); },
    cleared,
  };
}

test('reports the next maneuver, route progress and arrival from device fixes', async () => {
  const device = devices();
  const events = [];
  const client = { route: async () => ({ routes: [route] }) };
  const session = createSifricNavigation({ client, geolocation: device.geolocation, onUpdate: event => events.push(event) });
  assert.equal(await session.start({ origin: start, destination: end }), true);
  assert.deepEqual(events.map(event => event.status), ['planning', 'route']);
  device.fix(start, 1000, 100);
  assert.equal(events.length, 2);
  device.fix(start, 1010);
  assert.equal(events.at(-1).status, 'progress');
  assert.equal(formatSifricManeuver(events.at(-1).nextManeuver), 'Turn left onto Second Road');
  assert.ok(events.at(-1).remainingMeters > 1000);
  device.fix([79.865, 6.931], 1020);
  assert.equal(events.at(-1).nextManeuver.type, 'arrive');
  device.fix(start, 1015);
  assert.equal(events.at(-1).nextManeuver.type, 'arrive');
  device.fix(end, 1030);
  assert.equal(events.at(-1).status, 'arrived');
  assert.deepEqual(device.cleared, [17]);
});

test('routes again from the device after three off-route fixes and clears watches on cancellation', async () => {
  const device = devices();
  const calls = [];
  const events = [];
  const client = { route: async (body, signal) => { calls.push({ body, signal }); return { routes: [route] }; } };
  const session = createSifricNavigation({ client, geolocation: device.geolocation, onUpdate: event => events.push(event) });
  await session.start({ origin: start, destination: end, mode: 'tuk' });
  const offRoute = [79.86, 6.931];
  for (const timestamp of [1000, 1100, 1200]) device.fix(offRoute, timestamp);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { coordinates: [offRoute, end], mode: 'tuk' });
  assert.equal(events.at(-1).rerouted, true);
  session.stop();
  assert.deepEqual(device.cleared, [17]);
  const count = events.length;
  device.fix(start, 1300);
  assert.equal(events.length, count);
});

test('permission failure stops tracking and an abandoned route response cannot restart it', async () => {
  const device = devices();
  const events = [];
  let finish;
  let delayedSignal;
  const client = { route: async (_body, signal) => {
    delayedSignal = signal;
    return new Promise(resolve => { finish = resolve; });
  } };
  const session = createSifricNavigation({ client, geolocation: device.geolocation, onUpdate: event => events.push(event) });
  const first = session.start({ origin: start, destination: end });
  session.stop();
  assert.equal(delayedSignal.aborted, true);
  finish({ routes: [route] });
  assert.equal(await first, false);
  assert.deepEqual(events.map(event => event.status), ['planning']);

  const second = session.start({ origin: start, destination: end });
  finish({ routes: [route] });
  assert.equal(await second, true);
  device.locationError({ code: 1, message: 'Permission denied' });
  assert.equal(events.at(-1).status, 'location-error');
  assert.equal(events.at(-1).code, 1);
  assert.deepEqual(device.cleared, [17]);
});
