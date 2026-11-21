import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

const vehicleClasses = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track',
]);
const pathClasses = new Set(['path', 'pedestrian', 'footway', 'steps', 'cycleway', 'bridleway']);
const radians = Math.PI / 180;
const metersPerDegree = 6371008.8 * radians;
const zoom = 14;
const tileCount = 2 ** zoom;
const tileX = lon => Math.floor((lon + 180) / 360 * tileCount);
const tileY = lat => Math.floor((1 - Math.asinh(Math.tan(lat * radians)) / Math.PI) / 2 * tileCount);

export async function nearestRoad(archive, lon, lat, radius) {
  const lonScale = metersPerDegree * Math.cos(lat * radians);
  const lonSpan = radius / lonScale;
  const latSpan = radius / metersPerDegree;
  const tiles = [];
  for (let x = tileX(lon - lonSpan); x <= tileX(lon + lonSpan); x++) {
    for (let y = tileY(lat + latSpan); y <= tileY(lat - latSpan); y++) {
      tiles.push(archive.getZxy(zoom, x, y).then(tile => ({ x, y, tile })));
    }
  }
  let nearest = null;
  let best = radius ** 2;
  for (const { x, y, tile } of await Promise.all(tiles)) {
    if (!tile) continue;
    const { transportation } = new VectorTile(new PbfReader(new Uint8Array(tile.data))).layers;
    if (!transportation) continue;
    for (let index = 0; index < transportation.length; index++) {
      const feature = transportation.feature(index);
      const roadClass = feature.properties.class;
      if (feature.type !== 2 || !(vehicleClasses.has(roadClass) || pathClasses.has(roadClass))) continue;
      const { geometry } = feature.toGeoJSON(x, y, zoom);
      const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          const [aLon, aLat] = line[i - 1];
          const [bLon, bLat] = line[i];
          const ax = (aLon - lon) * lonScale;
          const ay = (aLat - lat) * metersPerDegree;
          const dx = (bLon - aLon) * lonScale;
          const dy = (bLat - aLat) * metersPerDegree;
          const lengthSquared = dx ** 2 + dy ** 2;
          if (!lengthSquared) continue;
          const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
          const squared = (ax + t * dx) ** 2 + (ay + t * dy) ** 2;
          if (squared >= best) continue;
          best = squared;
          nearest = {
            location: [aLon + t * (bLon - aLon), aLat + t * (bLat - aLat)],
            distanceMeters: Math.round(Math.sqrt(squared) * 10) / 10,
            roadClass,
          };
        }
      }
    }
  }
  return nearest;
}
