import { sampleElevation } from './elevation.mjs';

const modes = new Map([
  ['drive', 'DRIVE'], ['van', 'VAN'], ['tuk', 'TUK'],
  ['walk', 'WALK'], ['cycle', 'CYCLE'], ['motorcycle', 'MOTORCYCLE'],
]);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (value, status = 200) => Response.json(value, {
  status,
  headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
});

function number(value, label, min, max) {
  if (value == null || String(value).trim() === '' || !['string', 'number'].includes(typeof value)) {
    throw new ApiError(400, `Specify ${label}.`);
  }
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value.trim())) throw new ApiError(400, `Invalid ${label}.`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new ApiError(400, `Invalid ${label}.`);
  }
  return result;
}

function point(value) {
  if (!Array.isArray(value) || value.length !== 2 || value.some(n => typeof n !== 'number')) {
    throw new ApiError(400, 'A point must be [longitude, latitude].');
  }
  return [number(value[0], 'longitude', 78, 82.5), number(value[1], 'latitude', 5, 10.5)];
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'A JSON object is required.');
  const decoder = new TextDecoder();
  let size = 0, body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new ApiError(413, 'Request body exceeds 64 KiB.');
      }
      body += decoder.decode(value, { stream: true });
    }
    const result = JSON.parse(body + decoder.decode());
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'A JSON object is required.');
  } finally {
    reader.releaseLock();
  }
}

async function routeEngine(operation, body, env) {
  const mode = body.mode ?? 'drive';
  if (!modes.has(mode)) throw new ApiError(400, 'Unsupported travel mode.');
  const origin = env[`SIFRIC_OSRM_${modes.get(mode)}_URL`];
  if (!origin) throw new ApiError(503, 'No routing graph is configured for this travel mode.');
  const points = body.coordinates;
  const minPoints = operation === 'nearest' ? 1 : 2;
  const maxPoints = operation === 'nearest' ? 1 : 25;
  if (!Array.isArray(points) || points.length < minPoints || points.length > maxPoints) {
    throw new ApiError(400, operation === 'nearest' ? 'Supply exactly one coordinate.' : 'Supply 2 to 25 coordinates.');
  }
  const endpoint = new URL(origin);
  const coordinates = points.map(point).map(pair => pair.join(',')).join(';');
  // The mounted OSRM instance determines the actual profile.
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/${operation}/v1/driving/${coordinates}`;
  endpoint.search = '';
  if (operation === 'route' || operation === 'match') {
    endpoint.searchParams.set('geometries', 'geojson');
    endpoint.searchParams.set('overview', 'full');
    endpoint.searchParams.set('steps', 'true');
  }
  if (operation === 'table') {
    endpoint.searchParams.set('annotations', 'duration,distance');
    for (const field of ['sources', 'destinations']) {
      if (body[field] === undefined) continue;
      if (!Array.isArray(body[field]) || !body[field].length || body[field].length > points.length ||
          body[field].some(index => !Number.isInteger(index) || index < 0 || index >= points.length)) {
        throw new ApiError(400, `Invalid ${field} coordinate indices.`);
      }
      endpoint.searchParams.set(field, body[field].join(';'));
    }
  }
  let payload;
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok && response.status !== 400) throw new Error();
    payload = await response.json();
  } catch {
    throw new ApiError(502, 'Routing engine unavailable.');
  }
  if (payload?.code !== 'Ok') throw new ApiError(422, 'The routing graph could not resolve these coordinates.');
  return { ...payload, mode, traffic: 'none' };
}

async function upstreamJson(endpoint, options = {}) {
  try {
    const response = await fetch(endpoint, { ...options, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch {
    throw new ApiError(502, 'Configured service unavailable.');
  }
}

async function optimize(request, env) {
  if (!env.SIFRIC_VROOM_URL) throw new ApiError(503, 'No fleet optimizer is configured.');
  const { vehicles, jobs, shipments } = await readBody(request);
  if (!Array.isArray(vehicles) || !vehicles.length || vehicles.length > 20 ||
      (jobs !== undefined && !Array.isArray(jobs)) || (shipments !== undefined && !Array.isArray(shipments)) ||
      (jobs?.length ?? 0) + (shipments?.length ?? 0) > 75 || !(jobs?.length || shipments?.length)) {
    throw new ApiError(400, 'Supply 1 to 20 vehicles and 1 to 75 jobs or shipments.');
  }
  for (const vehicle of vehicles) {
    if (!vehicle || (!vehicle.start && !vehicle.end)) throw new ApiError(400, 'Each vehicle requires a start or end.');
    if (vehicle.start) point(vehicle.start);
    if (vehicle.end) point(vehicle.end);
    if (vehicle.profile != null && !modes.has(vehicle.profile)) throw new ApiError(400, 'Invalid vehicle profile.');
  }
  for (const job of jobs ?? []) point(job?.location);
  for (const shipment of shipments ?? []) {
    point(shipment?.pickup?.location);
    point(shipment?.delivery?.location);
  }
  const result = await upstreamJson(env.SIFRIC_VROOM_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vehicles, jobs, shipments }),
  });
  if (result?.code !== 0) throw new ApiError(422, 'The optimizer could not plan these jobs.');
  return result;
}

async function geocode(origin, parameters, reverse = false) {
  const url = new URL(origin);
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/${reverse ? 'reverse' : 'search'}`;
  url.search = new URLSearchParams({ ...parameters, format: 'jsonv2', addressdetails: '1' });
  const data = await upstreamJson(url);
  if (reverse && data?.error) return [];
  const results = reverse ? [data] : data;
  if (!Array.isArray(results)) throw new ApiError(502, 'Invalid geocoding response.');
  return results.map(place => ({
    name: place.display_name, lon: Number(place.lon), lat: Number(place.lat), address: place.address,
  })).filter(place => typeof place.name === 'string' && Number.isFinite(place.lon) && Number.isFinite(place.lat));
}

