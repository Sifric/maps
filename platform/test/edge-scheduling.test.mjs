import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optimizeFleet } from '../../worker/fleet.mjs';
import { validateAddress } from '../../worker/address.mjs';

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
