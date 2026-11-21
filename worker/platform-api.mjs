import { decode } from 'fast-png';
import { EtagMismatch, PMTiles, TileType } from 'pmtiles';
import { nearestRoad } from './roads.mjs';
import { availableRoutingModes, routingRequest, RoutingError } from './routing.mjs';
import { optimizeFleet } from './fleet.mjs';
import { validateAddress } from './address.mjs';
import { sampleRelief } from './bathymetry.mjs';
import { locateByCell } from './cell-location.mjs';

const result = (body, status = 200) => Response.json(body, { status });
const bounds = { west: 78, east: 82.5, south: 5, north: 10.5 };
const normalize = value => value.normalize('NFKC').toLowerCase().trim();

class Invalid extends Error {}

function number(value, name, min, max) {
  const n = Number(value);
  if (value == null || !String(value).trim() || !Number.isFinite(n) || n < min || n > max) {
    throw new Invalid(`Invalid ${name}.`);
  }
  return n;
}

function coords(query) {
  return [number(query.get('lon'), 'longitude', bounds.west, bounds.east),
    number(query.get('lat'), 'latitude', bounds.south, bounds.north)];
}

async function routePayload(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new RoutingError(400, 'Supply a JSON object.');
  const decoder = new TextDecoder();
  let body = '', bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) {
        await reader.cancel();
        throw new RoutingError(413, 'Request exceeds 16 KiB.');
      }
      body += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(body + decoder.decode());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof RoutingError) throw error;
    throw new RoutingError(400, 'Supply a JSON object.');
  } finally {
    reader.releaseLock();
  }
}

function place([id, name, lon, lat, kind, description, label]) {
  return { id, name, lon, lat, kind, description, label: label ?? null };
}

async function shard(env, origin, path) {
  const response = await env.ASSETS.fetch(new Request(new URL('/_sifric_index/' + path + '.json', origin)));
  if (response.status === 404) return [];
  if (!response.ok) throw new Error('Place index unavailable.');
  return response.json();
}

