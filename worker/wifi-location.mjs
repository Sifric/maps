import { RoutingError } from './routing.mjs';

const key = 'lkmaps/geolocation/v1/wifi.json';
const digest = async key => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))),
  byte => byte.toString(16).padStart(2, '0')).join('');

export function normalizeMac(value) {
  if (typeof value !== 'string' || !/^(?:[\da-f]{2}:){5}[\da-f]{2}$/iu.test(value)) return null;
  const mac = value.toLowerCase();
  return (Number.parseInt(mac.slice(0, 2), 16) & 3) === 0 && mac !== '00:00:00:00:00:00' ? mac : null;
}

export async function locateByWifi(bucket, accessPoints) {
  if (!Array.isArray(accessPoints) || accessPoints.length < 3 || accessPoints.length > 30) {
    throw new RoutingError(400, 'Supply 3 to 30 Wi-Fi access point observations.');
  }
  const macs = [...new Set(accessPoints.map(point => normalizeMac(point?.macAddress)).filter(Boolean))];
  if (macs.length < 3) throw new RoutingError(400, 'Supply at least three distinct globally assigned access point addresses.');
  const object = await bucket.get(key);
  if (!object || object.size > 2_000_000) throw new RoutingError(503, 'An approved Wi-Fi positioning index is not deployed.');
  const index = await object.json();
  const hashes = await Promise.all(macs.map(digest));
  const hits = hashes.map(hash => index[hash]).filter(p => Array.isArray(p) && p.length === 3 &&
    p.every(Number.isFinite) && p[0] >= 78 && p[0] <= 82.5 && p[1] >= 5 && p[1] <= 10.5 && p[2] >= 25 && p[2] <= 500);
  if (hits.length < 3) throw new RoutingError(404, 'Too few Wi-Fi access points matched the approved index.');
  const distance = (a, b) => 111195 * Math.hypot((a[0] - b[0]) * Math.cos(a[1] * Math.PI / 180), a[1] - b[1]);
  const cluster = hits.map(a => hits.filter(b => distance(a, b) <= Math.min(500, a[2] + b[2])))
    .sort((a, b) => b.length - a.length)[0];
  if (cluster.length < 3) throw new RoutingError(404, 'The matched access points do not agree on an area.');
  const total = cluster.reduce((sum, point) => sum + 1 / point[2], 0);
  const center = [0, 1].map(i => cluster.reduce((sum, point) => sum + point[i] / point[2], 0) / total);
  return { location: { longitude: center[0], latitude: center[1] }, method: 'Wi-Fi observations',
    estimatedCoverageMeters: Math.ceil(Math.max(...cluster.map(p => distance(p, center) + p[2]))), matchedAccessPoints: cluster.length };
}
