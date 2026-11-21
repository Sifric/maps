import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optimizeFleet } from '../../worker/fleet.mjs';
import { validateAddress } from '../../worker/address.mjs';
import { locateByCell } from '../../worker/cell-location.mjs';

test('fleet insertion respects delivery precedence, loads, and time windows', async () => {
  const start = [79.86, 6.92], pickup = [79.87, 6.92], delivery = [79.88, 6.92];
  const matrix = { durations: [[0, 10, 20], [10, 0, 10], [20, 10, 0]],
    distances: [[0, 50, 100], [50, 0, 50], [100, 50, 0]] };
  const result = await optimizeFleet({}, {
    vehicles: [{ id: 1, start, end: start, capacity: [2], time_window: [0, 80] }],
    shipments: [{
      amount: [2],
      pickup: { id: 10, location: pickup, time_windows: [[15, 30]] },
      delivery: { id: 11, location: delivery, service: 5 },
    }],
    jobs: [{ id: 12, location: pickup, pickup: [3] }],
  }, async (_bucket, operation) => {
    assert.equal(operation, 'matrix');
    return matrix;
  });
  assert.deepEqual(result.unassigned.map(stop => stop.id), [12]);
  const { steps } = result.routes[0];
  assert.deepEqual(steps.map(step => step.type), ['start', 'pickup', 'delivery', 'end']);
  assert.deepEqual(steps.map(step => step.load[0]), [0, 2, 0, 0]);
  assert.equal(steps[1].waiting_time, 5);
  assert.equal(result.summary.distance, 200);
});

test('fleet saves the qualified vehicle for a stop with fewer assignment choices', async () => {
  const start = [79.86, 6.92], flexible = [79.87, 6.92], restricted = [79.88, 6.92];
  const matrix = { durations: [[0, 5, 20], [5, 0, 20], [20, 20, 0]],
    distances: [[0, 50, 100], [50, 0, 50], [100, 50, 0]] };
  const result = await optimizeFleet({}, {
    vehicles: [{ id: 1, start, skills: [1], max_tasks: 1 }, { id: 2, start, max_tasks: 1 }],
    jobs: [{ id: 3, location: flexible }, { id: 4, location: restricted, skills: [1] }],
  }, async () => matrix);
  assert.equal(result.unassigned.length, 0);
  assert.equal(result.routes.find(route => route.vehicle === 1).steps.at(-1).id, 4);
});

test('address validation preserves leading zeroes and flags town mismatches', () => {
  const verified = validateAddress({ locality: 'Colombo 03', postalCode: '００３００', addressLines: [' 4  Main Road '] });
  assert.equal(verified.postalTownVerified, true);
  assert.equal(verified.normalizedAddress.postalCode, '00300');
  assert.deepEqual(verified.normalizedAddress.addressLines, ['4 Main Road']);
  assert.equal(verified.deliverability, 'unverified');
  const mismatch = validateAddress({ locality: 'Colombo 03', postalCode: '30000' });
  assert.ok(mismatch.issues.includes('postal_town_mismatch'));
  assert.equal(mismatch.suggestions[0].locality, 'Batticaloa');
  assert.equal(validateAddress({ locality: 'Kandy' }).suggestions[0].postalCode, '20000');
});

test('fleet planner assigns qualified vehicles within booking, distance, and travel limits', async () => {
  const start = [79.86, 6.92], stop = [79.87, 6.92];
  const matrix = { durations: [[0, 10], [10, 0]], distances: [[0, 150], [150, 0]] };
  const result = await optimizeFleet({}, {
    avoidHighways: true,
    vehicles: [
      { id: 1, start, skills: [7], max_tasks: 1, max_distance: 150, max_travel_time: 10 },
      { id: 2, start, skills: [7], max_travel_time: 9 },
      { id: 3, start, skills: [7], max_distance: 149 },
      { id: 4, start, skills: [6] },
    ],
    jobs: [
      { id: 1, location: stop, skills: [7], priority: 1 },
      { id: 2, location: stop, skills: [7], priority: 5, setup: 20 },
    ],
  }, async (_bucket, _operation, request) => {
    assert.equal(request.avoidHighways, true);
    return matrix;
  });
  assert.deepEqual(result.unassigned.map(job => job.id), [1]);
  assert.equal(result.routes[0].vehicle, 1);
  assert.equal(result.routes[0].steps.at(-1).id, 2);
  assert.equal(result.routes[0].steps.at(-1).setup, 20);
});

test('cellular estimates deduplicate observations and report coverage from the local index', async () => {
  const bytes = new Uint8Array(44);
  bytes.set(new TextEncoder().encode('SIFRICC1'));
  const row = new DataView(bytes.buffer);
  row.setUint32(8, 1, true);
  row.setUint16(12, 3, true);
  row.setUint16(14, 2, true);
  row.setUint32(16, 100, true);
  row.setBigUint64(20, 1234n, true);
  row.setFloat32(28, 79.86, true);
  row.setFloat32(32, 6.92, true);
  row.setUint32(36, 1500, true);
  const tower = { mobileCountryCode: 413, mobileNetworkCode: 2, locationAreaCode: 100, cellId: 1234 };
  const bucket = { get: async () => ({ size: bytes.length, arrayBuffer: async () => bytes.buffer }) };
  const match = await locateByCell(bucket, { radioType: 'lte', cellTowers: [tower, tower] });
  assert.equal(match.matchedCells, 1);
  assert.equal(match.estimatedCoverageMeters, 1500);
  assert.ok(Math.abs(match.location.latitude - 6.92) < 1e-5);
  await assert.rejects(locateByCell(bucket, { radioType: 'lte', cellTowers: [{ ...tower, cellId: 7 }] }), { status: 404 });
});
