import { RoutingError } from './routing.mjs';

export const transitKey = 'lkmaps/transit/v1/lmt.json';
const offset = 19800;
const dayLength = 86400;
const walkSpeed = 1.25;
const horizon = 6 * 3600;

function distance(a, b) {
  return 111195 * Math.hypot((a[0] - b[0]) * Math.cos((a[1] + b[1]) * Math.PI / 360), a[1] - b[1]);
}

export async function transitRoute(bucket, body) {
  const points = body.coordinates;
  if (!Array.isArray(points) || points.length !== 2 || points.some(p => !Array.isArray(p) ||
      p.length !== 2 || !p.every(Number.isFinite) || p[0] < 78 || p[0] > 82.5 || p[1] < 5 || p[1] > 10.5)) {
    throw new RoutingError(400, 'Provide origin and destination as Sri Lanka longitude/latitude pairs.');
  }
  const raw = body.departureTime;
  if (raw !== undefined && (typeof raw !== 'string' || raw.length > 40 || !/(Z|[+-]\d{2}:\d{2})$/u.test(raw))) {
    throw new RoutingError(400, 'Use an ISO departure time with an offset.');
  }
  const start = raw === undefined ? Math.floor(Date.now() / 1000) : Math.floor(Date.parse(raw) / 1000);
  if (!Number.isFinite(start)) throw new RoutingError(400, 'Invalid departure time.');
  const file = await bucket.get(transitKey);
  if (!file || file.size > 2_000_000) throw new RoutingError(503, 'Transit schedules are not available.');
  const { agency, source, stops, routes, days } = await file.json();
  const localDay = Math.floor((start + offset) / dayLength) * dayLength;
  const service = [];
  for (const delta of [-1, 0, 1]) {
    const day = localDay + dayLength * delta;
    const key = new Date(day * 1000).toISOString().slice(0, 10);
    for (const edge of days[key] ?? []) {
      if (day - offset + edge[0] >= start && day - offset + edge[1] <= start + horizon) {
        service.push({ edge, base: day - offset });
      }
    }
  }
  if (!service.length) throw new RoutingError(404, 'No scheduled service is available for this departure window.');
  service.sort((a, b) => a.base + a.edge[0] - b.base - b.edge[0]);
  const arrivals = new Map(), boarded = new Map(), exits = new Map();
  for (const [i, [name, lon, lat]] of stops.entries()) {
    const from = distance(points[0], [lon, lat]);
    const to = distance(points[1], [lon, lat]);
    if (from <= 1200) arrivals.set(i, { time: start + Math.ceil(from / walkSpeed), stop: name, origin: true, distance: Math.round(from) });
    if (to <= 1200) exits.set(i, Math.ceil(to / walkSpeed));
  }
  let best;
  for (const { edge, base } of service) {
    const [departure, arrival, from, to, tripId, routeId, pickup, dropoff] = edge;
    const trip = base + ':' + tripId;
    const previous = arrivals.get(from);
    const ready = previous && previous.time + (previous.origin ? 0 : 120) <= base + departure;
    const ride = boarded.get(trip) ?? (pickup && ready ? { previous, from, departure: base + departure } : null);
    if (!ride) continue;
    boarded.set(trip, ride);
    if (!dropoff) continue;
    const end = { ride, routeId, trip, to, time: base + arrival };
    if (!arrivals.has(to) || end.time < arrivals.get(to).time) arrivals.set(to, end);
    const exit = exits.get(to);
    if (exit !== undefined && (!best || end.time + exit < best.arrival)) best = { arrival: end.time + exit, end, exit };
  }
  if (!best) throw new RoutingError(404, 'No transit journey connects these coordinates in the available schedules.');
  const stamp = value => new Date(value * 1000).toISOString();
  const legs = [];
  let last = best.end;
  while (!last.origin) {
    const [shortName, name, type] = routes[last.routeId];
    legs.push({ type: 'transit', vehicleType: type, route: shortName, name,
      from: stops[last.ride.from][0], to: stops[last.to][0],
      departureTime: stamp(last.ride.departure), arrivalTime: stamp(last.time) });
    last = last.ride.previous;
  }
  return { agency, source, timing: 'published-schedule', transferSeconds: 120,
    departureTime: stamp(start), arrivalTime: stamp(best.arrival),
    accessWalk: { stop: last.stop, distanceMeters: last.distance, estimate: 'straight-line' },
    egressWalk: { stop: stops[best.end.to][0], durationSeconds: best.exit, estimate: 'straight-line' },
    legs: legs.reverse() };
}
