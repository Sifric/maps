import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const defaultIndex = new URL('../worker/public/assets/places-search.json.gz', import.meta.url);
const normalize = value => value.normalize('NFKC').toLowerCase().trim();

export async function openPlaces(file = defaultIndex) {
  const bytes = await readFile(file);
  const rows = JSON.parse(bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes) : bytes);
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE place (id INTEGER PRIMARY KEY, name TEXT, lon REAL, lat REAL,
      kind TEXT, description TEXT, label TEXT, search_name TEXT);
    CREATE VIRTUAL TABLE position USING rtree(id, west, east, south, north);
    BEGIN;
  `);
  const insert = db.prepare('INSERT INTO place VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const index = db.prepare('INSERT INTO position VALUES (?, ?, ?, ?, ?)');
  for (const [id, name, lon, lat, kind, description, label] of rows) {
    insert.run(id, name, lon, lat, kind, description, label ?? null, normalize(name + ' ' + (label ?? '')));
    index.run(id, lon, lon, lat, lat);
  }
  db.exec('COMMIT');
  const fields = 'p.id, p.name, p.lon, p.lat, p.kind, p.description, p.label';
  const details = db.prepare(`SELECT ${fields} FROM place p WHERE p.id = ?`);
  const nearby = db.prepare(`SELECT ${fields} FROM position r JOIN place p USING (id)
    WHERE r.west <= ? AND r.east >= ? AND r.south <= ? AND r.north >= ?`);
  return {
    close: () => db.close(),
    details: id => details.get(id),
    search(query, limit) {
      const terms = normalize(query).split(/\s+/u);
      const filter = terms.map(() => 'instr(p.search_name, ?) > 0').join(' AND ');
      return db.prepare(`SELECT ${fields} FROM place p WHERE ${filter}
        ORDER BY instr(p.search_name, ?) = 1 DESC, length(p.name), p.id LIMIT ?`)
        .all(...terms, normalize(query), limit);
    },
    nearby(lon, lat, radius, limit) {
      const rad = Math.PI / 180;
      const latSpan = radius / 110000;
      const lonSpan = latSpan / Math.max(0.1, Math.cos(lat * rad));
      return nearby.all(lon + lonSpan, lon - lonSpan, lat + latSpan, lat - latSpan)
        .map(place => {
          const a = Math.sin((place.lat - lat) * rad / 2) ** 2 +
            Math.cos(lat * rad) * Math.cos(place.lat * rad) * Math.sin((place.lon - lon) * rad / 2) ** 2;
          return { ...place, distanceMeters: Math.round(12742017.6 * Math.asin(Math.sqrt(Math.min(1, a)))) };
        })
        .filter(place => place.distanceMeters <= radius)
        .sort((a, b) => a.distanceMeters - b.distanceMeters || a.id - b.id)
        .slice(0, limit);
    },
  };
}