function distance(aLon, aLat, bLon, bLat) {
  const rad = Math.PI / 180;
  const a = Math.sin((aLat - bLat) * rad / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin((aLon - bLon) * rad / 2) ** 2;
  return 12742017.6 * Math.asin(Math.sqrt(Math.min(1, a)));
}

function vectorArchive(bucket, tileKey) {
  return new PMTiles({
    getKey: () => tileKey,
    async getBytes(offset, length, _signal, etag) {
      const object = await bucket.get(tileKey, { range: { offset, length } });
      if (!object) throw new Error('Vector archive unavailable.');
      if (etag && etag !== object.httpEtag) throw new EtagMismatch();
      return { data: await object.arrayBuffer(), etag: object.httpEtag };
    },
  });
}

export async function terrarium(lon, lat, fetchTile = fetch) {
  const zoom = 14, count = 2 ** zoom;
  const x = count * (lon + 180) / 360;
  const y = count * (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
  const tileX = Math.floor(x), tileY = Math.floor(y);
  const response = await fetchTile(
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${tileX}/${tileY}.png`,
    { signal: AbortSignal.timeout(6000), redirect: 'manual' },
  );
  if (response.status === 404) return null;
  if (!response.ok || !response.body) throw new Error('Terrain tile unavailable.');
  const bytes = new Uint8Array(1048576);
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (length + value.length > bytes.length) {
        await reader.cancel();
        throw new Error('Terrain tile exceeds the response limit.');
      }
      bytes.set(value, length);
      length += value.length;
    }
  } finally { reader.releaseLock(); }
  const header = new DataView(bytes.buffer);
  if (length < 24 || header.getUint32(16) !== 256 || header.getUint32(20) !== 256) {
    throw new Error('Unexpected terrain tile dimensions.');
  }
  const png = decode(bytes.subarray(0, length));
  if (png.depth !== 8 || ![3, 4].includes(png.channels)) throw new Error('Unexpected terrain pixel format.');
  const column = Math.floor((x - tileX) * 256), row = Math.floor((y - tileY) * 256);
  const offset = (row * 256 + column) * png.channels;
  if (png.channels === 4 && !png.data[offset + 3]) return null;
  const [r, g, b] = png.data.subarray(offset, offset + 3);
  return { elevationMeters: r * 256 + g + b / 256 - 32768, source: 'Mapzen Terrarium / AWS Open Data', tileZoom: zoom };
}

export function createPlatformApi(tileKey, renderStaticMap) {
  return async function localApi(request, env, path) {
    const prefix = '/developer/api/v1';
    if (!path.startsWith(prefix + '/')) return null;
    const endpoint = path.slice(prefix.length);
    const sdk = /^\/sdk\/(android\/sifric-maps\.aar|ios\/sifric-maps\.zip)$/u.exec(endpoint)?.[1];
    if (sdk) {
      if (request.method !== 'GET') return result({ error: 'Use GET.' }, 405);
      const artifact = await env.TILES_BUCKET.get('lkmaps/sdk/v1/' + sdk);
      if (!artifact) return result({ error: 'The SDK package is unavailable.' }, 404);
      return new Response(artifact.body, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    if (endpoint === '/address/validate') {
      if (request.method !== 'POST') return result({ error: 'Use POST.' }, 405);
      try {
        return result(validateAddress(await routePayload(request)));
      } catch (error) {
        if (error instanceof RoutingError) return result({ error: error.message }, error.status);
        throw error;
      }
    }
    if (endpoint === '/geolocate') {
      if (request.method !== 'POST') return result({ error: 'Use POST.' }, 405);
      try {
        return result(await locateByCell(env.TILES_BUCKET, await routePayload(request)));
      } catch (error) {
        if (error instanceof RoutingError) return result({ error: error.message }, error.status);
        return result({ error: 'The cellular index is unavailable.' }, 502);
      }
    }
    if (!env.SIFRIC_PLATFORM_ORIGIN && ['/routes', '/matrix', '/roads/match', '/optimize'].includes(endpoint)) {
      if (request.method !== 'POST') return result({ error: 'Use POST.' }, 405);
      try {
        const payload = await routePayload(request);
        if (endpoint === '/optimize') return result(await optimizeFleet(env.TILES_BUCKET, payload));
        return result(await routingRequest(env.TILES_BUCKET, endpoint.split('/').at(-1), payload));
      } catch (error) {
        if (error instanceof RoutingError) return result({ error: error.message }, error.status);
        console.warn('Routing request failed', { operation: endpoint, reason: error?.message?.slice(0, 120) });
        return result({ error: 'The Sifric routing graph is unavailable.' }, 502);
      }
    }
    const tile = /^\/tiles\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})\.pbf$/u.exec(endpoint);
    const id = /^\/places\/(\d{1,16})$/u.exec(endpoint)?.[1];
    const photoId = /^\/places\/(\d{1,16})\/photos$/u.exec(endpoint)?.[1];
    const isNearestRoad = endpoint === '/roads/nearest' && request.method === 'GET';
    const isGeocode = !env.SIFRIC_PLATFORM_ORIGIN && ['/geocode','/geocode/reverse'].includes(endpoint);
    if (!tile && !id && !photoId && !isGeocode && !isNearestRoad && !['/health','/capabilities','/timezone','/elevation','/bathymetry','/places/search','/places/nearby','/static-map'].includes(endpoint)) return null;
    if (request.method !== 'GET') return result({ error: 'Use GET.' }, 405);
    const { origin, searchParams: query } = new URL(request.url);
    try {
      if (endpoint === '/health') return result({ status: 'ok', runtime: 'cloudflare-workers' });
      if (endpoint === '/capabilities') {
        const routingModes = await availableRoutingModes(env.TILES_BUCKET);
        return result({
          region: 'LK', search: 'indexed places', geocoding: env.SIFRIC_PLATFORM_ORIGIN ? 'configured service' : 'indexed-place lookup',
          routing: env.SIFRIC_PLATFORM_ORIGIN ? 'configured service' : routingModes.length ? 'Sifric routing graph' : null,
          routingModes, vectorTiles: true, nearestRoad: 'basemap centerlines', traceMatching: routingModes.length > 0,
          fleetOptimization: routingModes.includes('drive'), addressValidation: 'Sri Lanka postal towns', elevation: 'Mapzen Terrarium',
          staticMap: Boolean(env.MAP_BROWSER), liveTraffic: false,
        });
      }
      if (tile) {
        const [z, x, y] = tile.slice(1).map(Number);
        if (z > 24 || x >= 2 ** z || y >= 2 ** z) return result({ error: 'Tile not found.' }, 404);
        const archive = vectorArchive(env.TILES_BUCKET, tileKey);
        const info = await archive.getHeader();
        if (info.tileType !== TileType.Mvt) throw new Error('The archive does not contain vector tiles.');
        const data = await archive.getZxy(z, x, y);
        if (!data) return result({ error: 'Tile not found.' }, 404);
        return new Response(data.data, { headers: { 'Content-Type': 'application/vnd.mapbox-vector-tile' } });
      }
      if (id) {
        const key = number(id, 'place ID', 1, Number.MAX_SAFE_INTEGER);
        const row = (await shard(env, origin, 'id/' + (key % 512))).find(row => row[0] === key);
        return row ? result(place(row)) : result({ error: 'Place not found.' }, 404);
      }
      if (photoId) {
        const key = number(photoId, 'place ID', 1, Number.MAX_SAFE_INTEGER);
        const row = (await shard(env, origin, 'id/' + (key % 512))).find(row => row[0] === key);
        if (!row) return result({ error: 'Place not found.' }, 404);
        const object = await env.TILES_BUCKET.get('lkmaps/places/v1/photos.json');
        if (!object || object.size > 1024 ** 2) return result({ error: 'The place photo catalog is unavailable.' }, 503);
        const catalog = await object.json();
        return result({ items: catalog[key] ?? [] });
      }
      if (endpoint === '/places/search' || endpoint === '/geocode') {
        const q = normalize(query.get('q') ?? '');
        if (q.length < 2 || q.length > 120 || [...q.split(/\s+/u)[0]].length < 2) {
          throw new Invalid('Start the search with at least two characters.');
        }
        const limit = Math.floor(number(query.get('limit') ?? 10, 'limit', 1, 50));
        const terms = q.split(/\s+/u);
        const prefix = [...terms[0]].slice(0, 2).join('');
        const key = [...new TextEncoder().encode(prefix)].map(b => b.toString(16).padStart(2, '0')).join('');
        const rows = await shard(env, origin, 'search/' + key);
        const primary = [], secondary = [];
        for (const row of rows) {
          const name = normalize(row[1]);
          const text = name + ' ' + normalize(row[6] ?? '');
          if (!terms.every(term => text.includes(term))) continue;
          const matches = name.startsWith(q) ? primary : secondary;
          if (matches.length < limit) matches.push(place(row));
          if (primary.length >= limit) break;
        }
        return result({ items: primary.concat(secondary).slice(0, limit), precision: 'indexed-place' });
      }
      const [lon, lat] = coords(query);
      if (isNearestRoad) {
        const radius = number(query.get('radius') ?? 75, 'radius', 1, 150);
        const nearest = await nearestRoad(vectorArchive(env.TILES_BUCKET, tileKey), lon, lat, radius);
        return nearest ? result({ ...nearest, source: 'Sifric vector basemap' }) :
          result({ error: 'No road centerline was found within the search radius.' }, 404);
      }
      if (endpoint === '/static-map') {
        const zoom = number(query.get('zoom') ?? 13, 'zoom', 0, 20);
        const width = number(query.get('width') ?? 640, 'width', 128, 1280);
        const height = number(query.get('height') ?? 480, 'height', 128, 1280);
        const theme = query.get('theme') ?? 'light';
        const pin = query.get('pin') ?? '0';
        if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Invalid('Use whole pixel dimensions.');
        if (!['light', 'dark'].includes(theme) || !['0', '1'].includes(pin)) throw new Invalid('Use light or dark theme and pin=0 or pin=1.');
        if (!env.MAP_BROWSER || !renderStaticMap) return result({ error: 'Static rendering is unavailable.' }, 503);
        const image = await renderStaticMap(env.MAP_BROWSER, request, { lon, lat, zoom, width, height, pin, theme });
        return new Response(image, { headers: { 'Content-Type': 'image/png' } });
      }
      if (endpoint === '/elevation') {
        const sample = await terrarium(lon, lat);
        return sample ? result(sample) : result({ error: 'No elevation sample available.' }, 404);
      }
      if (endpoint === '/bathymetry') {
        const sample = await sampleRelief(env.TILES_BUCKET, lon, lat);
        if (sample === undefined) return result({ error: 'No relief grid has been deployed.' }, 503);
        if (!sample) return result({ error: 'No relief sample is available.' }, 404);
        return result(sample);
      }
      if (endpoint === '/timezone') {
        const timestamp = query.get('timestamp');
        if (timestamp != null && !/(Z|[+-]\d{2}:\d{2})$/u.test(timestamp)) throw new Invalid('Specify an ISO timestamp with a UTC offset.');
        const date = timestamp == null ? new Date() : new Date(timestamp);
        if (!Number.isFinite(date.valueOf())) throw new Invalid('Invalid timestamp.');
        const offset = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Colombo', timeZoneName: 'longOffset' })
          .formatToParts(date).find(part => part.type === 'timeZoneName').value.replace('GMT','');
        return result({ timeZone: 'Asia/Colombo', offset: offset || '+00:00', timestamp: date.toISOString(), coverage: 'Sri Lanka bounding box' });
      }
      const radius = number(query.get('radius') ?? 2000, 'radius', 1, 5000);
      const limit = endpoint === '/geocode/reverse' ? 1 : Math.floor(number(query.get('limit') ?? 10, 'limit', 1, 50));
      const latSpan = radius / 110000, lonSpan = latSpan / Math.cos(lat * Math.PI / 180);
      const cells = [];
      for (let x = Math.floor((lon-lonSpan)*10); x <= Math.floor((lon+lonSpan)*10); x++) {
        for (let y = Math.floor((lat-latSpan)*10); y <= Math.floor((lat+latSpan)*10); y++) {
          cells.push(shard(env, origin, `near/${x}-${y}`));
        }
      }
      const items = [];
      for (const rows of await Promise.all(cells)) {
        for (const row of rows) {
          const meters = distance(lon, lat, row[2], row[3]);
          if (meters <= radius) items.push({ ...place(row), distanceMeters: Math.round(meters) });
        }
      }
      items.sort((a, b) => a.distanceMeters - b.distanceMeters || a.id - b.id);
      return result({ items: items.slice(0, limit), precision: 'indexed-place' });
    } catch (error) {
      if (error instanceof Invalid) return result({ error: error.message }, 400);
      if (endpoint === '/elevation' || endpoint === '/static-map') {
        console.warn('Map data request failed', { endpoint, reason: error?.message?.slice(0, 200) });
      }
      return result({ error: 'The Sifric data source is unavailable.' }, 502);
    }
  };
}