export async function handleApi(request, places, env = process.env, staticRenderer, tiles) {
  const { pathname, searchParams: q } = new URL(request.url);
  const routes = new Map([['/routes', 'route'], ['/matrix', 'table'], ['/roads/match', 'match'], ['/roads/nearest', 'nearest']]);
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      } });
    }
    const path = pathname.slice('/api/v1'.length);
    if (path === '/optimize') {
      if (request.method !== 'POST') throw new ApiError(405, 'Use POST.');
      return json(await optimize(request, env));
    }
    if (routes.has(path)) {
      if (request.method !== 'POST') throw new ApiError(405, 'Use POST.');
      return json(await routeEngine(routes.get(path), await readBody(request), env));
    }
    if (request.method !== 'GET') throw new ApiError(405, 'Use GET.');
    if (path === '/health') return json({ status: 'ok' });
    if (path === '/capabilities') {
      return json({ region: 'LK', routingModes: [...modes].filter(([, key]) => env[`SIFRIC_OSRM_${key}_URL`]).map(([mode]) => mode), search: 'place names and labels', reverse: env.SIFRIC_NOMINATIM_URL ? 'Nominatim' : 'nearest indexed place', fleetOptimization: Boolean(env.SIFRIC_VROOM_URL), staticMap: Boolean(staticRenderer), vectorTiles: Boolean(tiles), elevation: env.SIFRIC_ELEVATION_DIR ? 'configured SRTM tiles' : null, liveTraffic: false });
    }
    const tileCoordinates = /^\/tiles\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})\.pbf$/u.exec(path);
    if (tileCoordinates) {
      if (!tiles) throw new ApiError(503, 'No tile archive is configured.');
      const tile = await tiles.read(...tileCoordinates.slice(1).map(Number));
      if (!tile) throw new ApiError(404, 'Tile not found.');
      return new Response(tile, { headers: { 'Content-Type': 'application/vnd.mapbox-vector-tile', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' } });
    }
    if (path === '/static-map') {
      if (!staticRenderer) throw new ApiError(503, 'No static map renderer is configured.');
      const [lon, lat] = point([number(q.get('lon'), 'longitude', 78, 82.5), number(q.get('lat'), 'latitude', 5, 10.5)]);
      const zoom = number(q.get('zoom') ?? 12, 'zoom', 0, 20);
      const width = Math.floor(number(q.get('width') ?? 640, 'width', 160, 1280));
      const height = Math.floor(number(q.get('height') ?? 480, 'height', 120, 960));
      let png;
      try {
        png = await staticRenderer({ lon, lat, zoom, width, height, pin: q.get('pin') === '1' });
      } catch {
        throw new ApiError(502, 'Could not render the Sifric map.');
      }
      if (!png) throw new ApiError(429, 'The static map renderer is busy.');
      return new Response(png, { headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    }
    const id = /^\/places\/(\d+)$/u.exec(path)?.[1];
    if (id) {
      const place = places.details(number(id, 'place ID', 0, Number.MAX_SAFE_INTEGER));
      if (!place) throw new ApiError(404, 'Place not found.');
      return json(place);
    }
    if (['/timezone', '/places/nearby', '/geocode/reverse', '/elevation'].includes(path)) {
      const lon = number(q.get('lon'), 'longitude', 78, 82.5);
      const lat = number(q.get('lat'), 'latitude', 5, 10.5);
      if (path === '/elevation') {
        if (!env.SIFRIC_ELEVATION_DIR) throw new ApiError(503, 'No elevation dataset is configured.');
        const sample = await sampleElevation(env.SIFRIC_ELEVATION_DIR, lon, lat);
        if (!sample) throw new ApiError(404, 'No elevation sample is available.');
        return json(sample);
      }
      if (path === '/timezone') {
        const raw = q.get('timestamp');
        if (raw && !/(Z|[+-]\d{2}:\d{2})$/u.test(raw)) throw new ApiError(400, 'Specify a timestamp with a UTC offset.');
        const date = raw ? new Date(raw) : new Date();
        if (!Number.isFinite(date.valueOf())) throw new ApiError(400, 'Invalid timestamp.');
        const offset = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Colombo', timeZoneName: 'longOffset' })
          .formatToParts(date).find(part => part.type === 'timeZoneName').value.replace('GMT', '');
        return json({ timeZone: 'Asia/Colombo', offset: offset || '+00:00', timestamp: date.toISOString(), coverage: 'Sri Lanka bounding box' });
      }
      if (path === '/geocode/reverse' && env.SIFRIC_NOMINATIM_URL) {
        return json({ items: await geocode(env.SIFRIC_NOMINATIM_URL, { lon, lat }, true), source: 'Nominatim' });
      }
      const radius = number(q.get('radius') ?? 2000, 'radius', 1, 25000);
      const limit = path === '/geocode/reverse' ? 1 : Math.floor(number(q.get('limit') ?? 10, 'limit', 1, 50));
      return json({ items: places.nearby(lon, lat, radius, limit), precision: 'indexed-place' });
    }
    if (['/places/search', '/geocode'].includes(path)) {
      const query = q.get('q')?.trim();
      if (!query || query.length < 2 || query.length > 120) throw new ApiError(400, 'Search requires 2 to 120 characters.');
      const limit = Math.floor(number(q.get('limit') ?? 10, 'limit', 1, 50));
      if (path === '/geocode' && env.SIFRIC_NOMINATIM_URL) {
        return json({ items: await geocode(env.SIFRIC_NOMINATIM_URL, { q: query, countrycodes: 'lk', limit }), source: 'Nominatim' });
      }
      return json({ items: places.search(query, limit), precision: 'indexed-place' });
    }
    throw new ApiError(404, 'Endpoint not found.');
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error('Sifric platform request failed:', error.message);
    return json({ error: 'Internal server error.' }, 500);
  }
}
