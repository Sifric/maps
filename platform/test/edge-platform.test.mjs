import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { encode } from 'fast-png';
import { createPlatformApi, terrarium } from '../../worker/platform-api.mjs';
import { createPrivateGateway } from '../../worker/private-gateway.mjs';

const row = [123, 'Colombo', 79.86, 6.92, 'other', 'City', 'கொழும்பு'];
const assets = new Map([
  ['/_sifric_index/search/636f.json', [row]],
  ['/_sifric_index/id/123.json', [row]],
  ['/_sifric_index/near/798-69.json', [row]],
]);
const local = createPlatformApi('sri-lanka.pmtiles');
const gateway = createPrivateGateway(new Map(), local);
const token = randomBytes(32).toString('base64url');
const env = {
  SIFRIC_DEVELOPER_TOKEN_HASHES: JSON.stringify([createHash('sha256').update(token).digest('hex')]),
  ASSETS: {
    async fetch(request) {
      const value = assets.get(new URL(request.url).pathname);
      return value ? Response.json(value) : new Response(null, { status: 404 });
    },
  },
};

async function call(path, authorized = true) {
  const pathname = '/developer/api/v1' + path;
  const request = new Request('https://maps.test' + pathname, {
    headers: authorized ? { Authorization: 'Bearer ' + token } : {},
  });
  return gateway(request, env, new URL(request.url).pathname, () => {
    assert.fail('Local endpoint attempted to use an external platform.');
  });
}

test('authenticated place lookup, timezone and health run without a backend', async () => {
  assert.equal((await call('/places/search?q=Colombo', false)).status, 401);
  assert.equal((await (await call('/health')).json()).runtime, 'cloudflare-workers');
  assert.equal((await (await call('/places/search?q=Colombo')).json()).items[0].id, 123);
  assert.equal((await (await call('/places/123')).json()).label, 'கொழும்பு');
  assert.equal((await call('/places/124')).status, 404);
  const response = await call('/geocode/reverse?lon=79.86&lat=6.92');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const closest = await response.json();
  assert.equal(closest.precision, 'indexed-place');
  assert.equal(closest.items[0].distanceMeters, 0);
  const zone = await (await call('/timezone?lon=79.86&lat=6.92&timestamp=2026-11-21T00:00:00Z')).json();
  assert.equal(zone.offset, '+05:30');
  assert.equal((await call('/timezone?lon=&lat=6.92')).status, 400);
  assert.equal((await call('/tiles/99/0/0.pbf')).status, 404);
});

test('Terrarium samples a bounded RGB tile at the configured source', async () => {
  const data = new Uint8Array(256 * 256 * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = 128; data[i + 1] = 203; data[i + 2] = 128;
  }
  const image = encode({ width: 256, height: 256, depth: 8, channels: 3, data });
  const sample = await terrarium(80.77, 6.97, async url => {
    assert.match(url, /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\/14\//);
    return new Response(image);
  });
  assert.equal(sample.elevationMeters, 203.5);
  assert.equal(await terrarium(80.77, 6.97, async () => new Response(null, { status: 404 })), null);
});

test('static map validates options and launches a renderer only after authentication', async () => {
  const binding = {};
  let renders = 0;
  const render = createPlatformApi('sri-lanka.pmtiles', async (browser, _request, options) => {
    renders++;
    assert.equal(browser, binding);
    assert.deepEqual(options, { lon: 79.86, lat: 6.92, zoom: 13, width: 320, height: 240, pin: '1', theme: 'dark' });
    return new Uint8Array([137, 80, 78, 71]);
  });
  const dispatch = createPrivateGateway(new Map(), render);
  const path = '/developer/api/v1/static-map';
  const url = 'https://maps.test' + path + '?lon=79.86&lat=6.92&width=320&height=240&pin=1&theme=dark';
  const configured = { ...env, MAP_BROWSER: binding };
  const headers = { Authorization: 'Bearer ' + token };
  assert.equal((await dispatch(new Request(url), configured, path)).status, 401);
  assert.equal((await dispatch(new Request(url.replace('width=320', 'width=3000'), { headers }), configured, path)).status, 400);
  assert.equal(renders, 0);
  const image = await dispatch(new Request(url, { headers }), configured, path);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.equal(image.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(renders, 1);
});
