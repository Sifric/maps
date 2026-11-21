import { RoutingError } from './routing.mjs';

const key = 'lkmaps/geolocation/v1/lk-2026-10-06.bin';
const radios = new Map([['gsm', 1], ['wcdma', 2], ['umts', 2], ['lte', 3], ['nr', 4]]);
const recordBytes = 32;

function integer(value, max, label) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RoutingError(400, 'Invalid ' + label + '.');
  }
  return value;
}

function observations(body) {
  if (!Array.isArray(body.cellTowers) || body.cellTowers.length < 1 || body.cellTowers.length > 8) {
    throw new RoutingError(400, 'Supply between one and eight cellular observations.');
  }
  const records = new Map();
  for (const tower of body.cellTowers) {
    const radio = radios.get(tower?.radioType ?? body.radioType);
    if (tower?.mobileCountryCode !== 413 || !radio) {
      throw new RoutingError(400, 'Use Sri Lanka MCC 413 and a supported radio type: gsm, wcdma, lte, or nr.');
    }
    const record = [
      radio,
      integer(tower.mobileNetworkCode, 999, 'mobile network code'),
      integer(tower.locationAreaCode, 2 ** 24 - 1, 'location area or tracking area code'),
      integer(tower.cellId ?? tower.newRadioCellId, radio === 4 ? 2 ** 36 - 1 : 2 ** 32 - 1, 'cell ID'),
    ];
    records.set(record.join(':'), record);
  }
  return [...records.values()];
}

function find(view, count, record) {
  let left = 0, right = count;
  while (left < right) {
    const i = (left + right) >>> 1;
    const offset = 12 + i * recordBytes;
    const cmp = view.getUint16(offset, true) - record[0] ||
      view.getUint16(offset + 2, true) - record[1] ||
      view.getUint32(offset + 4, true) - record[2] ||
      Number(view.getBigUint64(offset + 8, true)) - record[3];
    if (cmp < 0) left = i + 1;
    else if (cmp > 0) right = i;
    else {
      const range = view.getUint32(offset + 24, true);
      return {
        longitude: view.getFloat32(offset + 16, true),
        latitude: view.getFloat32(offset + 20, true),
        radius: Math.min(100_000, Math.max(500, range || 5000)),
      };
    }
  }
  return null;
}

function separation(a, b) {
  const longitudeScale = Math.cos((a.latitude + b.latitude) * Math.PI / 360);
  return 111195 * Math.hypot((a.longitude - b.longitude) * longitudeScale, a.latitude - b.latitude);
}

export async function locateByCell(bucket, body) {
  const keys = observations(body);
  const object = await bucket.get(key);
  if (!object || object.size > 4 * 1024 ** 2) throw new RoutingError(503, 'The Sri Lanka cellular index is unavailable.');
  const buffer = await object.arrayBuffer();
  const view = new DataView(buffer);
  if (view.byteLength < 12 || new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== 'SIFRICC1') {
    throw new Error('Invalid cellular index.');
  }
  const count = view.getUint32(8, true);
  if (12 + count * recordBytes !== view.byteLength) throw new Error('Invalid cellular index size.');
  const matches = keys.map(record => find(view, count, record)).filter(Boolean);
  if (!matches.length) throw new RoutingError(404, 'No observed cell was found in the Sri Lanka index.');
  matches.sort((a, b) => a.radius - b.radius);
  let cluster = [];
  for (const anchor of matches) {
    const nearby = matches.filter(point => separation(point, anchor) <= point.radius + anchor.radius);
    if (nearby.length > cluster.length) cluster = nearby;
  }
  const reference = cluster[0];
  let weight = 0, longitude = 0, latitude = 0;
  for (const match of cluster) {
    const value = 1 / match.radius;
    weight += value;
    longitude += (match.longitude - reference.longitude) * value;
    latitude += (match.latitude - reference.latitude) * value;
  }
  const location = { longitude: reference.longitude + longitude / weight, latitude: reference.latitude + latitude / weight };
  const radius = Math.max(...cluster.map(cell => separation(location, cell) + cell.radius));
  return {
    location,
    estimatedCoverageMeters: Math.ceil(radius),
    matchedCells: matches.length,
    cellsUsed: cluster.length,
    method: 'cellular observations',
    source: 'OpenCellID snapshot 2026-10-06',
    sourceUrl: 'https://opencellid.org/',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  };
}
