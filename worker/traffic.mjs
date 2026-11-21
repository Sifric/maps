import { RoutingError } from './routing.mjs';

export const trafficKey = 'lkmaps/traffic/v1/current.json';
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) &&
  p[0] >= 78 && p[0] <= 82.5 && p[1] >= 5 && p[1] <= 10.5;

export function validateTraffic(snapshot, now = Date.now()) {
  const time = Date.parse(snapshot?.observedAt);
  if (!Number.isFinite(time) || time > now + 60_000 || now - time > 15 * 60_000 ||
      typeof snapshot.source !== 'string' || !snapshot.source.trim() || snapshot.source.length > 120 ||
      !Array.isArray(snapshot.segments) || !snapshot.segments.length || snapshot.segments.length > 32 ||
      snapshot.segments.some(s => !point(s?.from) || !point(s?.to) ||
        typeof s.closed !== 'boolean' || !Number.isFinite(s.factor) || s.factor < 1 || s.factor > 10)) return null;
  return snapshot;
}

export async function trafficSnapshot(bucket) {
  const object = await bucket.get(trafficKey);
  return object && object.size <= 32000 ? validateTraffic(await object.json()) : null;
}

function meters(a, b) {
  return Math.hypot((a[0] - b[0]) * Math.cos((a[1] + b[1]) * Math.PI / 360), a[1] - b[1]) * 111195;
}

function spans(coordinates, segments) {
  let traveled = 0;
  const path = [];
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1], b = coordinates[i];
    const length = meters(a, b);
    if (!length) continue;
    path.push({ a, b, length, start: traveled });
    traveled += length;
  }
  const hits = [];
  for (const [index, segment] of segments.entries()) {
    const lonScale = 111195 * Math.cos(segment.from[1] * Math.PI / 180);
    const dx = (segment.to[0] - segment.from[0]) * lonScale;
    const dy = (segment.to[1] - segment.from[1]) * 111195;
    const span = Math.hypot(dx, dy);
    if (span < 30) continue;
    function axes(point) {
      const x = (point[0] - segment.from[0]) * lonScale;
      const y = (point[1] - segment.from[1]) * 111195;
      return [(x * dx + y * dy) / span, (y * dx - x * dy) / span];
    }
    let last;
    for (const edge of path) {
      const [from, offset] = axes(edge.a);
      const [to, endOffset] = axes(edge.b);
      const advance = to - from;
      // Exclude opposing traffic and roads that cross the observation.
      if (advance < edge.length * 0.87 || to <= 0 || from >= span) continue;
      let low = Math.max(0, -from / advance);
      let high = Math.min(1, (span - from) / advance);
      const cross = endOffset - offset;
      if (cross === 0) {
        if (Math.abs(offset) > 20) continue;
      } else {
        const before = (-20 - offset) / cross, after = (20 - offset) / cross;
        low = Math.max(low, Math.min(before, after));
        high = Math.min(high, Math.max(before, after));
      }
      if (high <= low) continue;
      const start = edge.start + low * edge.length, end = edge.start + high * edge.length;
      if (last && start <= last.end + 0.01) last.end = end;
      else {
        last = { start, end, factor: segment.factor, closed: segment.closed, index };
        hits.push(last);
      }
    }
  }
  return { hits: hits.filter(hit => hit.end - hit.start >= 10), traveled };
}

export async function annotateTraffic(bucket, response, observation, bestOnly = false) {
  if (!response.ok) return response;
  const route = await response.json();
  const snapshot = observation === undefined ? await trafficSnapshot(bucket) : observation;
  if (!snapshot) return Response.json({ ...route, liveTraffic: { status: 'unavailable' } });
  const description = { source: snapshot.source, observedAt: snapshot.observedAt };
  let observed = false;
  const usable = [];
  for (const variant of route.routes ?? []) {
    const { hits, traveled } = spans(variant.geometry.coordinates, snapshot.segments);
    if (hits.some(span => span.closed)) continue;
    usable.push(variant);
    if (!hits.length) continue;
    observed = true;
    const boundaries = hits.flatMap(({ start, end, factor }) =>
      [{ at: start, factor, delta: 1 }, { at: end, factor, delta: -1 }]).sort((a, b) => a.at - b.at);
    const active = new Map();
    let added = 0;
    let previous = 0;
    for (const { at, factor, delta } of boundaries) {
      added += (at - previous) * (Math.max(1, ...active.keys()) - 1);
      const count = (active.get(factor) ?? 0) + delta;
      if (count) active.set(factor, count);
      else active.delete(factor);
      previous = at;
    }
    variant.trafficDuration = Math.round(variant.duration * (1 + (traveled ? added / traveled : 0)));
    variant.matchedTrafficSegments = new Set(hits.map(hit => hit.index)).size;
  }
  if (!usable.length && route.routes?.length) {
    throw new RoutingError(409, 'An observed closure intersects every available route.');
  }
  usable.sort((a, b) => (a.trafficDuration ?? a.duration) - (b.trafficDuration ?? b.duration));
  return Response.json({
    ...route, routes: bestOnly ? usable.slice(0, 1) : usable,
    liveTraffic: { ...description, status: observed ? 'observed-segments' : 'outside-coverage' },
  });
}
