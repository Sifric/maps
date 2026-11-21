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
  const matched = segments.map(segment => ({ segment, from: null, to: null }));
  let traveled = 0;
  for (let i = 0; i < coordinates.length; i++) {
    if (i) traveled += meters(coordinates[i - 1], coordinates[i]);
    for (const item of matched) {
      for (const end of ['from', 'to']) {
        const distance = meters(coordinates[i], item.segment[end]);
        if (distance < (item[end]?.distance ?? 40)) item[end] = { distance, traveled };
      }
    }
  }
  const hits = [];
  for (const item of matched) {
    if (!item.from || !item.to) continue;
    const start = item.from.traveled, end = item.to.traveled;
    const length = meters(item.segment.from, item.segment.to);
    if (end - start < 30 || end - start > length * 2.5 + 60) continue;
    hits.push({ start, end, factor: item.segment.factor, closed: item.segment.closed });
  }
  return { hits, traveled };
}

export async function annotateTraffic(bucket, response) {
  if (!response.ok) return response;
  const route = await response.json();
  const snapshot = await trafficSnapshot(bucket);
  if (!snapshot) return Response.json({ ...route, liveTraffic: { status: 'unavailable' } });
  const description = { source: snapshot.source, observedAt: snapshot.observedAt };
  for (const variant of route.routes ?? []) {
    const { hits, traveled } = spans(variant.geometry.coordinates, snapshot.segments);
    if (hits.some(span => span.closed)) {
      throw new RoutingError(409, 'An observed closure intersects this route. A traffic-safe alternative is unavailable.');
    }
    const boundaries = [...new Set(hits.flatMap(span => [span.start, span.end]))].sort((a, b) => a - b);
    let added = 0;
    for (let i = 1; i < boundaries.length; i++) {
      const low = boundaries[i - 1], high = boundaries[i];
      const factor = hits.reduce((max, span) => span.start <= low && span.end >= high ? Math.max(max, span.factor) : max, 1);
      added += (high - low) * (factor - 1);
    }
    variant.trafficDuration = Math.round(variant.duration * (1 + (traveled ? added / traveled : 0)));
    variant.matchedTrafficSegments = hits.length;
  }
  return Response.json({ ...route, liveTraffic: { ...description, status: 'observed-segments' } });
}
