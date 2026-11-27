// Keep the module response compatible with strict browser JavaScript MIME checks.
import { darkMapStyle } from "./map-options.js";
import { registerPlaceImages, selectedPlaceElement, stylePlaces } from "./place-markers.js?v=reference-35";

const { maplibregl, pmtiles } = window;
maplibregl.addProtocol("pmtiles", new pmtiles.Protocol().tile);
const response = await fetch("/style.json");
if (!response.ok) throw Error("Couldn’t load the Sifric basemap.");
const baseStyle = stylePlaces(await response.json());

/* Layer state: defaults, persisted choices, groups hidden by visibility */
const DEF = { type: 'default', themePref: 'auto', transit: false, bike: false, bld: true, shade: true, terrain3d: false, labels: true, poi: true, bnd: true, relief: 100, bikeOp: 85, exag: 1.5 };
const RANGE = { relief: [0, 130, 10], bikeOp: [20, 100, 5], exag: [1, 3, .1] };
const placeLayers = ['mazo-places-dot', 'mazo-places-icon', 'poi_r20', 'poi_r7', 'poi_r1'];
const GROUPS = {
  labels: baseStyle.layers.filter(layer => ['place', 'water_name', 'waterway', 'transportation_name'].includes(layer['source-layer']) && layer.type === 'symbol').map(layer => layer.id),
  poi: baseStyle.layers.filter(layer => ['poi', 'places'].includes(layer['source-layer'])).map(layer => layer.id),
  bnd: baseStyle.layers.filter(layer => layer['source-layer'] === 'boundary').map(layer => layer.id),
};
const sysDark = matchMedia('(prefers-color-scheme: dark)');
function loadPrefs() {
  try {
    const o = {};
    let s = JSON.parse(localStorage.getItem('maps.layers'));
    if (!s) {
      const old = JSON.parse(localStorage.getItem('lk-map-settings'));
      if (old) s = { themePref: old.theme === 'system' ? 'auto' : old.theme, type: old.type === 'satellite' ? 'sat' : old.type,
        labels: old.labels, poi: old.places, transit: old.details?.transit, bike: old.details?.bicycling, bld: old.details?.buildings };
    }
    if (!s || typeof s !== 'object') return o;
    for (const k in DEF) if (typeof s[k] === typeof DEF[k]) o[k] = s[k];
    if (!['default', 'sat', 'terrain'].includes(o.type)) delete o.type;
    if (!['auto', 'light', 'dark'].includes(o.themePref)) delete o.themePref;
    for (const k in RANGE) if (k in o) o[k] = Math.min(RANGE[k][1], Math.max(RANGE[k][0], o[k]));
    return o;
  } catch (e) { return {}; }
}
const mode = { ...DEF, ...loadPrefs(), theme: 'light' };
const resolveTheme = () => mode.themePref === 'auto' ? (sysDark.matches ? 'dark' : 'light') : mode.themePref;
mode.theme = resolveTheme();
const hsEx = () => mode.shade ? Math.min(1, (mode.type === 'terrain' ? .75 : mode.theme === 'dark' ? .5 : .32) * mode.relief / 100) : 0;
document.documentElement.dataset.theme = mode.theme;
document.querySelector('meta[name=theme-color]').content = mode.theme === 'dark' ? '#16181d' : '#ffffff';

/* Appearance controls apply to the deployed Sifric style. */
function build() {
  const st = mode.theme === 'dark' ? darkMapStyle(baseStyle) : structuredClone(baseStyle);
  const hidden = new Set(Object.entries(GROUPS).flatMap(([key, ids]) => mode[key] ? [] : ids));
  const sat = mode.type === 'sat';
  st.sources.dem = {
    type: 'raster-dem', tileSize: 256, encoding: 'terrarium', maxzoom: 14,
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    attribution: 'Terrain © Mapzen / AWS Open Data',
  };
  if (sat) st.sources.satellite = {
    type: 'raster', tileSize: 256, maxzoom: 19,
    tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Imagery © Esri and contributors',
  };
  for (const layer of st.layers) {
    const terrainOnly = layer.type === 'fill-extrusion' && !(mode.bld && mode.type === 'default');
    if (hidden.has(layer.id) || terrainOnly || (sat && ['background', 'fill', 'fill-extrusion'].includes(layer.type)))
      layer.layout = { ...layer.layout, visibility: 'none' };
  }
  if (sat) st.layers.unshift({ id: 'sat', type: 'raster', source: 'satellite' });
  else st.layers.splice(st.layers.findIndex(layer => layer['source-layer'] === 'transportation'), 0, {
    id: 'hs', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': hsEx() },
  });
  const transport = {
    type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 10,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  };
  const overlays = [];
  if (mode.transit) overlays.push({ ...transport, id: 'transit',
    filter: ['in', ['get', 'class'], ['literal', ['rail', 'transit']]],
    paint: { 'line-color': '#237ade', 'line-width': 3 } });
  if (mode.bike) overlays.push({ ...transport, id: 'bike', minzoom: 12,
    filter: ['all', ['!=', ['get', 'bicycle'], 'no'], ['!', ['in', ['get', 'access'], ['literal', ['private', 'no']]]],
      ['any', ['==', ['get', 'subclass'], 'cycleway'], ['in', ['get', 'bicycle'], ['literal', ['yes', 'designated', 'official']]]]],
    paint: { 'line-color': '#16a66a', 'line-dasharray': [2, 1], 'line-width': 3, 'line-opacity': mode.bikeOp / 100 } });
  st.layers.splice(st.layers.findIndex(layer => layer.type === 'symbol'), 0, ...overlays);
  if (mode.terrain3d) st.terrain = { source: 'dem', exaggeration: mode.exag };
  return st;
}

function createMap(options) {
  const instance = new maplibregl.Map({ ...options, fadeDuration: 0, style: build() });
  registerPlaceImages(instance);
  return instance;
}

function visiblePlaces(instance, point) {
  const layers = placeLayers.filter(id => instance.getLayer(id));
  return layers.length ? instance.queryRenderedFeatures(point, { layers }) : [];
}

function mapPlace(feature) {
  const properties = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;
  return {
    id: feature.id,
    _sourceLayer: feature.layer?.['source-layer'],
    _t: properties.name,
    _r: properties.subtitle || '',
    type: properties.subclass || properties.kind || properties.class || 'place',
    category: properties.kind || properties.class || '',
    lon, lat,
    extratags: properties,
  };
}

let placeIndex;
async function searchIndex() {
  placeIndex ??= fetch('/assets/places-search.json.gz').then(async result => {
    if (!result.ok) throw Error('Place search is unavailable.');
    return new Response(result.body.pipeThrough(new DecompressionStream('gzip'))).json();
  }).catch(error => {
    placeIndex = undefined;
    throw error;
  });
  return placeIndex;
}
const toPlace = ([id, name, lon, lat, category, type, label]) => ({
  id, _t: name, _r: label && label !== name ? label : '', type: type || category, category, lon, lat,
});
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
const chipMatches = {
  restaurant: /restaurant|fast food|food court/i, cafe: /caf[eé]|coffee/i,
  hotel: /hotel|guest house|resort|hostel|motel/i, 'fuel station': /fuel|petrol|filling station/i,
  pharmacy: /pharmacy/i, atm: /\batm\b/i, park: /\bpark\b|playground|garden/i,
};
async function lookup(query, nearby, center, limit) {
  const rows = await searchIndex();
  const term = normalize(query.trim());
  const words = term.split(/\s+/);
  const ref = [center.lng, center.lat];
  return rows.filter(row => nearby ? chipMatches[term]?.test(row[5] || row[1]) :
    words.every(word => normalize(row[1] + ' ' + (row[6] || '')).includes(word)))
    .map(row => ({ row, exact: normalize(row[1]).startsWith(term), distance: hav(ref, [row[2], row[3]]) }))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || a.distance - b.distance)
    .slice(0, limit).map(entry => toPlace(entry.row));
}
/* ---------- Helpers ---------- */
const $ = id => document.getElementById(id), rad = Math.PI / 180;
const hav = (a, b) => { const dx = (b[0] - a[0]) * rad, dy = (b[1] - a[1]) * rad, s = Math.sin(dy / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dx / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(Math.min(1, s))); };
const brg = (a, b) => { const dl = (b[0] - a[0]) * rad; return Math.atan2(Math.sin(dl) * Math.cos(b[1] * rad), Math.cos(a[1] * rad) * Math.sin(b[1] * rad) - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos(dl)) / rad; };
const fmt = m => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.max(10, Math.round(m / 10) * 10) + ' m';
const tfmt = s => { const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nice = s => (s || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const store = { get: k => { try { return JSON.parse(localStorage.getItem('maps.' + k)) || []; } catch (e) { return []; } }, set: (k, v) => { try { localStorage.setItem('maps.' + k, JSON.stringify(v)); } catch (e) {} } };
const ICON = {
  food: '<path d="M8 3v6a2 2 0 0 0 4 0V3M10 11v10M17 21V3c-2 1.2-2.6 3.5-2.6 6.2 0 2 1 2.8 2.6 2.8"/>',
  coffee: '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16M8 3v2M12 3v2"/>',
  bed: '<path d="M3 18V6M3 14h18v4M21 14v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="10.5" r="1.5"/>',
  fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M3 21h13"/><path d="M15 9h1.5a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V8l-2-2M7 8h5"/>',
  health: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/>',
  atm: '<path d="M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18"/>',
  park: '<path d="M12 3l5 7h-3l4 6H6l4-6H7z"/><path d="M12 16v5"/>',
  shop: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  transit: '<path d="M6 3h12v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><path d="M6 10h12M8 19l-2 2M16 19l2 2M9 14.5h.01M15 14.5h.01"/>',
  beach: '<path d="M2 17c2 0 2-1.5 4-1.5S8 17 10 17s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5M2 21c2 0 2-1.5 4-1.5s2 1.5 4 1.5 2-1.5 4-1.5 2 1.5 4 1.5"/><circle cx="16" cy="8" r="3"/>',
  pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>'
};
const svgI = (k, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ICON.pin}</svg>`;
const CATS = [[/restaurant|fast_food|food_court/, 'food', '#ff8a3d'], [/cafe|coffee|ice_cream|bakery/, 'coffee', '#b9824f'], [/hotel|hostel|guest|motel|lodging|apartment|resort/, 'bed', '#9b5cf6'], [/fuel|charging/, 'fuel', '#f0a020'],
  [/pharmacy|hospital|clinic|doctor|dentist/, 'health', '#ff453a'], [/atm|bank/, 'atm', '#2fa66a'], [/park|garden|forest|nature|pitch|playground/, 'park', '#30b45a'], [/shop|supermarket|mall|marketplace|convenience/, 'shop', '#3b82f6'],
  [/bus|station|rail|halt|stop/, 'transit', '#06b6d4'], [/beach|water|bay/, 'beach', '#0ea5e9']];
const cat = p => { const k = ((p.category || '') + ' ' + (p.type || '')).toLowerCase(), m = CATS.find(c => c[0].test(k)); return m ? [svgI(m[1]), m[2]] : [svgI('pin'), '#ff5a4e']; };
const same = (a, b) => +a.lon === +b.lon && +a.lat === +b.lat;
const slim = p => ({ id: p.id, _t: p._t, _r: p._r, type: p.type, category: p.category, lon: p.lon, lat: p.lat, boundingbox: p.boundingbox, extratags: p.extratags });
const pbody = $('pbody'), ps = $('psheet');
const SHEET = { compact: () => Math.min(300, innerHeight * .44), expanded: () => innerHeight * .9 };
const shPx = k => (SHEET[k] || SHEET.compact)();
function setPState(st) {
  st = st === 'expanded' || st === 'full' ? 'expanded' : 'compact';
  ps.dataset.state = st; ps.style.height = '';
  $('grab').setAttribute('aria-expanded', String(st === 'expanded'));
  $('grab').setAttribute('aria-label', st === 'expanded' ? 'Collapse place details' : 'Expand place details');
  document.documentElement.style.setProperty('--sh', shPx(st) + 'px');
}
function showSheet(on) { if (on && ps.hidden) setPState('compact'); ps.hidden = !on; if (!on) document.documentElement.style.setProperty('--sh', '0px'); }
const grab = $('grab'); let dr = null;
grab.onclick = e => { if (e.detail === 0) setPState(ps.dataset.state === 'expanded' ? 'compact' : 'expanded'); };
grab.onpointerdown = e => { dr = { y: e.clientY, h: ps.offsetHeight, moved: false }; ps.classList.add('dragging'); grab.setPointerCapture(e.pointerId); };
grab.onpointermove = e => {
  if (!dr) return; const dy = e.clientY - dr.y; if (Math.abs(dy) > 5) dr.moved = true;
  if (dr.moved) ps.classList.add('resizing');
  ps.style.height = Math.min(innerHeight * .92, Math.max(80, dr.h - dy)) + 'px';
  ps.style.setProperty('--drag-height', ps.style.height);
};
grab.onpointerup = grab.onpointercancel = () => {
  if (!dr) return; const d = dr; dr = null;
  const h = parseFloat(ps.style.height) || ps.offsetHeight;
  ps.classList.remove('dragging','resizing'); ps.style.height = '';
  if (!d.moved) return setPState(ps.dataset.state === 'expanded' ? 'compact' : 'expanded');
  if (h < 120) return closeAll();                                   /* dragged well down: close */
  const best = ['compact', 'expanded'].reduce((a, k) => Math.abs(shPx(k) - h) < Math.abs(shPx(a) - h) ? k : a, 'compact');
  setPState(best);
};
const pad = () => {
  const W = innerWidth, H = innerHeight, mob = W <= 640;
  const vis = el => { if (!el || el.hidden || getComputedStyle(el).display === 'none') return null; const r = el.getBoundingClientRect(); return r.width && r.height ? r : null; };
  let t = 24, b = 24, l = 24, rt = 24;
  const p = vis($('panel')), s = vis(ps);
  if (p) { if (mob) { if (p.top + p.height / 2 < H / 2) t = p.bottom + 16; else b = H - p.top + 16; } else l = p.right + 24; }
  if (s) { if (mob) b = Math.max(b, H - s.top + 16); else l = Math.max(l, s.right + 24); }
  if (t + b > H * .7) { t = H * .2; b = H * .2; }
  if (l + rt > W * .7) { l = W * .15; rt = W * .15; }
  return { top: t, bottom: b, left: l, right: rt };
};
const setRouting = on => { $('panel').classList.toggle('routing', on); document.body.classList.toggle('routing', on); };
let toastT; const toast = t => { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('show'), 1800); };

/* ---------- Map ---------- */
const hv = location.hash.slice(1).split('/').map(Number);
const hasHash = hv.length === 3 && hv.every(Number.isFinite)
  && hv[0] >= 0 && hv[0] <= 22 && Math.abs(hv[1]) <= 85 && Math.abs(hv[2]) <= 180;
const map = createMap({ container: 'map', center: hasHash ? [hv[2], hv[1]] : [80.5353, 5.9496], zoom: hasHash ? hv[0] : 14.2, attributionControl: false, maxPitch: 75, fadeDuration: 200 });
window.map = map;
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Sifric Maps' }));
const geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true, fitBoundsOptions: { maxZoom: 16.5 } });
map.addControl(geo, 'bottom-right');
geo.on('geolocate', e => userPos = [e.coords.longitude, e.coords.latitude]);
if (!hasHash) map.once('load', () => matchMedia('(prefers-reduced-motion: reduce)').matches ? map.jumpTo({ zoom: 15.2, pitch: 50, bearing: -18 }) : map.flyTo({ zoom: 15.2, pitch: 50, bearing: -18, duration: 1400, essential: true }));
map.on('moveend', () => { const c = map.getCenter(); try { history.replaceState(null, '', `#${map.getZoom().toFixed(1)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`); } catch (e) {} });

let routeRequest, routeOrigin, avoid = '', routes = null, ri = 0, tm = 'car', cur, pinMk, found = [], fromPt, userPos = null, timer, ctl, si = -1, anim = 0, selectedFeatureId = null, selectionVersion = 0;
function restorePlaces(key, legacyKey) {
  try {
    if (localStorage.getItem('maps.' + key) !== null) return store.get(key);
    return JSON.parse(localStorage.getItem(legacyKey) || '[]').map(toPlace);
  }
  catch { return []; }
}
let favs = restorePlaces('fav', 'lk-saved'), recent = restorePlaces('rec', 'lk-recents');

/* ---------- Route layers ---------- */
const RL = [['route-alt', { 'line-color': '#8aa0c8', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 6], 'line-opacity': .92 }, 0], ['route-c', { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 9, 16, 14], 'line-opacity': .98 }, 1], ['route', { 'line-color': '#0a7cff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 8], 'line-opacity': 1 }, 1]];
const L = { 'line-cap': 'round', 'line-join': 'round' };
function syncRoute() {
  if (!routes || !map.getStyle()) return;
  const fc = { type: 'FeatureCollection', features: routes.map((r, i) => ({ type: 'Feature', properties: { sel: +(i === ri), i }, geometry: r.geometry })) };
  if (map.getSource('route') && map.getLayer('route')) return map.getSource('route').setData(fc);
  RL.forEach(([id]) => map.getLayer(id) && map.removeLayer(id));
  map.getSource('route') && map.removeSource('route');
  map.addSource('route', { type: 'geojson', data: fc });
  RL.forEach(([id, paint, s]) => map.addLayer({ id, type: 'line', source: 'route', filter: ['==', ['get', 'sel'], s], layout: L, paint }));
}
const clearRoute = () => { routeRequest?.abort(); stopAnim(); routes = null; setRouting(false); ['route', 'route-c', 'route-alt'].forEach(i => map.getLayer(i) && map.removeLayer(i)); map.getSource('route') && map.removeSource('route'); };
map.on('style.load', syncRoute);
function syncSelectedPlaceLabel() {
  if (!map.getStyle()) return;
  const hidden = new Set();
  if (selectedFeatureId !== null && selectedFeatureId !== undefined) {
    hidden.add(selectedFeatureId);
    // A nearby symbol can take the selected symbol's slot after it is hidden.
    // Keep that symbol from drawing across the selected bubble and its name.
    const selectedPoint = map.project([+cur.lon, +cur.lat]);
    try {
      for (const feature of map.querySourceFeatures('openmaptiles', { sourceLayer: 'places' })) {
        if (feature.id === undefined || feature.geometry.type !== 'Point') continue;
        const point = map.project(feature.geometry.coordinates);
        if (Math.hypot(point.x - selectedPoint.x, point.y - selectedPoint.y) < 42)
          hidden.add(feature.id);
      }
    } catch { /* The source may still be loading after a style change. */ }
  }
  const filter = hidden.size ? ['!', ['in', ['id'], ['literal', [...hidden]]]] : null;
  for (const id of ['mazo-places-dot', 'mazo-places-icon']) {
    if (map.getLayer(id) && JSON.stringify(map.getFilter(id) ?? null) !== JSON.stringify(filter))
      map.setFilter(id, filter);
  }
}
function syncSelectedMarkerName() {
  const label = pinMk?.getElement().querySelector('.selected-marker__name');
  if (!label) return;
  const x = map.project(pinMk.getLngLat()).x;
  const half = label.offsetWidth / 2;
  const centered = Math.max(half + 12, Math.min(innerWidth - half - 12, x));
  label.style.setProperty('--label-shift', `${Math.round(centered - x)}px`);
}
map.on('move', syncSelectedMarkerName);
map.on('moveend', syncSelectedPlaceLabel);
map.on('style.load', syncSelectedPlaceLabel);
const pickRoute = i => { stopAnim(); ri = i; syncRoute(); dirCard(); };
map.on('click', 'route-alt', e => pickRoute(e.features[0].properties.i));
function applyStyle() {
  document.documentElement.dataset.theme = mode.theme;
  document.querySelector('meta[name=theme-color]').content = mode.theme === 'dark' ? '#16181d' : '#ffffff';
  // diff: true keeps unchanged sources (vector tiles, DEM) and layers alive and only applies what changed,
  // instead of tearing down and re-downloading the whole style on every layer switch.
  map.setStyle(build(), { diff: true });
  // A diff update drops layers that aren't in build() (the route layers), so re-add them.
  // style.load still covers the full-reload fallback.
  map.once('styledata', () => { if (map.isStyleLoaded()) { syncRoute(); syncSelectedPlaceLabel(); } });
}

/* ---------- Controls ---------- */
$('zin').onclick = () => map.zoomIn(); $('zout').onclick = () => map.zoomOut();
$('compass').onclick = () => map.easeTo({ bearing: 0, pitch: 0 });
$('b3d').onclick = () => map.easeTo(map.getPitch() > 5 ? { pitch: 0, bearing: 0, duration: 900 } : { pitch: 62, bearing: -20, duration: 900 });
map.on('rotate', () => $('needle').style.transform = `rotate(${-map.getBearing()}deg)`);
map.on('pitch', () => $('b3d').classList.toggle('on', map.getPitch() > 5));
/* compass + 3D sit directly under the search/categories panel by default; they follow its height */
const placeTilt = () => {
  const t = $('tilt'), p = $('panel');
  t.hidden = p.classList.contains('routing');
  if (!t.hidden) t.style.top = (p.offsetTop + p.offsetHeight + 10) + 'px';
};
new ResizeObserver(placeTilt).observe($('panel'));
addEventListener('resize', placeTilt);
placeTilt();
/* ---------- Layers panel ---------- */
const sheet = $('sheet'), scrim = $('scrim');
const PRESETS = {
  explore: { type: 'default', themePref: 'auto', transit: false, bike: false, bld: true, shade: true, terrain3d: false, labels: true, poi: true, bnd: true },
  transit: { type: 'default', transit: true, bike: false, terrain3d: false, labels: true, poi: true },
  cycling: { type: 'default', transit: false, bike: true, bld: false, shade: true, terrain3d: false, labels: true },
  hiking: { type: 'terrain', transit: false, bike: false, shade: true, terrain3d: true, labels: true, poi: false },
  night: { type: 'default', themePref: 'dark', bld: true, labels: true }
};
const unavailable = k => (k === 'bld' && mode.type !== 'default') || (k === 'shade' && mode.type === 'sat');
const changed = () => Object.keys(DEF).filter(k => mode[k] !== DEF[k]);
const fmtV = (k, v) => k === 'exag' ? v.toFixed(1) + '×' : Math.round(v) + '%';
function paintSlider(inp) {
  const k = inp.dataset.range, [a, b, s] = RANGE[k];
  inp.min = a; inp.max = b; inp.step = s;
  if (+inp.value !== mode[k]) inp.value = mode[k];
  inp.style.setProperty('--p', ((mode[k] - a) / (b - a) * 100) + '%');
  inp.nextElementSibling.textContent = fmtV(k, mode[k]);
}
function syncSheet() {
  sheet.querySelectorAll('[data-type]').forEach(b => { const on = b.dataset.type === mode.type; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  const seg = sheet.querySelector('[data-seg]');
  seg.style.setProperty('--i', ['auto', 'light', 'dark'].indexOf(mode.themePref));
  seg.querySelectorAll('button').forEach(b => { const on = b.dataset.v === mode.themePref; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  sheet.querySelectorAll('.lp-it').forEach(it => {
    const k = it.dataset.k, off = unavailable(k), on = !!mode[k] && !off, r = it.querySelector('.lp-row');
    it.classList.toggle('open', on); it.classList.toggle('off', off);
    r.setAttribute('aria-checked', on); r.setAttribute('aria-disabled', off);
    it.querySelector('small').textContent = off ? it.dataset.offmsg : it.dataset.msg;
    const inp = it.querySelector('input'); if (inp) paintSlider(inp);
  });
  sheet.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('on', Object.entries(PRESETS[b.dataset.preset]).every(([k, v]) => mode[k] === v)));
  const ch = changed(), n = ch.filter(k => !(k in RANGE)).length;
  $('lpReset').hidden = !ch.length;
  const bd = $('lpBadge'); bd.hidden = !n; bd.textContent = n;
  $('layers').classList.toggle('on', !sheet.hidden); $('layers').setAttribute('aria-expanded', !sheet.hidden);
}
const commit = rebuild => { savePrefs(); syncSheet(); if (rebuild) applyStyle(); };
function savePrefs() { try { localStorage.setItem('maps.layers', JSON.stringify(Object.fromEntries(Object.keys(DEF).map(k => [k, mode[k]])))); } catch (e) {} }
const liveVis = () => Object.entries(GROUPS).forEach(([k, ids]) => ids.forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', mode[k] ? 'visible' : 'none')));
const liveShade = () => map.getLayer('hs') && map.setPaintProperty('hs', 'hillshade-exaggeration', hsEx());
const liveTerrain = () => { if (map.getSource('dem')) map.setTerrain(mode.terrain3d ? { source: 'dem', exaggeration: mode.exag } : null); };
const tiltIn = () => { if (map.getPitch() < 20) map.easeTo({ pitch: 55, duration: 900 }); };

const phone = () => matchMedia('(max-width:640px)').matches;
const HEIGHTS = { peek: () => 214, half: () => innerHeight * 0.5, full: () => innerHeight * 0.88 };
let sheetState = 'half';
function setState(st) {
  sheetState = st; sheet.dataset.state = st;
  if (phone()) {
    scrim.hidden = sheet.hidden || st !== 'full';
    syncLayersDock();
  }
}
function syncLayersDock() {
  if (!phone() || sheet.hidden) return;
  const sheetHeight = sheet.getBoundingClientRect().height;
  const top = Math.max(0, document.documentElement.clientHeight - sheetHeight);
  const panel = $('panel');
  const viewportHeight = document.documentElement.clientHeight;
  const bottom = Math.max(12, viewportHeight - top + 18);
  document.documentElement.style.setProperty('--layers-height', `${Math.round(viewportHeight - top)}px`);
  panel.style.setProperty('position', 'fixed', 'important');
  panel.style.setProperty('top', 'auto', 'important');
  panel.style.setProperty('bottom', `${Math.round(bottom)}px`, 'important');
  panel.style.setProperty('z-index', '12', 'important');
}
function openSheet(on) {
  if (on === !sheet.hidden) return syncSheet();
  const inside = sheet.contains(document.activeElement);
  sheet.hidden = !on; scrim.hidden = !on;
  if (on) { if (phone()) setState(sheetState === 'full' ? 'full' : 'half'); else sheet.dataset.state = ''; }
  else {
    document.documentElement.style.removeProperty('--layers-height');
    ['position', 'top', 'bottom', 'z-index'].forEach(key => $('panel').style.removeProperty(key));
  }
  syncSheet();
  if (on && phone()) {
    requestAnimationFrame(syncLayersDock);
    setTimeout(syncLayersDock, 80);
    setTimeout(syncLayersDock, 240);
    setTimeout(syncLayersDock, 420);
    setTimeout(syncLayersDock, 560);
  }
  if (on) (sheet.querySelector('.tile.on') || $('sheetClose')).focus({ preventScroll: true });
  else if (inside) $('layers').focus({ preventScroll: true });
}
$('layers').onclick = () => openSheet(sheet.hidden);
scrim.onclick = () => openSheet(false);
$('sheetClose').onclick = () => openSheet(false);
addEventListener('keydown', e => {
  if (e.key === 'Escape' && !sheet.hidden) return openSheet(false);
  if ((e.key === 'l' || e.key === 'L') && !e.metaKey && !e.ctrlKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) openSheet(sheet.hidden);
});
sheet.addEventListener('click', e => {
  const t = e.target.closest('[data-type],[data-v],[data-sw],[data-preset],#lpReset'); if (!t) return;
  if (t.dataset.type) { mode.type = t.dataset.type; commit(true); }
  else if (t.dataset.v) { mode.themePref = t.dataset.v; mode.theme = resolveTheme(); commit(true); }
  else if (t.dataset.preset) { Object.assign(mode, PRESETS[t.dataset.preset]); mode.theme = resolveTheme(); if (mode.terrain3d) tiltIn(); commit(true); }
  else if (t.id === 'lpReset') { Object.assign(mode, DEF); mode.theme = resolveTheme(); commit(true); toast('Layers reset'); }
  else {
    const k = t.dataset.sw; if (unavailable(k)) return;
    mode[k] = !mode[k];
    if (k === 'terrain3d') { liveTerrain(); if (mode[k]) tiltIn(); commit(false); }
    else if (k in GROUPS) { liveVis(); commit(false); }
    else if (k === 'shade') { liveShade(); commit(false); }
    else commit(true);
  }
});
sheet.addEventListener('input', e => {
  const k = e.target.dataset.range; if (!k) return;
  mode[k] = +e.target.value; paintSlider(e.target);
  if (k === 'relief') liveShade();
  else if (k === 'bikeOp') map.getLayer('bike') && map.setPaintProperty('bike', 'line-opacity', mode.bikeOp / 100);
  else if (k === 'exag' && mode.terrain3d) liveTerrain();
  savePrefs(); syncSheet();
});
sheet.addEventListener('keydown', e => {
  const g = e.target.closest('[role=radiogroup]'); if (!g || !/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
  const b = [...g.querySelectorAll('[role=radio]')], i = b.indexOf(e.target); if (i < 0) return;
  e.preventDefault(); const n = b[(i + (/Right|Down/.test(e.key) ? 1 : b.length - 1)) % b.length]; n.focus(); n.click();
});
sysDark.addEventListener('change', () => { if (mode.themePref === 'auto') { mode.theme = resolveTheme(); applyStyle(); syncSheet(); } });
/* phone: drag the handle to resize (peek / half / full), down past peek to close; tap toggles half / full */
(() => {
  const g = $('lpGrab'); let d = null, moved = false;
  g.onpointerdown = e => {
    if (!phone()) return;
    d = { y: e.clientY, h: sheet.offsetHeight }; moved = false;
    g.setPointerCapture(e.pointerId); sheet.classList.add('dragging');
  };
  g.onpointermove = e => {
    if (!d) return;
    const dy = e.clientY - d.y; if (Math.abs(dy) > 4) moved = true;
    const h = Math.min(innerHeight * 0.88, Math.max(0, d.h - dy));
    sheet.style.height = h + 'px';
  };
  g.onpointerup = g.onpointercancel = e => {
    if (!d) return;
    const h = parseFloat(sheet.style.height) || sheet.offsetHeight;
    d = null; sheet.classList.remove('dragging'); sheet.style.height = '';
    if (!moved) return setState(sheetState === 'full' ? 'half' : 'full');
    if (h < 140) return openSheet(false);                                  /* dragged well down: close */
    const best = Object.keys(HEIGHTS).reduce((p, k) => Math.abs(HEIGHTS[k]() - h) < Math.abs(HEIGHTS[p]() - h) ? k : p, 'half');
    setState(best);
  };
  addEventListener('resize', () => { if (!sheet.hidden && phone()) { setState(sheetState); syncLayersDock(); } });
  sheet.addEventListener('transitionend', syncLayersDock);
})();
syncSheet();
$('loc').onclick = () => geo.trigger();

/* ---------- Search ---------- */
const body = $('body'), q = $('q');
const clearFound = () => { found.forEach(m => m.remove()); found = []; };
const head = t => body.insertAdjacentHTML('beforeend', `<div class="hdg">${t}</div>`);
function list(items) {
  const ref = userPos || map.getCenter().toArray();
  items.forEach(p => {
    const [ic, c] = cat(p), row = document.createElement('button'); row.type = 'button'; row.className = 'row';
    row.innerHTML = `<div class="dot" style="--c:${c}">${ic}</div><div class="tx"><b>${esc(p._t)}</b><span>${esc(nice(p.type))}${p._r ? ' · ' + esc(p._r) : ''}</span></div><em>${fmt(hav(ref, [+p.lon, +p.lat]))}</em>`;
    row.onclick = () => select(p); body.appendChild(row);
  });
}
function home() { ctl?.abort(); clearFound(); body.innerHTML = ''; si = -1; if (favs.length) { head('Saved'); list(favs); } if (recent.length) { head('Recent'); list(recent); } }
async function search(query, bounded) {
  if (!query.trim()) return home();
  ctl && ctl.abort(); ctl = new AbortController(); si = -1;
  body.innerHTML = '<div class="msg"><i class="spin"></i>Searching…</div>';
  const request = ctl;
  try {
    const d = await lookup(query, bounded, map.getCenter(), bounded ? 20 : 8);
    if (request.signal.aborted) return;
    clearFound();
    if (!d.length) { body.innerHTML = '<div class="msg">No results here. Try another name.</div>'; return; }
    body.innerHTML = '';
    list(d);
    d.forEach(p => {
      const el = document.createElement('div'); el.className = 'rm'; el.style.setProperty('--c', cat(p)[1]);
      el.onclick = e => { e.stopPropagation(); select(p); };
      found.push(new maplibregl.Marker({ element: el }).setLngLat([+p.lon, +p.lat]).addTo(map));
    });
    if (bounded) { const bb = new maplibregl.LngLatBounds(); d.forEach(p => bb.extend([+p.lon, +p.lat])); map.fitBounds(bb, { padding: pad(), maxZoom: 17, duration: 900 }); }
  } catch (e) { if (!request.signal.aborted) body.innerHTML = '<div class="msg">Search failed. Check your connection and try again.</div>'; }
}
q.oninput = () => {
  $('clear').hidden = !q.value;
  clearTimeout(timer);
  ctl?.abort();
  si = -1;
  if (!q.value.trim()) return home();
  body.innerHTML = '<div class="msg"><i class="spin"></i>Searching…</div>';
  timer = setTimeout(() => search(q.value, false), 350);
};
q.onfocus = () => { if (!q.value && !cur && !routes) home(); };
q.onkeydown = e => {
  const R = [...body.querySelectorAll('.row')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!R.length) return; e.preventDefault();
    si = (si + (e.key === 'ArrowDown' ? 1 : -1) + R.length) % R.length;
    R.forEach((r, i) => r.classList.toggle('sel', i === si)); R[si].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') { if (si >= 0 && R[si]) R[si].click(); else { clearTimeout(timer); search(q.value, false); } }
  else if (e.key === 'Escape') q.blur();
};
addEventListener('keydown', e => { if (e.key === '/' && document.activeElement !== q && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); } });
$('clear').onclick = () => { q.value = ''; $('clear').hidden = true; closeAll(); home(); };
document.querySelectorAll('.chip i').forEach(i => i.innerHTML = svgI(i.dataset.k, 14));
document.querySelectorAll('.chip').forEach(c => c.onclick = () => { clearTimeout(timer); q.value = c.dataset.c; $('clear').hidden = false; search(c.dataset.c, true); });

/* ---------- Map interaction ---------- */
map.on('click', e => {
  if (routes || document.body.matches('.picking,.routing')) return;
  if (document.body.classList.contains('search-open')) {
    window.collapseSearch?.(true);
    return;
  }
  const feature = visiblePlaces(map, e.point)
    .filter(item => item.geometry.type === 'Point' && item.properties.name)
    .sort((a, b) => {
      const pa = map.project(a.geometry.coordinates), pb = map.project(b.geometry.coordinates);
      return Math.hypot(pa.x - e.point.x, pa.y - e.point.y) - Math.hypot(pb.x - e.point.x, pb.y - e.point.y);
    })[0];
  if (feature) select(mapPlace(feature), false);
  else drop(e.lngLat);
});
map.on('contextmenu', e => { if (!document.body.matches('.picking,.routing')) drop(e.lngLat); });
map.on('mousemove', e => { map.getCanvas().style.cursor = visiblePlaces(map, e.point).length ? 'pointer' : ''; });
function drop({ lng, lat }) {
  select({ _t: 'Dropped pin', _r: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, type: 'location', category: '', lon: lng, lat }, false);
}

/* ---------- Place card ---------- */
function select(p, fly = true) {
  window.collapseSearch?.(false);
  ctl?.abort(); clearTimeout(timer);
  const version = ++selectionVersion;
  cur = p; clearFound(); pinMk && pinMk.remove(); pinMk = null; clearRoute(); fromPt = map.getCenter().toArray();
  const dropped = p.type === 'location' || p._t === 'Dropped pin';
  selectedFeatureId = dropped || (p._sourceLayer && p._sourceLayer !== 'places') ? null : p.id ?? null;
  syncSelectedPlaceLabel();
  const el = selectedPlaceElement(p.category || p.type, dropped, p._t);
  const marker = new maplibregl.Marker({ element: el, anchor: dropped ? 'bottom' : 'center' }).setLngLat([+p.lon, +p.lat]);
  const showMarker = () => {
    if (version !== selectionVersion) return;
    pinMk = marker.addTo(map);
    syncSelectedMarkerName();
  };
  // The canvas redraws after setFilter. Add the expanded marker in that same
  // frame, after the old tile icon is gone, so both sizes never paint together.
  if (selectedFeatureId !== null && map.getLayer('mazo-places-icon')) {
    map.once('render', showMarker);
    map.triggerRepaint();
  } else showMarker();
  if (fly) {
    const bb = p.boundingbox;
    bb && +bb[1] - +bb[0] > .002 ? map.fitBounds([[+bb[2], +bb[0]], [+bb[3], +bb[1]]], { padding: pad(), maxZoom: 17, duration: 1200 })
      : map.flyTo({ center: [+p.lon, +p.lat], zoom: 16.5, offset: innerWidth > 640 ? [190, 0] : [0, 150], duration: 1400 });
    recent = [slim(p), ...recent.filter(r => !same(r, p))].slice(0, 5); store.set('rec', recent);
  }
  card();
}
function facts() {
  const x = cur.extratags || {}, hrs = x.opening_hours, ph = x.phone || x['contact:phone'], web = x.website || x['contact:website'], sv = favs.some(f => same(f, cur));
  const li = (k, v) => `<div class="fact"><span>${k}</span><div>${v}</div></div>`;
  return `<div class="facts">${hrs ? li('Hours', esc(hrs)) : ''}${ph ? li('Phone', `<a href="tel:${esc(ph.replace(/[^\d+]/g, ''))}">${esc(ph)}</a>`) : ''}${web && /^https?:\/\//i.test(web) ? li('Website', `<a href="${esc(web)}" target="_blank" rel="noopener">${esc(web.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''))}</a>`) : ''}${li('Coordinates', `${(+cur.lat).toFixed(5)}, ${(+cur.lon).toFixed(5)}`)}</div>
  <div class="btns"><button class="btn p" data-a="dir">Directions</button><button class="btn ${sv ? 'on' : ''}" data-a="save">${sv ? '★ Saved' : '☆ Save'}</button><button class="btn" data-a="share">Share</button></div>`;
}
function appleHead() {
  return `<div class="ah">
    <button class="ib ac" data-a="share" aria-label="Share" title="Share"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg></button>
    <div class="at"><h2>${esc(cur._t)}</h2><p>${esc(nice(cur.type))}${cur._r ? ' · ' + esc(cur._r) : ''}</p></div>
    <button class="ib ac" data-a="close" aria-label="Close" title="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
  </div>`;
}
function appleActions() {
  const x = cur.extratags || {}, ph = x.phone || x['contact:phone'], web = x.website || x['contact:website'];
  const phone = ph ? `<a class="apl" href="tel:${esc(ph.replace(/[^\d+]/g, ''))}"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg><span>Call</span></a>`
    : `<span class="apl off" aria-disabled="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg><span>Call</span></span>`;
  const compass = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor"/></svg>';
  const second = web && /^https?:\/\//i.test(web)
    ? `<a class="apl" href="${esc(web)}" target="_blank" rel="noopener">${compass}<span>Website</span></a>`
    : `<button class="apl" data-a="dir">${compass}<span>Directions</span></button>`;
  return `<div class="aa">${phone}${second}</div>`;
}
function card(x = '') {
  const [ic, c] = cat(cur);
  body.innerHTML = ''; showSheet(true);
  if (x) { pbody.innerHTML = `<div class="card"><div class="hd"><div class="dot" style="--c:${c}">${ic}</div><div><h2>${esc(cur._t)}</h2><p>${esc(nice(cur.type))}${cur._r ? ' · ' + esc(cur._r) : ''}</p></div><button class="ib" data-a="close" title="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></button></div>${x}</div>`; return; }
  pbody.innerHTML = `<div class="card apple">${appleHead()}${appleActions()}${facts()}</div>`;
}
function save() { const i = favs.findIndex(f => same(f, cur)); i >= 0 ? favs.splice(i, 1) : favs.unshift(slim(cur)); store.set('fav', favs); card(); toast(i >= 0 ? 'Removed from Saved' : 'Saved'); }
function share() {
  const u = new URL(location.href);
  u.searchParams.delete('place');
  u.searchParams.delete('pin');
  if (cur.id) u.searchParams.set('place', cur.id);
  else u.searchParams.set('pin', '1');
  u.hash = `17/${(+cur.lat).toFixed(5)}/${(+cur.lon).toFixed(5)}`;
  if (navigator.share) navigator.share({ title: cur._t, url: u.href }).catch(() => {});
  else if (navigator.clipboard) navigator.clipboard.writeText(u.href).then(() => toast('Link copied'), () => toast('Couldn’t copy link'));
}
body.onclick = e => {
  const a = e.target.closest('[data-a]'); if (!a) return; const k = a.dataset.a;
  if (k === 'car' || k === 'foot' || k === 'bike' || k === 'moto') go(k); else if (k === 'dir') go(tm); else if (k === 'close') closeAll();
  else if (k === 'back') { clearRoute(); card(); } else if (k === 'save') save(); else if (k === 'share') share();
  else if (k === 'prev') preview();
  else if (k === 'overview') routeOverview(); else if (k === 'alt') pickRoute(+a.dataset.i);
};
pbody.onclick = body.onclick;
function closeAll() { ++selectionVersion; clearFound(); pinMk && pinMk.remove(); pinMk = null; cur = null; selectedFeatureId = null; syncSelectedPlaceLabel(); clearRoute(); body.innerHTML = ''; showSheet(false); }

/* ---------- Directions ---------- */
let tabs = () => `<div class="modes">${[['car', 'Drive'], ['foot', 'Walk'], ['bike', 'Cycle']].map(([k, t]) => `<button data-a="${k}" class="${k === tm ? 'on' : ''}">${t}</button>`).join('')}</div>`;
const stepText = s => {
  if (s.text) return s.text;
  const m = s.maneuver, d = m.modifier || 'straight', n = s.name ? ` onto ${s.name}` : '';
  return m.type === 'depart' ? `Head${s.name ? ' on ' + s.name : ' out'}` : m.type === 'arrive' ? 'Arrive at your destination'
    : /roundabout|rotary/.test(m.type) ? `At the roundabout, take exit ${m.exit || ''}`.trim() : m.type === 'fork' ? `Keep ${d}${n}`
    : /turn|end of road|ramp/.test(m.type) ? `Turn ${d}${n}` : `Continue ${d === 'straight' ? 'straight' : d}${n}`;
};
const TURN = {
  straight: '<path d="M12 20V4M6.5 9.5 12 4l5.5 5.5"/>',
  left: '<path d="M12 20v-5a3 3 0 0 0-3-3H5M8.5 9.5 5 12l3.5 2.5"/>',
  right: '<path d="M12 20v-5a3 3 0 0 1 3-3h4M15.5 9.5 19 12l-3.5 2.5"/>',
  slightL: '<path d="M12 20V10L6.5 4.5M6.5 9V4.5H2"/>',
  slightR: '<path d="M12 20V10l5.5-5.5M17.5 9V4.5H22"/>',
  sharpL: '<path d="M12 20v-8L5 5M5 10V5h5"/>',
  sharpR: '<path d="M12 20v-8l7-7M19 10V5h-5"/>',
  uturn: '<path d="M9 20V9a3 3 0 0 1 6 0v8M12.5 14l2.5 3 2.5-3"/>',
  round: '<circle cx="12" cy="12" r="3"/><path d="M12 9V3M9.5 5.5 12 3l2.5 2.5"/>',
  depart: '<circle cx="12" cy="12" r="3.5"/>',
  arrive: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>'
};
const arrow = s => {
  const m = s.maneuver || {}, t = m.type, d = m.modifier || '', L = /left/.test(d);
  const k = t === 'depart' ? 'depart' : t === 'arrive' ? 'arrive' : /roundabout|rotary/.test(t) ? 'round'
    : /uturn/.test(d) ? 'uturn' : /sharp/.test(d) ? (L ? 'sharpL' : 'sharpR') : /slight/.test(d) ? (L ? 'slightL' : 'slightR')
    : L ? 'left' : /right/.test(d) ? 'right' : 'straight';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TURN[k]}</svg>`;
};
async function go(m) {
  if (!cur) return;
  const target = cur;
  tm = m;
  clearRoute();
  const request = new AbortController();
  routeRequest = request;
  const origin = routeOrigin?.coordinates || userPos || fromPt;
  const mode = { car: 'drive', foot: 'walk', bike: 'cycle', moto: 'twoWheeler' }[m];
  setRouting(true);
  card(tabs() + '<div class="msg"><i class="spin"></i>Finding routes…</div>');
  try {
    const res = await fetch('/api/v1/route', {
      method: 'POST', signal: request.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin, destination: [+target.lon, +target.lat], mode, alternatives: true,
        ...(mode === 'drive' && avoid && { [avoid === 'tolls' ? 'avoidTolls' : 'avoidHighways']: true }),
      }),
    });
    const result = await res.json();
    if (!res.ok) throw Error(result.error || 'Couldn’t find a route.');
    if (request.signal.aborted || cur !== target) return;
    if (!result.routes?.length) throw Error('No route was found.');
    routes = result.routes.map(route => ({ ...route, legs: [{ steps: route.steps || [] }] }));
    ri = 0;
    syncRoute();
    setPState('compact');
    dirCard();
    routeOverview();
  } catch (error) {
    if (!request.signal.aborted && cur === target) {
      card(tabs() + `<div class="msg">${esc(error.message || 'Couldn’t find a route.')}</div>`);
    }
  }
}
function dirCard() {
  const R = routes[ri], st = R.legs[0].steps;
  card(`${tabs()}<div class="eta">${tfmt(R.duration)}<small>${fmt(R.distance)}${userPos ? '' : ' · from map view'}</small></div>
  ${routes.length > 1 ? `<div class="alts">${routes.map((r, i) => `<button data-a="alt" data-i="${i}" class="${i === ri ? 'on' : ''}">${tfmt(r.duration)}<small>${fmt(r.distance)}${i === 0 ? ' · Fastest' : ''}</small></button>`).join('')}</div>` : ''}
  <details class="steps"><summary>${st.length} steps</summary><ol>${st.map(s => `<li><i>${arrow(s)}</i><div><b>${esc(stepText(s))}</b><span>${fmt(s.distance)}</span></div></li>`).join('')}</ol></details>
  <div class="btns"><button class="btn p" id="pv" data-a="prev">Preview</button><button class="btn" data-a="back">End</button></div>`);
}
function stopAnim() { if (anim) { cancelAnimationFrame(anim); anim = 0; } document.body.classList.remove('previewing'); const b = $('pv'); if (b) b.textContent = 'Preview'; }
function routeOverview() {
  if (!routes || !routes.length) return;
  const bb = new maplibregl.LngLatBounds();
  routes.forEach(R => R.geometry.coordinates.forEach(c => bb.extend(c)));
  const mob = innerWidth <= 640;
  const sheetH = ps.offsetHeight || 0;
  map.fitBounds(bb, {
    padding: mob ? { top: 96, left: 36, right: 36, bottom: Math.min(sheetH, innerHeight * .6) + 28 }
                 : { top: 48, left: 440, right: 48, bottom: 48 },
    pitch: 0, bearing: 0, maxZoom: 17, duration: 800
  });
}
function preview() {
  if (anim) return stopAnim();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return routeOverview();
  const c = routes[ri].geometry.coordinates, cum = [0];
  for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + hav(c[i - 1], c[i]));
  const tot = cum[cum.length - 1];
  if (!tot) return;
  const dur = Math.min(45e3, Math.max(9e3, tot * 5)), t0 = performance.now();
  let k = 1, j = 1, bear = map.getBearing(); $('pv').textContent = 'Stop'; document.body.classList.add('previewing');
  const step = now => {
    const f = Math.min(1, (now - t0) / dur), d = f * tot;
    while (k < c.length - 1 && cum[k] < d) k++;
    const a = c[k - 1], b = c[k], u = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1), p = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    while (j < c.length - 1 && cum[j] < d + 60) j++;
    bear += ((brg(p, c[j]) - bear + 540) % 360 - 180) * .035;
    map.jumpTo({ center: p, bearing: bear, pitch: 64, zoom: 17.3 });
    if (f < 1) anim = requestAnimationFrame(step); else { anim = 0; stopAnim(); }
  };
  anim = requestAnimationFrame(step);
}
['mousedown', 'touchstart', 'wheel'].forEach(ev => map.on(ev, () => { if (anim) stopAnim(); }));

(()=>{
const ic=(d,s=20)=>`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const MI={car:'<path d="M5 17v-6l2-5h10l2 5v6M3 17h18M7.5 14h.01M16.5 14h.01"/>',foot:'<circle cx="13" cy="4.5" r="1.8"/><path d="m9 21 2-6-2-3 3-3 3 2 2 3M11 15l3 2v4"/>',bike:'<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-8h5l3 8M9 8H7"/>'};
const IC={pin:'<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.5"/>',add:'<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11zM12 7.5v5M9.5 10h5"/>',rev:'<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',photo:'<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',edit:'<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',rep:'<path d="M5 21V4M5 4h13l-2 4 2 4H5"/>',x:'<path d="M18 6 6 18M6 6l12 12"/>',back:'<path d="m15 18-6-6 6-6"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>',save:'<path d="M6 3h12v18l-6-4-6 4z"/>',share:'<path d="M12 15V3M7.5 7.5 12 3l4.5 4.5M5 12v8h14v-8"/>',nav:'<path d="m3 11 18-8-8 18-2-8z"/>'};
const PT={add:50,rev:20,photo:15,edit:25,rep:10,roadf:25,roadm:25,roadn:25,roadd:25,roadx:25,roadp:25,roadz:25,roado:25,roadc:25},LV=[[0,'Explorer'],[50,'Scout'],[150,'Mapper'],[300,'Guide'],[600,'Pathfinder'],[1000,'Cartographer']];
let me=(()=>{const m=store.get('me');return m&&!Array.isArray(m)?m:{pts:0,items:[],revs:{}}})();
const lvl=p=>{let i=0;LV.forEach((l,k)=>p>=l[0]&&(i=k));const a=LV[i][0],b=LV[i+1]?LV[i+1][0]:a;return{i,n:LV[i][1],f:b>a?(p-a)/(b-a):1,left:b-p}};
const pk=p=>(+p.lat).toFixed(4)+','+(+p.lon).toFixed(4);
const star=(v,s=14)=>[1,2,3,4,5].map(n=>`<svg width="${s}" height="${s}" viewBox="0 0 24 24" class="${v>=n-.3?'f':''}">${IC.rev}</svg>`).join('');
const DL=['Leave now','In 30 min','In 1 hour','In 2 hours'],DM=[0,30,60,120];let dep=0;

/* avatar */
const av=document.createElement('button');av.className='av';av.title='Contribute';av.setAttribute('aria-label','Contribute and profile');
document.querySelector('.bar').appendChild(av);
const refreshAv=()=>{const L=lvl(me.pts);av.style.setProperty('--p',L.f*360+'deg');av.innerHTML=`<i>${ic(IC.user,18)}</i>`;av.title=`${L.n} · ${me.pts} points`};refreshAv();

/* directions */
tabs=()=>{const o=routeOrigin?.label || (userPos?'Your location':'Map center');
  return `<div class="pts"><div class="rl"><i></i><b></b><i class="d"></i></div><div class="fs"><input id="from" value="${esc(o)}" aria-label="Start point" autocomplete="off" enterkeyhint="go"><div class="to">${esc(cur._t)}</div></div></div>
  <div class="modes">${[['car','Drive'],['foot','Walk'],['bike','Cycle']].map(([k,t])=>`<button data-a="${k}" class="${k===tm?'on':''}">${ic(MI[k],17)}${t}</button>`).join('')}</div>
  <div class="opts"><button class="oc on" data-x="dep">${ic('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',15)}${DL[dep]}</button>${[['tolls','Avoid tolls'],['hwy','Avoid highways']].map(([k,t])=>`<button class="oc ${avoid===k?'on':''}" ${tm!=='car'?'disabled':''} data-x="opt" data-o="${k}">${t}</button>`).join('')}</div>`};
dirCard=()=>{
  const R=routes[ri],st=R.legs[0].steps,arr=new Date(Date.now()+(DM[dep]*60+R.duration)*1e3).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}),short=Math.min(...routes.map(r=>r.distance));
  card(`${tabs()}<div class="eta">${tfmt(R.duration)}<small>${fmt(R.distance)} · arrive ${arr}</small></div>
  ${routes.length>1?`<div class="alts">${routes.map((r,i)=>`<button data-a="alt" data-i="${i}" class="${i===ri?'on':''}">${tfmt(r.duration)}<small>${fmt(r.distance)} · ${i===0?'Fastest':r.distance===short?'Shortest':'Alternative'}</small></button>`).join('')}</div>`:''}
  <div class="btns"><button class="btn p" id="pv" data-a="prev">Start preview</button><button class="btn" data-a="overview">Overview</button><button class="btn" data-a="back">End</button></div>
  <details class="steps"><summary>${st.length} steps</summary><ol>${st.map(s=>`<li><i>${arrow(s)}</i><div><b>${esc(stepText(s))}</b><span>${fmt(s.distance)}</span></div></li>`).join('')}</ol></details>`);
};
addEventListener('keydown', async e => {
  if (e.target.id !== 'from' || e.key !== 'Enter' || !cur) return;
  e.preventDefault();
  const value = e.target.value.trim();
  const destination = cur;
  if (!value || /^(your location|map center)$/i.test(value)) { routeOrigin = undefined; return go(tm); }
  const coords = value.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  try {
    const place = coords ? { lat: Number(coords[1]), lon: Number(coords[2]), _t: value }
      : (await lookup(value, false, map.getCenter(), 1))[0];
    if (cur !== destination) return;
    if (!place) return toast('Couldn’t find that start point');
    routeOrigin = { label: place._t, coordinates: [+place.lon, +place.lat] };
    go(tm);
  } catch { toast('Search failed. Check your connection.'); }
});
addEventListener('focusin',e=>e.target.id==='from'&&e.target.select());

/* contribution hub */
const hub=document.createElement('section');hub.id='hub';hub.className='sheet hub glass';hub.hidden=true;hub.setAttribute('aria-label','Contribute');document.body.appendChild(hub);
let photoUrl;
function releaseContributionPreview() {
  if (prevMap) { prevMap.remove(); prevMap = null; }
  if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = undefined; }
}
const closeHub=()=>{hub.hidden=true;scrim.hidden=true;releaseContributionPreview();};scrim.onclick=()=>{openSheet(false);closeHub()};
addEventListener('keydown',e=>e.key==='Escape'&&!hub.hidden&&closeHub());
const hd=(t,b)=>`<div class="sh-head">${b?`<button class="ib" data-x="home" aria-label="Back">${ic(IC.back)}</button>`:''}<h3>${t}</h3><button class="ib" data-x="close" aria-label="Close">${ic(IC.x)}</button></div>`;
const fld=(l,h)=>`<label class="fd"><span>${l}</span>${h}</label>`;
let preC=null;
const opts=(a,s)=>a.map(o=>`<option${o===s?' selected':''}>${o}</option>`).join('');
const FM={
 add:{own:1,t:'Add a place',s:'Save',b:()=>{const c=pick||map.getCenter(),ll=`${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;return `
<div class="ab-card">${ic(IC.add,22)}<div><b>Add your business to Maps for free</b><span class="lnk">Is this your business?</span></div></div>
<h4 class="fs-h">Place details</h4>
<p class="fs-p">Provide some information about this place. Your contribution is saved as a draft on this device.</p>
${fld('Place name (required)*','<input name="n" required maxlength="80" placeholder="Place name">')}
${fld('Category (required)*',`<select name="c" required>${opts(['Food & drink','Shop','Hotel','Fuel station','Health','Pharmacy','ATM / bank','Park','Transit','Religious place','Education','Services','Other'])}</select>`)}
${fld('Address (required)*','<input name="a" required maxlength="160" placeholder="Street, area, city">')}
<div class="mapbox"><div class="mapview" id="mapPrev"></div><svg class="mapPin" width="34" height="44" viewBox="0 0 40 50" aria-hidden="true"><path d="M20 2C10.1 2 2 10.1 2 20c0 13.2 18 28 18 28s18-14.8 18-28C38 10.1 29.9 2 20 2z" fill="#e53935" stroke="#fff" stroke-width="2.5"/><circle cx="20" cy="20" r="5.5" fill="#7f1d1a"/></svg><span class="mapll" id="mapLl">${ll}</span><button type="button" class="mapedit" data-x="pin">${ic(IC.pin,16)}Edit map location</button></div>
${fld('Located within','<input name="w" maxlength="80" placeholder="Building, mall or complex (optional)">')}
<div class="fd"><span>Hours</span>${hbtn()}</div>
<h4 class="fs-h">Contact</h4>
${fld('Phone number','<input name="ph" type="tel" inputmode="tel" maxlength="30" placeholder="Phone number">')}
${fld('Website','<input name="web" type="url" inputmode="url" maxlength="200" placeholder="https://">')}
<h4 class="fs-h">Place photos</h4>
<p class="fs-p">Add helpful photos like storefronts, notices, or signs (optional)</p>
<p class="fs-p fs-s">Photos are previewed on this device.</p>
<label class="addph">${ic(IC.photo,18)}Add photos<input type="file" name="p" accept="image/*" multiple hidden></label>
<div class="pv" id="pvw"></div>
${fld('Caption (optional)','<input name="x" maxlength="100">')}
<div class="fbar"><button type="button" class="btn" data-x="close">Cancel</button><button class="btn p" type="submit">Save draft</button></div>`}},
 photo:{t:'Add a photo',s:'Save photo',b:()=>fld('Choose an image','<input type="file" name="p" accept="image/*" required>')+'<div class="pv" id="pvw"></div>'+fld('Caption (optional)','<input name="x" maxlength="100">')},
 epick:{t:'Suggest an edit',own:1,b:()=>{
  const x=tg.extratags||{};
  const row=(c,t,p,add)=>`<button type="button" class="pr2${add?' add':''}" data-x="ef" data-c="${c}"><span class="pi">${ic(p,20)}</span><span class="pt">${esc(t)}</span><i>›</i></button>`;
  const cat=tg.type?nice(tg.type):'';
  return `<div class="pr2-list">
${row('Name',tg._t||'Add name',IC.store||'<path d="M4 9h16l-1-5H5zM5 9v11h14V9M9 20v-5h6v5"/>',!tg._t)}
${row('Category',cat||'Add category','<path d="M8 4l4 7H4zM16 13a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM4 13h7v7H4z"/>',!cat)}
${row('Address',tg._r||'Add address',IC.pin,!tg._r)}
${row('Opening hours',x.opening_hours||'Add opening hours','<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',!x.opening_hours)}
${row('Phone number',x.phone||'Add phone number','<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>',!x.phone)}
${row('Website',x.website||'Add website','<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3 3.5 3 13.5 0 17M12 3.5c-3 3.5-3 13.5 0 17"/>',!x.website)}
<button type="button" class="pr2 warn" data-x="ef" data-c="Permanently closed"><span class="pi">${ic('<path d="M4 4l16 16M9 6.5A6 6 0 0 1 18 12c0 1.6-.6 3-1.4 4M6 9.5A6 6 0 0 0 12 19"/>',20)}</span><span class="pt">Place is closed or not here</span><i>›</i></button>
</div>
<p class="ep-link">Own this business?</p>
<p class="ep-link ep-sm">Report a legal issue <span>·</span> Report business conduct</p>
<div class="fbar"><button type="button" class="btn wide" data-x="home">Cancel</button></div>`}},
 roadpick:{t:'Add or fix a road',own:1,b:()=>`<div class="pr2-list">${['Missing road','Road name','One or two way','Drawn incorrectly','Road is private','Road closed','Road does not exist','Other'].map(n=>`<button type="button" class="pr2" data-x="rf" data-c="${n}"><span class="pt">${n}</span><i>›</i></button>`).join('')}</div>`},
 roadf:{t:'Add or fix a road',s:'Save draft',b:()=>`<p class="fs-p">${esc(tg._t||'Selected road')}</p><div class="fd"><span>${esc(preRoad||'')}</span></div>${fld('Details (optional)','<textarea name="x" rows="4" maxlength="300"></textarea>')}<input type="hidden" name="c" value="${esc(preRoad||'')}">`},
 edit:{t:'Edit information',own:1,b:()=>{
  const x=tg.extratags||{},first={Name:'name',Category:'cat',Address:'loc','Opening hours':'hours','Phone number':'contact',Website:'web'}[preC]||'name';
  const CH=[['name','Place name'],['cat','Category'],['loc','Location'],['hours','Hours'],['contact','Contact'],['web','Website']];
  const dk=n=>`<label class="dk"><input type="checkbox" name="${n}"><span>Don’t know, but this is incorrect</span></label>`;
  const on=k=>k===first;
  return `<div class="ei-chips">${CH.map(([k,t])=>`<button type="button" class="ech${on(k)?' on':''}" data-x="sec" data-s="${k}">${on(k)?ic('<path d="M5 12.5l4.5 4.5L19 7.5"/>',15):'+'} ${t}</button>`).join('')}</div>
<section class="ei-sec" data-sec="name" ${on('name')?'':'hidden'}><h4 class="fs-h">Place name</h4>${fld('Place name in English (required)','<input name="n" maxlength="80" value="'+esc(tg._t||'')+'">')}${dk('dkn')}</section>
<section class="ei-sec" data-sec="cat" ${on('cat')?'':'hidden'}><h4 class="fs-h">Category</h4><label class="fd"><select name="c">${opts(['Food & drink','Shop','Hotel','Fuel station','Health','Pharmacy','ATM / bank','Park','Transit','Religious place','Education','Services','Tourist attraction','Other'])}</select></label>${dk('dkc')}</section>
<section class="ei-sec" data-sec="loc" ${on('loc')?'':'hidden'}><h4 class="fs-h">Address</h4>${fld('Address (required)','<input name="a" maxlength="160" value="'+esc(tg._r||'')+'">')}${dk('dka')}<h4 class="fs-h">Location details</h4>${fld('Located within','<input name="w" maxlength="80" placeholder="Located within">')}</section>
<section class="ei-sec" data-sec="hours" ${on('hours')?'':'hidden'}><h4 class="fs-h">Hours</h4><div class="fd"><span>Opening hours</span>${hbtn()}</div>${dk('dkh')}</section>
<section class="ei-sec" data-sec="contact" ${on('contact')?'':'hidden'}><h4 class="fs-h">Contact</h4>${fld('Phone number','<input name="ph" type="tel" inputmode="tel" maxlength="30" value="'+esc(x.phone||x['contact:phone']||'')+'">')}${dk('dkp')}</section>
<section class="ei-sec" data-sec="web" ${on('web')?'':'hidden'}><h4 class="fs-h">Websites</h4>${fld('Website','<input name="web" type="url" inputmode="url" maxlength="200" value="'+esc(x.website||x['contact:website']||'')+'" placeholder="https://">')}${dk('dkw')}</section>
<h4 class="fs-h">Photos</h4>
<p class="fs-p">Add helpful photos like storefronts, notices, or signs (optional)</p>
<label class="addph">${ic(IC.photo,18)}Add photos<input type="file" name="p" accept="image/*" multiple hidden></label>
<div class="pv" id="pvw"></div>
<div class="fbar"><button type="button" class="btn" data-x="home">Cancel</button><button class="btn p" type="submit" disabled>Save draft</button></div>`}},
 rep:{t:'Report a problem',s:'Save report draft',b:()=>fld('What’s wrong?',`<select name="c">${opts(['Permanently closed','Temporarily closed','Doesn’t exist','Wrong location','Duplicate listing','Inappropriate content'])}</select>`)+fld('Details (optional)','<textarea name="x" rows="3" maxlength="300"></textarea>')}};
const LBL={add:'Added place',rev:'Reviewed',photo:'Photo for',edit:'Edit for',rep:'Reported',roadf:'Road update for',roadm:'Added road',roadn:'Road name for',roadd:'Traffic direction for',roadx:'Drawn incorrectly:',roadp:'Private road:',roadz:'Road does not exist:',roado:'Road issue for',roadc:'Road closed:'};let tg=null;let preRoad=null;
/* choose location on map: pin stays fixed in the centre, the map moves underneath */
let pick=null,prevView=null,prevMap=null;
function initPreview(){
  if(prevMap){prevMap.remove();prevMap=null}
  const el=document.getElementById('mapPrev');if(!el)return;
  const c=pick||map.getCenter();
  prevMap=createMap({container:el,center:[c.lng,c.lat],zoom:16,interactive:false,attributionControl:false,fadeDuration:0});
}
const PICK_BLOCK=new Set(['click','dblclick','contextmenu','mousedown','touchstart']);
const _fire=map.fire.bind(map);
map.fire=(e,d)=>{const ty=typeof e==='string'?e:e&&e.type;return document.body.classList.contains('picking')&&PICK_BLOCK.has(ty)?map:_fire(e,d)};
const pkr=document.createElement('section');pkr.id='picker';pkr.hidden=true;pkr.setAttribute('aria-label','Choose location on map');
pkr.innerHTML=`<header class="pk-top"><button class="ib" id="pkBack" aria-label="Back">${ic(IC.back)}</button><h3>Choose location on map</h3><button class="pk-ok" id="pkOk">OK</button></header>
<div class="pk-pin" aria-hidden="true"><svg width="40" height="50" viewBox="0 0 40 50"><path d="M20 2C10.1 2 2 10.1 2 20c0 13.2 18 28 18 28s18-14.8 18-28C38 10.1 29.9 2 20 2z" fill="#e53935" stroke="#fff" stroke-width="2.5"/><circle cx="20" cy="20" r="5.5" fill="#7f1d1a"/></svg></div>
<div class="pk-ll"><span id="pkLl"></span><small>Move the map to place the pin</small></div>`;
document.body.appendChild(pkr);
const llText=c=>`${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
function openPicker(){
  prevView=map.getCenter();
  map.doubleClickZoom.disable();map.dragRotate.disable();map.touchZoomRotate.disableRotation();map.keyboard.disable();
  if(pick)map.jumpTo({center:[pick.lng,pick.lat]});
  hub.hidden=true;scrim.hidden=true;
  document.body.classList.add('picking');pkr.hidden=false;$('pkLl').textContent=llText(map.getCenter());
}
function leavePicker(save){
  map.doubleClickZoom.enable();map.dragRotate.enable();map.touchZoomRotate.enableRotation();map.keyboard.enable();
  if(save){const c=map.getCenter();pick={lat:c.lat,lng:c.lng}}
  else if(prevView)map.jumpTo({center:prevView});
  document.body.classList.remove('picking');pkr.hidden=true;
  hub.hidden=false;scrim.hidden=false;
  const c2=pick||map.getCenter();const e=hub.querySelector('#mapLl');if(e)e.textContent=llText(c2);if(prevMap)prevMap.jumpTo({center:[c2.lng,c2.lat]});
}
map.on('move',()=>{if(!pkr.hidden)$('pkLl').textContent=llText(map.getCenter())});
$('pkBack').onclick=()=>leavePicker(false);
$('pkOk').onclick=()=>leavePicker(true);
addEventListener('keydown',e=>e.key==='Escape'&&!pkr.hidden&&leavePicker(false));

function view(v,p){
  tg=p||tg;
  releaseContributionPreview();
  if(v==='home'){const L=lvl(me.pts);
    hub.innerHTML=`${hd('Contribute')}<div class="prof"><div class="av" style="--p:${L.f*360}deg"><i>${L.i+1}</i></div><div style="flex:1"><b>${L.n}</b><span>${me.pts} points${L.left?` · ${L.left} to next level`:' · top level'}</span><div class="pg"><i style="width:${L.f*100}%"></i></div></div></div>
    <div class="cg">${['add','photo','edit'].map(k=>`<button class="ct" data-x="${k}"><span>${ic(IC[k],24)}<u>+${PT[k]}</u></span>${FM[k].t}</button>`).join('')}<button class="ct" data-x="road" style="grid-column:1/-1"><span>${ic('<path d="M8 3l-3 18M16 3l3 18M12 4v3M12 10.5v3M12 17v3"/>',24)}<u>+${PT.roadf}</u></span>Update road</button></div>
    <button class="rw" data-x="rep">${ic(IC.rep,18)}Report a problem<u style="margin-left:auto;text-decoration:none">+${PT.rep}</u></button>
    <h3 class="sh-sub">Your contributions</h3>${me.items.length?me.items.slice(0,6).map(i=>`<div class="ci"><b>${LBL[i.v]} ${esc(i.t)}</b><em>Draft</em><u>+${i.pt}</u></div>`).join(''):'<div class="msg" style="padding:6px 0">Nothing yet. Add a missing place to earn your first 50 points.</div>'}`;
  }else{
    if(v!=='add'&&v!=='roadpick'&&!tg)return toast('Open a place first, then contribute to it');
    hub.innerHTML=`${v==='roadpick'?`<div class="sh-head"><h3>${FM[v].t}</h3><button class="ib" data-x="close" aria-label="Close">${ic(IC.x)}</button></div>`:v==='roadf'?`<div class="sh-head"><button class="ib" data-x="rpback" aria-label="Back">${ic(IC.back)}</button><h3>${FM[v].t}</h3><button class="ib" data-x="close" aria-label="Close">${ic(IC.x)}</button></div>`:v==='epick'?`<div class="sh-head"><h3>${FM[v].t}</h3></div>`:v==='edit'?`<div class="sh-head"><button class="ib" data-x="epback" aria-label="Back">${ic(IC.back)}</button><h3>${FM[v].t}</h3><button class="ib" data-x="close" aria-label="Close">${ic(IC.x)}</button></div>`:hd(FM[v].t,1)}<form data-v="${v}">${v!=='add'&&v!=='edit'&&v!=='epick'&&v!=='roadpick'&&v!=='roadf'?`<div class="tp">${esc(tg._t)}</div>`:''}${FM[v].b()}${FM[v].own?'':`<button class="btn p wide">${FM[v].s}</button>`}</form>`;if(v==='add')initPreview()}
  hub.hidden=false;scrim.hidden=false;
}
av.onclick=()=>{tg=cur;view('home')};
hub.addEventListener('submit',e=>{
  e.preventDefault();const f=e.target,v=f.dataset.v,fd=new FormData(f),D=Object.fromEntries(fd);
  const t=v==='add'?D.n:tg._t;
  const details=Object.fromEntries([...fd].filter(([,value])=>typeof value==='string'));
  const center=pick || map.getCenter();
  const coords=v==='add'?[center.lng,center.lat]:[+tg.lon,+tg.lat];
  me.pts+=PT[v];me.items.unshift({v,t,pt:PT[v],details,coords});me.items=me.items.slice(0,20);
  if(v==='add')pick=null;if(v==='edit')preC=null;store.set('me',me);refreshAv();toast('Draft saved on this device');
  view('home');
});
const enableSubmit=()=>{const b=hub.querySelector('.fbar .p');if(b)b.disabled=false};
hub.addEventListener('input',enableSubmit);hub.addEventListener('change',enableSubmit);
hub.addEventListener('change',e=>{
  if(e.target.name!=='p')return;
  const file=e.target.files[0], preview=$('pvw');
  if(!preview)return;
  if(photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl=undefined;
  preview.replaceChildren();
  if(file?.type.startsWith('image/')){
    photoUrl=URL.createObjectURL(file);
    const image=new Image();
    image.alt='Selected photo';
    image.src=photoUrl;
    preview.append(image);
  }
});
document.addEventListener('click',e=>{
  const a=e.target.closest('[data-x]');if(!a)return;const k=a.dataset.x;
  if(k==='close')return closeHub();if(k==='pin')return openPicker();if(k==='edit'&&a.classList.contains('ct'))return openUpd();if(k==='ef'){preC=a.dataset.c;return view('edit',tg)}if(k==='epback')return view('epick',tg);if(k==='rf'){preRoad=a.dataset.c;return preRoad==='Missing road'?openDraw():NRT[preRoad]?openDraw('name',NRT[preRoad]):openUpd('road')}if(k==='rpback')return openUpd('road');if(k==='road'){preRoad=null;return view('roadpick',tg)}if(k==='hrs')return openHours();
  if(k==='sec'){a.classList.toggle('on');const on=a.classList.contains('on');a.firstChild&&(a.innerHTML=(on?ic('<path d="M5 12.5l4.5 4.5L19 7.5"/>',15):'+')+' '+a.textContent.replace(/^[+✓]\s*/,''));const s=hub.querySelector(`[data-sec="${a.dataset.s}"]`);if(s)s.hidden=!on;return}if(k==='home')return view('home');
  if(k==='st'){const n=+a.dataset.n,p=a.parentNode;p.querySelector('input').value=n;[...p.querySelectorAll('button')].forEach((b,i)=>b.classList.toggle('on',i<n));return}
  if(k==='dep'){dep=(dep+1)%4;if(routes)dirCard();return}
  if(k==='opt'){avoid=avoid===a.dataset.o?'':a.dataset.o;go(tm);return}
  if(FM[k])view(k,hub.hidden?cur:tg);
});

/* update place: dedicated map page (map only + close), tap an area, pick a place, then Suggest an edit */
const UP=document.createElement('section');UP.id='updPage';UP.hidden=true;UP.setAttribute('aria-label','Update place');
UP.innerHTML=`<div id="updMap"></div>
<button class="ib glass updClose" id="updClose" aria-label="Close">${ic(IC.x,20)}</button>
<div class="glass updList" id="updList"></div>`;
document.body.appendChild(UP);
let updMap=null,updMk=null,updSeq=0;
let updMode='place';
function openUpd(mode='place'){
  updMode=mode;
  closeHub();
  if(updMap){updMap.remove();updMap=null}
  UP.hidden=false;
  const c=map.getCenter(),z=Math.max(15,map.getZoom());
  updMap=createMap({container:'updMap',center:[c.lng,c.lat],zoom:z,attributionControl:false});
  updMap.on('click',e=>updMode==='road'?findRoad(e.lngLat):findHere(e.lngLat));
  $('updList').innerHTML='';
}
function closeUpd(back){
  UP.hidden=true;
  if(updMap){updMap.remove();updMap=null}
  updMk=null;updSeq++;
  $('updList').innerHTML='';
  if(back)view('home');
}
$('updClose').onclick=()=>closeUpd(true);
async function findHere(ll) {
  const sequence = ++updSeq;
  const pt = updMap.project(ll);
  const seen = new Set();
  const local = visiblePlaces(updMap, [[pt.x-40,pt.y-40],[pt.x+40,pt.y+40]])
    .filter(feature => feature.geometry.type === 'Point' && feature.properties.name)
    .map(mapPlace).filter(place => {
      if (seen.has(place._t)) return false;
      seen.add(place._t);
      return true;
    });
  if (local.length) return renderUpd(local);
  try {
    const rows = await searchIndex();
    if (sequence !== updSeq) return;
    const nearby = rows.filter(row => Math.abs(row[2]-ll.lng) < .003 && Math.abs(row[3]-ll.lat) < .003)
      .map(row => [row, hav([ll.lng,ll.lat], [row[2],row[3]])])
      .filter(([,distance]) => distance < 250).sort((a,b) => a[1]-b[1]);
    renderUpd(nearby.slice(0, 15).map(([row]) => toPlace(row)));
  } catch {
    if (sequence === updSeq) $('updList').textContent = 'Couldn’t load nearby places.';
  }
}
async function findRoad(ll){
  const pt=updMap.project([ll.lng,ll.lat]);
  const feats=updMap.queryRenderedFeatures([[pt.x-30,pt.y-30],[pt.x+30,pt.y+30]]).filter(f=>f.properties&&f.properties.name&&f.geometry&&/LineString/.test(f.geometry.type)&&!/rail|water|path|track|ferry|pier/i.test(f.properties.class||''));
  const seen=new Set(),roads=[];
  feats.forEach(f=>{const n=f.properties.name;if(seen.has(n))return;seen.add(n);roads.push({_t:n,_r:'',type:f.properties.class||'road',category:f.properties.class||'',lon:ll.lng,lat:ll.lat,extratags:{}})});
  const list=$('updList');
  list.innerHTML='';
  if(!roads.length)return;
  list.innerHTML='<div class="hdg">Tap to select the road</div>';
  roads.forEach(p=>{
    const row=document.createElement('div');row.className='row';
    row.innerHTML=`<div class="tx"><b>${esc(p._t)}</b><span>${esc(nice(p.type))}</span></div>`;
    row.onclick=()=>{closeUpd(false);view('roadf',p)};
    list.appendChild(row);
  });
}
function renderUpd(ps){
  const list=$('updList');
  if(!ps.length){list.innerHTML='<div class="msg">No named places here. Tap closer to a shop, office or landmark.</div>';return}
  list.innerHTML='<div class="hdg">Tap to select the place</div>';
  ps.forEach(p=>{
    const [icn,c]=cat(p),row=document.createElement('div');row.className='row';
    row.innerHTML=`<div class="dot" style="--c:${c}">${icn}</div><div class="tx"><b>${esc(p._t)}</b><span>${esc(nice(p.type))}${p._r?' · '+esc(p._r):''}</span></div>`;
    row.onclick=()=>{closeUpd(false);preC=null;view('epick',p)};
    list.appendChild(row);
  });
}


/* ---------- Missing road: move map under a fixed target, snap to nearby roads, draw a line ---------- */
const DR=document.createElement('section');DR.id='drwPage';DR.hidden=true;DR.setAttribute('aria-label','Add a missing road');
DR.innerHTML=`<div id="drwMap"></div>
<button class="ib glass drwClose" id="drwClose" aria-label="Close">${ic(IC.x,20)}</button>
<div id="drwRet" aria-hidden="true"><svg width="32" height="32" viewBox="0 0 32 32"><circle class="rw1" cx="16" cy="16" r="12.5" fill="none" stroke-width="4"/><circle class="rw2" cx="16" cy="16" r="12.5" fill="none" stroke-width="1.8"/><circle class="dot" cx="16" cy="16" r="3.2"/><circle class="rw3" cx="16" cy="16" r="3.2" fill="none" stroke-width="1.8"/></svg></div>
<div id="drwSheet" class="glass"><div class="drwFloat" id="drwFloat"></div><div id="drwBody"></div></div>
<div id="drwDlg" hidden></div>`;
document.body.appendChild(DR);
const DI={undo:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',plus:'<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',trash:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',add:'<path d="M12 5v14M5 12h14"/>'};
const RTYPES=[['Local road','Road providing access to homes, businesses, and other destinations.'],['Highway','Major road. Frequently has heavy, high-speed traffic.'],['Parking lot','Separated parking lot or area. Excludes on-street parking.'],['Biking / walking trail','For use by bikes and pedestrians. Not accessible by vehicles.']];
let dMode='draw',dm=null,dReady=false,dRO=null,dPts=[],dRoads=[],dStep='draw',dDraw=false,dTip=true,dTgt=null,dType=null,dName='',dInfo=false;
const dDesk=()=>matchMedia('(min-width:641px)').matches;
const dSheetH=()=>$('drwSheet').offsetHeight;
/* the target sits in the centre of the part of the map that is not covered by the sheet */
const dTargetPx=()=>{const W=DR.clientWidth,H=DR.clientHeight;
  if(dDesk()){const r=$('drwSheet').getBoundingClientRect().right;return{x:(W+r)/2,y:H/2}}
  return{x:W/2,y:(H-dSheetH())/2}};
const DR_R=16; /* radius of the target's white ring */
function dSnap(){
  const cp=dTargetPx(),R=DR_R;let best=null,bd=1e9;
  const fs=dm.queryRenderedFeatures([[cp.x-R,cp.y-R],[cp.x+R,cp.y+R]]).filter(f=>f.sourceLayer==='transportation'&&/LineString/.test(f.geometry.type)&&!/rail|ferry|aerialway|pier|transit/i.test((f.properties&&f.properties.class)||''));
  fs.forEach(f=>{const g=f.geometry,ls=g.type==='LineString'?[g.coordinates]:g.coordinates;
    ls.forEach(l=>{for(let i=0;i<l.length-1;i++){
      const a=dm.project(l[i]),b=dm.project(l[i+1]),dx=b.x-a.x,dy=b.y-a.y,L2=dx*dx+dy*dy;
      let t=L2?((cp.x-a.x)*dx+(cp.y-a.y)*dy)/L2:0;t=Math.max(0,Math.min(1,t));
      const px=a.x+t*dx,py=a.y+t*dy,d=Math.hypot(cp.x-px,cp.y-py);
      if(d<bd){bd=d;best={x:px,y:py}}}})});
  return best&&bd<=R?{x:best.x,y:best.y,snap:true}:{x:cp.x,y:cp.y,snap:false};
}
const dFC=a=>({type:'FeatureCollection',features:a});
const dLine=c=>({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:c}});
function dSrc(){
  if(!dReady)return;
  const set=(id,f)=>{const sc=dm.getSource(id);sc&&sc.setData(dFC(f))};
  set('ddone',dRoads.filter(r=>r.coords.length>1).map(r=>dLine(r.coords)));
  set('dcur',dPts.length>1?[dLine(dPts)]:[]);
  set('dprev',dStep==='draw'&&dDraw&&dPts.length&&dTgt?[dLine([dPts[dPts.length-1],[dTgt.lng,dTgt.lat]])]:[]);
  set('dpts',dStep==='draw'?dPts.map(c=>({type:'Feature',properties:{},geometry:{type:'Point',coordinates:c}})):[]);
}
function dUpd(){
  if(!dm||!dReady)return;
  const r=$('drwRet'),sr=dMode==='draw'&&dStep==='draw';r.style.display=sr?'':'none';
  if(!sr){dTgt=null;if(dMode==='draw')dSrc();return}
  const s=dSnap(),cp=dTargetPx();
  r.style.left=cp.x+'px';r.style.top=cp.y+'px';
  r.style.transform=`translate(-50%,-50%) translate(${s.x-cp.x}px,${s.y-cp.y}px)`;
  r.classList.toggle('snap',s.snap);
  dTgt=dm.unproject([s.x,s.y]);
  dSrc();
}
function dFit(list){
  const c=list.flat();if(!dm||!c.length)return;
  const b=new maplibregl.LngLatBounds(c[0],c[0]);c.forEach(x=>b.extend(x));
  const pad=dDesk()?{top:90,bottom:60,left:$('drwSheet').getBoundingClientRect().right+50,right:50}:{top:90,left:50,right:50,bottom:dSheetH()+50};
  dm.fitBounds(b,{padding:pad,maxZoom:19,duration:350});
}
const dHead=()=>`<div class="sh-head"><h3>Missing road</h3></div>`;
function dRender(){
  if(dMode==='name')return nRender();
  const b=$('drwBody'),f=$('drwFloat');
  if(dStep==='draw'){
    b.innerHTML=`${dHead()}<p class="fs-p" style="margin:0">${dDraw?'Move the map and tap Add point along the road. Tap Next when you reach the end.':'Move the map so the target is at the start of the road, then tap Start drawing.'}</p><div class="btns"><button class="btn p" data-d="next"${dPts.length<2?' disabled':''}>Next</button></div>`;
    f.innerHTML=dDraw?`<div class="drow"><button class="dfl glass" data-d="undo">${ic(DI.undo,18)}Undo</button><button class="dfl glass" data-d="add">${ic(DI.plus,18)}Add point</button></div>`
      :`${dTip?'<div class="dtip">Tap to start drawing</div>':''}<button class="dfl glass" data-d="start">${ic(DI.plus,18)}Start drawing</button>`;
  }else if(dStep==='detail'){
    f.innerHTML='';
    b.innerHTML=`${dHead()}<label class="fd" style="margin-top:8px"><span>Road name</span><input id="drwName" maxlength="80" placeholder="e.g. 1st Cross St" value="${esc(dName)}"></label>
<div class="dl">Road type <em>(required)</em></div><div class="dlist" role="radiogroup" aria-label="Road type">${RTYPES.map(([k,d])=>`<button type="button" role="radio" aria-checked="${dType===k}" class="dr${dType===k?' on':''}" data-d="type" data-k="${esc(k)}"><i></i><span>${esc(k)}</span><small>${esc(d)}</small></button>`).join('')}</div>
<div class="btns"><button class="btn" data-d="back">Back</button><button class="btn p" data-d="dnext"${dType?'':' disabled'}>Next</button></div>`;
  }else{
    f.innerHTML='';
    b.innerHTML=`${dHead()}${dRoads.map((r,i)=>`<div class="dsum"><div><b>${esc(r.name||'Unnamed road')}</b><span>${esc(r.type)}</span></div><button class="ib" data-d="del" data-i="${i}" aria-label="Delete road">${ic(DI.trash,18)}</button></div>`).join('')}
<div class="btns" style="flex-direction:column"><button class="btn p" data-d="submit">Save draft</button><button class="btn" data-d="another"><span style="display:inline-flex;align-items:center;gap:8px">${ic(DI.add,16)}Add another road</span></button></div>`;
  }
  dUpd();
}
function dAdd(){
  if(!dTgt)return;const p=[dTgt.lng,dTgt.lat],l=dPts[dPts.length-1];
  if(l){const a=dm.project(l),c=dm.project(p);if(Math.hypot(a.x-c.x,a.y-c.y)<6)return}
  dPts.push(p);dDraw=true;dTip=false;dRender();
}
function dUndo(){dPts.pop();if(!dPts.length)dDraw=false;dRender()}
function dSubmit(){
  dRoads.forEach(r=>{me.pts+=PT.roadm;me.items.unshift({v:'roadm',t:r.name||'Road',pt:PT.roadm,details:r})});
  me.items=me.items.slice(0,20);store.set('me',me);refreshAv();
  closeDraw(true);
  toast('Road draft saved on this device');
}
function openDraw(mode='draw',kind='name'){
  closeHub();
  if(dm){dm.remove();dm=null}
  dReady=false;dMode=mode;dPts=[];dRoads=[];dStep=mode==='name'?'ntap':'draw';dDraw=false;dTip=true;dTgt=null;dType=null;dName='';dInfo=false;
  nKind=kind;nDir='';nRsn='Not sure';nWay='';nCx=null;nDraft=null;$('drwDlg').hidden=true;nChains=[];nSel=null;nAll=false;nUser=false;nName='';nUn=false;nSeed=null;nCands=[];nTap=null;nMsg='';nNew='';nDet='';nUnmark();
  DR.hidden=false;dRender();
  const c=map.getCenter(),z=mode==='name'?Math.max(16.5,map.getZoom()):Math.max(17,map.getZoom());
  dm=createMap({container:'drwMap',center:[c.lng,c.lat],zoom:z,attributionControl:false,maxPitch:0});
  dm.on('load',()=>{
    const line=(id,color,w,extra={})=>dm.addLayer({id,type:'line',source:id,layout:{'line-cap':'round','line-join':'round'},paint:Object.assign({'line-color':color,'line-width':w},extra)});
    ['ddone','dcur','dprev','dpts','nroad','nsel'].forEach(id=>dm.addSource(id,{type:'geojson',data:dFC([])}));
    line('nroad','#0a7cff',7,{'line-opacity':.3});dm.addLayer({id:'nselc',type:'line',source:'nsel',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#ffffff','line-width':11}});line('nsel','#0a7cff',6);
    line('ddone','#30b158',6);line('dcur','#0a7cff',6);line('dprev','#ffffff',4,{'line-dasharray':[1,1.6]});
    dm.addLayer({id:'dpts',type:'circle',source:'dpts',paint:{'circle-radius':8,'circle-color':'#ffffff','circle-stroke-color':'#0a7cff','circle-stroke-width':2.5}});
    /* put the starting spot under the target */
    if(dMode==='draw'){const t=dTargetPx();dm.jumpTo({center:dm.unproject([DR.clientWidth-t.x,DR.clientHeight-t.y])})}
    dReady=true;dUpd();
  });
  dm.on('move',dUpd);
  dm.on('click',e=>{if(dMode==='name')nClick(e)});
  if(dRO)dRO.disconnect();
  dRO=new ResizeObserver(dUpd);dRO.observe($('drwSheet'));dRO.observe(DR);
}
function closeDraw(back){
  DR.hidden=true;if(dRO){dRO.disconnect();dRO=null}
  nUnmark();$('drwDlg').hidden=true;if(dm){dm.remove();dm=null}dReady=false;dTgt=null;
  if(back)view('home');
}
$('drwClose').onclick=()=>closeDraw(true);
DR.addEventListener('input',e=>{const id=e.target.id;if(id==='drwName')dName=e.target.value;if(id==='rnDet'){nDet=e.target.value;if(NK[nKind]&&NK[nKind].req){const sb=DR.querySelector('[data-d="nsubmit"]');if(sb)sb.disabled=!nDet.trim()}}if(id==='rnName'){nNew=e.target.value;const b=DR.querySelector('[data-d="nsubmit"]');if(b)b.disabled=!nNew.trim()}});
const nChg=e=>{const t=e.target;if(t.dataset&&t.dataset.n&&nDraft)nDraft[t.dataset.n]=t.value;if(t.id==='rnWay')nWay=t.value};
DR.addEventListener('input',nChg);DR.addEventListener('change',nChg);
DR.addEventListener('click',e=>{
  const a=e.target.closest('[data-d]');if(!a||a.disabled)return;const k=a.dataset.d;
  if(k==='nback')return nBack();
  if(k==='npickc')return nPick(+a.dataset.i);
  if(k==='nedit'){nAll=true;nUser=true;return nForm()}
  if(k==='nnext'){if(!nSelOk())return;return nForm()}
  if(k==='ndir'){nDir=a.dataset.k;DR.querySelectorAll('[data-d="ndir"]').forEach(b=>{const on=b===a;b.classList.toggle('on',on);b.setAttribute('aria-checked',on)});const sb=DR.querySelector('[data-d="nsubmit"]');if(sb)sb.disabled=false;return}
  if(k==='nwhen')return nOpenDlg();
  if(k==='nnow'){nDraft.now=!nDraft.now;nDraft.err='';return nDlg()}
  if(k==='ncancel'){nDraft=null;return nDlg()}
  if(k==='ndone')return nDoneDlg();
  if(k==='nrsn'){nRsn=a.dataset.k;DR.querySelectorAll('[data-d="nrsn"]').forEach(b=>{const on=b===a;b.classList.toggle('on',on);b.setAttribute('aria-checked',on)});return}
  if(k==='nsubmit')return nSubmit();
  if(k==='start'||k==='add')return dAdd();
  if(k==='undo')return dUndo();
  if(k==='next'){if(dPts.length<2)return;dStep='detail';dRender();return requestAnimationFrame(()=>dFit([dPts]))}
  if(k==='type'){dType=a.dataset.k;DR.querySelectorAll('.dr').forEach(b=>{const on=b===a;b.classList.toggle('on',on);b.setAttribute('aria-checked',on)});const n=DR.querySelector('[data-d="dnext"]');if(n)n.disabled=false;return}
  if(k==='back'){dStep='draw';dDraw=dPts.length>0;dRender();return}
  if(k==='dnext'){if(!dType)return;dRoads.push({name:dName.trim(),type:dType,coords:dPts.slice()});dPts=[];dDraw=false;dName='';dType=null;dStep='summary';dRender();return requestAnimationFrame(()=>dFit(dRoads.map(r=>r.coords)))}
  if(k==='del'){dRoads.splice(+a.dataset.i,1);if(!dRoads.length){dStep='draw';dDraw=false}dRender();return}
  if(k==='info'){dInfo=!dInfo;return dRender()}
  if(k==='another'){dStep='draw';dDraw=false;dRender();return}
  if(k==='submit')return dSubmit();
});


/* ---------- Road name: tap road -> pick road -> pick section (or whole road) -> correct name ---------- */
let nChains=[],nSel=null,nAll=false,nUser=false,nName='',nCands=[],nTap=null,nMsg='',nNew='',nDet='',nMk=null,nUn=false,nSeed=null,nKind='name',nHd=[],nDir='',nRsn='Not sure',nWay='',nCx=null,nDraft=null;
const nLbl=()=>nUn?'Unnamed road':nName,nCl=c=>c.u?'Unnamed road':c.n;
const NRT={'Road name':'name','One or two way':'dir','Drawn incorrectly':'bad','Road is private':'priv','Road does not exist':'none','Other':'other','Road closed':'closed'};
const NK={name:{t:'Road name',key:'roadn'},dir:{t:'Traffic direction',key:'roadd'},
  bad:{t:'Drawn incorrectly',key:'roadx',msg:n=>`Report that ${n} is drawn incorrectly`},
  priv:{t:'Road is private',key:'roadp',msg:n=>`Report that ${n} is a private road`},
  none:{t:'Road does not exist',key:'roadz',msg:n=>`Report that ${n} does not exist`},
  closed:{t:'Road closed',key:'roadc'},
  other:{t:'Other',key:'roado',req:1,msg:n=>`What’s wrong with ${n}?`}};
const NRD=/rail|ferry|aerialway|pier|transit/i;
const NMINI='<svg viewBox="0 0 120 56" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="120" height="56" fill="currentColor" opacity=".05"/><path d="M0 22h120v12H0zM52 0h20v56H52z" fill="currentColor" opacity=".14"/><path d="M62 0v56" stroke="var(--solid)" stroke-width="2" stroke-dasharray="5 5"/></svg>';
const nKey=c=>c[0].toFixed(5)+','+c[1].toFixed(5);
const nLinesOf=f=>{const g=f.geometry;return g.type==='LineString'?[g.coordinates]:g.type==='MultiLineString'?g.coordinates:[]};
/* road names live in the 'transportation_name' tile layer; plain 'transportation' has geometry only */
const nNameOf=f=>{const q=f.properties||{};return q.name||q['name:latin']||''};
const nNamed=()=>!dm?.isStyleLoaded()?[]:dm.querySourceFeatures('openmaptiles',{sourceLayer:'transportation_name'}).filter(f=>nNameOf(f)&&!NRD.test((f.properties&&f.properties.class)||''));
const nM=(c,o)=>[(c[0]-o[0])*111320*Math.cos(o[1]*Math.PI/180),(c[1]-o[1])*110540];
function nSeg(m,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],L2=dx*dx+dy*dy;let t=L2?((m[0]-a[0])*dx+(m[1]-a[1])*dy)/L2:0;t=Math.max(0,Math.min(1,t));return{t,d:Math.hypot(m[0]-(a[0]+t*dx),m[1]-(a[1]+t*dy))}}
function nOnChain(c,ll){const m=nM(ll,c.o);let best={d:1e9,pos:0};for(let i=0;i<c.m.length-1;i++){const r=nSeg(m,c.m[i],c.m[i+1]);if(r.d<best.d)best={d:r.d,pos:c.cum[i]+r.t*(c.cum[i+1]-c.cum[i])}}return best}
function nJoin(lines){
  const seen=new Set(),L=[];
  lines.forEach(l=>{if(l.length<2)return;const k=nKey(l[0])+'|'+nKey(l[l.length-1])+'|'+l.length;if(seen.has(k))return;seen.add(k);L.push(l.slice())});
  const deg={};L.forEach(l=>{[nKey(l[0]),nKey(l[l.length-1])].forEach(k=>deg[k]=(deg[k]||0)+1)});
  const ok=k=>deg[k]===2;
  let ch=true;
  while(ch){ch=false;
    for(let i=0;i<L.length&&!ch;i++)for(let j=0;j<L.length&&!ch;j++){
      if(i===j)continue;const a=L[i],b=L[j],ae=nKey(a[a.length-1]),as=nKey(a[0]),bs=nKey(b[0]),be=nKey(b[b.length-1]);
      if(ae===bs&&ok(ae)){L[i]=a.concat(b.slice(1));ch=true}
      else if(ae===be&&ok(ae)){L[i]=a.concat(b.slice(0,-1).reverse());ch=true}
      else if(as===be&&ok(as)){L[i]=b.concat(a.slice(1));ch=true}
      else if(as===bs&&ok(as)){L[i]=b.slice().reverse().concat(a.slice(1));ch=true}
      if(ch)L.splice(j,1);
    }}
  return L;
}
/* names of roads whose centre line passes within R px of the tap */
function nAt(p,R){
  const hit=new Map();
  nNamed().forEach(f=>{const nm=nNameOf(f);nLinesOf(f).forEach(l=>{for(let i=0;i<l.length-1;i++){
    const a=dm.project(l[i]),b=dm.project(l[i+1]),dx=b.x-a.x,dy=b.y-a.y,L2=dx*dx+dy*dy;
    let t=L2?((p.x-a.x)*dx+(p.y-a.y)*dy)/L2:0;t=Math.max(0,Math.min(1,t));
    const d=Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy));if(d<=R&&(!hit.has(nm)||d<hit.get(nm)))hit.set(nm,d)}})});
  return [...hit.entries()].sort((x,y)=>x[1]-y[1]).map(e=>e[0]);
}
/* unnamed roads: plain 'transportation' lines that no named road runs along */
function nNamedSegs(){const sg=[];nNamed().forEach(f=>nLinesOf(f).forEach(l=>{for(let i=0;i<l.length-1;i++)sg.push([l[i],l[i+1]])}));return sg}
function nIsUn(l,segs){
  if(!l.length)return false;let near=0;const pd=.0004;
  l.forEach(v=>{for(const g of segs){
    if(Math.max(g[0][0],g[1][0])<v[0]-pd||Math.min(g[0][0],g[1][0])>v[0]+pd||Math.max(g[0][1],g[1][1])<v[1]-pd||Math.min(g[0][1],g[1][1])>v[1]+pd)continue;
    if(nSeg([0,0],nM(g[0],v),nM(g[1],v)).d<=4){near++;return}}});
  return near/l.length<.5;
}
function nAtAll(p,R){
  const out=nAt(p,R).map(n=>({n,u:false}));
  const segs=nNamedSegs();let best=null,bd=1e9;
  dm.querySourceFeatures('openmaptiles',{sourceLayer:'transportation'}).forEach(f=>{
    if(NRD.test((f.properties&&f.properties.class)||''))return;
    nLinesOf(f).forEach(l=>{let ld=1e9;
      for(let i=0;i<l.length-1;i++){const a=dm.project(l[i]),b=dm.project(l[i+1]),dx=b.x-a.x,dy=b.y-a.y,L2=dx*dx+dy*dy;
        let t=L2?((p.x-a.x)*dx+(p.y-a.y)*dy)/L2:0;t=Math.max(0,Math.min(1,t));
        ld=Math.min(ld,Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy)))}
      if(ld<=R&&ld<bd&&nIsUn(l,segs)){bd=ld;best=l}})});
  if(best)out.push({n:'',u:true,seed:best});
  return out;
}
/* extend the tapped unnamed line through plain continuations (exactly two lines meeting) */
function nUnChain(){
  if(!nSeed)return[];
  const segs=nNamedSegs(),all=[];
  dm.querySourceFeatures('openmaptiles',{sourceLayer:'transportation'}).forEach(f=>{if(NRD.test((f.properties&&f.properties.class)||''))return;nLinesOf(f).forEach(l=>{if(l.length>1)all.push(l)})});
  let chain=nSeed.slice();
  for(let n=0;n<40;n++){
    let grew=false;
    for(const end of [1,0]){
      const k=nKey(end?chain[chain.length-1]:chain[0]);
      const m=all.filter(l=>nKey(l[0])===k||nKey(l[l.length-1])===k);
      const others=m.filter(l=>!(nKey(l[0])===nKey(chain[0])&&nKey(l[l.length-1])===nKey(chain[chain.length-1])&&l.length===chain.length));
      if(others.length!==1||!nIsUn(others[0],segs))continue;
      const o=others[0],atStart=nKey(o[0])===k;
      const piece=atStart?o.slice(1):o.slice(0,-1).reverse();
      chain=end?chain.concat(piece):piece.reverse().concat(chain);grew=true;
    }
    if(!grew)break;
  }
  return [chain];
}
function nBuild(){
  let mine=[];if(nUn)mine=nUnChain();else nNamed().forEach(f=>{if(nNameOf(f)===nName)nLinesOf(f).forEach(l=>mine.push(l))});
  const others=[];dm.querySourceFeatures('openmaptiles',{sourceLayer:'transportation'}).forEach(f=>{if(/rail|ferry|aerialway|pier|transit|service|track|path|raceway/i.test((f.properties&&f.properties.class)||''))return;nLinesOf(f).forEach(l=>others.push(l))});
  nChains=nJoin(mine).map(pts=>{
    const o=pts[0],m=pts.map(c=>nM(c,o)),cum=[0];
    for(let i=1;i<m.length;i++)cum.push(cum[i-1]+Math.hypot(m[i][0]-m[i-1][0],m[i][1]-m[i-1][1]));
    const c={pts,o,m,cum,len:cum[cum.length-1],J:[]};
    let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;pts.forEach(q=>{x0=Math.min(x0,q[0]);x1=Math.max(x1,q[0]);y0=Math.min(y0,q[1]);y1=Math.max(y1,q[1])});
    const pad=.0004,cand=[];
    others.forEach(l=>{
      const hits=[];let near=0;
      l.forEach(v=>{if(v[0]<x0-pad||v[0]>x1+pad||v[1]<y0-pad||v[1]>y1+pad)return;const r=nOnChain(c,v);if(r.d<=3){near++;hits.push(r.pos)}});
      if(!hits.length)return;
      if(l.length>=2&&near/l.length>=.5)return; /* this is the road itself, not a crossing road */
      hits.forEach(h=>cand.push(h));
    });
    cand.sort((u,v)=>u-v);
    const mpp=78271.517*Math.cos(c.o[1]*Math.PI/180)/Math.pow(2,dm.getZoom()),minL=Math.max(80,70*mpp);
    const J=[0];cand.forEach(d=>{if(d-J[J.length-1]>=minL&&c.len-d>=minL)J.push(d)});J.push(c.len);
    c.J=J;return c;
  }).filter(c=>c.len>=5);
  if(!nUser)nAuto();
  nSrc();
}
function nNear(pt){
  let best=null,bd=1e9;
  nChains.forEach((c,ci)=>{for(let i=0;i<c.pts.length-1;i++){
    const a=dm.project(c.pts[i]),b=dm.project(c.pts[i+1]),dx=b.x-a.x,dy=b.y-a.y,L2=dx*dx+dy*dy;
    let t=L2?((pt.x-a.x)*dx+(pt.y-a.y)*dy)/L2:0;t=Math.max(0,Math.min(1,t));
    const d=Math.hypot(pt.x-(a.x+t*dx),pt.y-(a.y+t*dy));
    if(d<bd){bd=d;best={ci,d,pos:c.cum[i]+t*(c.cum[i+1]-c.cum[i])}}}});
  return best;
}
const nSecOf=(ci,pos)=>{const J=nChains[ci].J;let k=0;for(let i=0;i<J.length-1;i++)if(J[i]<=pos)k=i;return k};
function nAuto(){
  nSel=null;if(!nTap||!nChains.length)return;
  const b=nNear(dm.project(nTap));if(!b)return;const k=nSecOf(b.ci,b.pos);nSel={c:b.ci,k0:k,k1:k};
}
const nSelOk=()=>nAll||!!nSel;
const nLen=m=>m<1000?Math.round(m/5)*5+' m':(m/1000).toFixed(1)+' km';
function nHint(){
  if(!nSel||!nChains[nSel.c])return 'Tap the road to select a section to fix.';
  const c=nChains[nSel.c],sel=c.J[nSel.k1+1]-c.J[nSel.k0],K=c.J.length-1;
  let t=`Selected ${nLen(sel)} of ${nLen(c.len)}.`;
  if(K>1)t+=' Tap + to add the next part, − to remove an end part.';
  if(nChains.length>1)t+=' Tap another branch to switch to it.';
  return t;
}
function nSub(c,a,b){
  const P=d=>{let i=0;while(i<c.cum.length-2&&c.cum[i+1]<d)i++;const l=c.cum[i+1]-c.cum[i],t=l?(d-c.cum[i])/l:0,A=c.pts[i],B=c.pts[i+1];return[A[0]+(B[0]-A[0])*t,A[1]+(B[1]-A[1])*t]};
  const out=[P(a)];for(let i=0;i<c.pts.length;i++)if(c.cum[i]>a&&c.cum[i]<b)out.push(c.pts[i]);out.push(P(b));return out;
}
function nSelCoords(){
  if(nAll)return nChains.map(c=>c.pts);
  if(!nSel||!nChains[nSel.c])return[];const c=nChains[nSel.c];return[nSub(c,c.J[nSel.k0],c.J[nSel.k1+1])];
}
function nSrc(){
  if(!dReady||dMode!=='name')return;
  const on=dStep==='nsec'||dStep==='nform',set=(id,f)=>{const sc=dm.getSource(id);sc&&sc.setData(dFC(f))};
  set('nroad',on&&dStep==='nsec'?nChains.map(c=>dLine(c.pts)):[]);
  set('nsel',on?nSelCoords().filter(l=>l.length>1).map(dLine):[]);
  nHandles();
}
function nMark(ll,name){nUnmark();const el=document.createElement('div');el.className='nmk';el.innerHTML=`<i></i><span>${esc(name)}</span>`;nMk=new maplibregl.Marker({element:el}).setLngLat(ll).addTo(dm)}
function nUnmark(){if(nMk){nMk.remove();nMk=null}nClearHd()}
function nClearHd(){nHd.forEach(m=>m.remove());nHd=[]}
function nPt(c,d){let i=0;while(i<c.cum.length-2&&c.cum[i+1]<d)i++;const l=c.cum[i+1]-c.cum[i],t=l?(d-c.cum[i])/l:0,A=c.pts[i],B=c.pts[i+1];return[A[0]+(B[0]-A[0])*t,A[1]+(B[1]-A[1])*t]}
/* + / - handles sit at the middle of the sections next to / at the ends of the selection */
function nHandles(){
  nClearHd();
  if(!dm||dMode!=='name'||dStep!=='nsec'||!nSel||nAll||!nChains[nSel.c])return;
  const c=nChains[nSel.c],K=c.J.length-1;
  const mk=(k,add)=>{
    const el=document.createElement('button');el.type='button';el.className='nhd';el.setAttribute('aria-label',add?'Add this section':'Remove this section');
    el.innerHTML=ic(add?DI.add:'<path d="M5 12h14"/>',20);
    el.addEventListener('click',ev=>{ev.stopPropagation();nStepSel(k,add)});
    nHd.push(new maplibregl.Marker({element:el}).setLngLat(nPt(c,(c.J[k]+c.J[k+1])/2)).addTo(dm));
  };
  if(nSel.k0>0)mk(nSel.k0-1,true);
  if(nSel.k1<K-1)mk(nSel.k1+1,true);
  if(nSel.k1>nSel.k0){mk(nSel.k0,false);mk(nSel.k1,false)}
}
function nStepSel(k,add){
  if(add){nSel.k0=Math.min(nSel.k0,k);nSel.k1=Math.max(nSel.k1,k)}
  else if(k===nSel.k0)nSel.k0++;else nSel.k1--;
  nAll=false;nUser=true;nRender();
}
function nRender(){
  const b=$('drwBody');$('drwFloat').innerHTML='';
  const back=`<button class="ib" data-d="nback" aria-label="Back">${ic(IC.back,20)}</button>`;
  if(dStep==='ntap'){
    b.innerHTML=`<div class="sh-head"><h3>${NK[nKind].t}</h3></div><p class="fs-p" style="margin:0">${nMsg?esc(nMsg):'Tap the road you want to edit.'}</p>`;
  }else if(dStep==='npick'){
    b.innerHTML=`<div class="sh-head">${back}<h3 style="font-size:16px">Select the road you want to edit</h3></div><div class="ncards">${nCands.map((c,i)=>`<button type="button" class="ncard" data-d="npickc" data-i="${i}">${NMINI}<span>${esc(nCl(c))}</span></button>`).join('')}</div>`;
  }else if(dStep==='nsec'){
    b.innerHTML=`<div class="sh-head">${back}<h3>${esc(nLbl())}</h3></div><p class="fs-p" style="margin:0">${nHint()}</p><div class="btns" style="flex-direction:column"><button class="btn" data-d="nedit">Edit entire road</button><button class="btn p" data-d="nnext"${nSelOk()?'':' disabled'}>Next</button></div>`;
  }else if(nKind==='closed'){
    const CAL='<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',WARN='<path d="M12 4 3 20h18z"/><path d="M12 10v4M12 17v.5"/>';
    b.innerHTML=`<div class="sh-head">${back}<h3>Road closed</h3></div><p class="fs-p" style="margin:0 0 6px">Add more details (optional)</p>
<button type="button" class="pr2" data-d="nwhen"><span class="pi">${ic(CAL,20)}</span><span class="pt" style="white-space:normal"><b style="display:block;font-size:13.5px">When</b><small style="color:var(--sub);font-weight:500;font-size:12.5px">${esc(nWhenTxt())}</small></span><i>›</i></button>
<div class="dl" style="display:flex;align-items:center;gap:8px;color:var(--ink)"><span style="color:var(--sub);display:inline-flex">${ic(WARN,16)}</span>Reason</div><div class="dlist" role="radiogroup" aria-label="Reason">${['Construction','Crash','Local Event','Nature','Not sure'].map(k=>`<button type="button" role="radio" aria-checked="${nRsn===k}" class="dr${nRsn===k?' on':''}" data-d="nrsn" data-k="${k}"><i></i><span>${k}</span></button>`).join('')}</div>
<label class="fd"><span>Which way is closed?</span><select id="rnWay"><option value="">Select an option</option>${['Both ways','One way only'].map(k=>`<option${nWay===k?' selected':''}>${k}</option>`).join('')}</select></label>
<label class="fd"><span>Further details (optional)</span><input id="rnDet" maxlength="200" placeholder="Add more details" value="${esc(nDet)}"></label><div class="btns"><button class="btn p" data-d="nsubmit">Save draft</button></div>`;
  }else if(nKind==='dir'){
    b.innerHTML=`<div class="sh-head">${back}<h3>Traffic direction</h3></div><p class="fs-p" style="margin:0 0 2px">Correct traffic direction${nUn?'':` for <b style="color:var(--ink)">${esc(nName)}</b>`}</p><div class="dlist" role="radiogroup" aria-label="Traffic direction">${['Two-way','One-way'].map(k=>`<button type="button" role="radio" aria-checked="${nDir===k}" class="dr${nDir===k?' on':''}" data-d="ndir" data-k="${k}"><i></i><span>${k}</span></button>`).join('')}</div><label class="fd"><span>Further details (optional)</span><input id="rnDet" maxlength="200" placeholder="Add details" value="${esc(nDet)}"></label><div class="btns"><button class="btn p" data-d="nsubmit"${nDir?'':' disabled'}>Save draft</button></div>`;
  }else if(nKind!=='name'){
    const K=NK[nKind],nm=`<b style="color:var(--ink)">${esc(nLbl())}</b>`;
    b.innerHTML=`<div class="sh-head">${back}<h3>${K.t}</h3></div><p class="fs-p" style="margin:0 0 2px">${K.msg(nm)}</p><label class="fd"><span>${K.req?'Details (required)':'Further details (optional)'}</span><input id="rnDet" maxlength="200" placeholder="${K.req?'Describe the problem':'Add details'}" value="${esc(nDet)}"></label><div class="btns"><button class="btn p" data-d="nsubmit"${K.req&&!nDet.trim()?' disabled':''}>Save draft</button></div>`;
  }else{
    b.innerHTML=`<div class="sh-head">${back}<h3>Road name</h3></div><p class="fs-p" style="margin:0 0 2px">${nUn?'What’s the name of this road?':`What’s the correct name for <b style="color:var(--ink)">${esc(nName)}</b>?`}</p><label class="fd"><span>${nUn?'Road name':'Correct road name'}</span><input id="rnName" maxlength="80" placeholder="${nUn?'Type road name':'Type correct road name'}" value="${esc(nNew)}"></label><label class="fd"><span>Further details (optional)</span><input id="rnDet" maxlength="200" placeholder="Add details" value="${esc(nDet)}"></label><div class="btns"><button class="btn p" data-d="nsubmit"${nNew.trim()?'':' disabled'}>Save draft</button></div>`;
  }
  nSrc();dUpd();
}
function nClick(e){
  if(!dReady) return;
  if(dStep==='ntap'||dStep==='npick'){
    const names=nAtAll(e.point,22);
    if(!names.length){nMsg='No named road there. Tap closer to a road.';if(dStep==='ntap')nRender();return}
    nMsg='';nCands=names;nTap=e.lngLat;dStep='npick';nMark(e.lngLat,nCl(names[0]));nRender();
    dm.easeTo({center:e.lngLat,zoom:Math.max(dm.getZoom(),17.5),offset:[0,-dSheetH()/2],duration:400});
  }else if(dStep==='nsec'){
    const b=nNear(e.point);if(!b||b.d>30)return;
    const k=nSecOf(b.ci,b.pos);
    nSel={c:b.ci,k0:k,k1:k};
    nAll=false;nUser=true;nRender();
  }
}
function nPick(i){
  nName=nCands[i].n;nUn=!!nCands[i].u;nSeed=nCands[i].seed||null;nUnmark();nAll=false;nUser=false;nBuild();dStep='nsec';nRender();
  const openMap=dm;
  openMap.once('moveend',()=>openMap.once('idle',()=>{if(dm===openMap&&dStep==='nsec'&&!nUser)nBuild()}));
  requestAnimationFrame(()=>dFit(nChains.map(c=>c.pts)));
}
function nForm(){dStep='nform';nRender();requestAnimationFrame(()=>dFit(nSelCoords()))}
function nBack(){
  if(dStep==='nform'){dStep='nsec';nRender();requestAnimationFrame(()=>dFit(nChains.map(c=>c.pts)))}
  else if(dStep==='nsec'){dStep='npick';nSrc();nMark(nTap,nCl(nCands[0]));nRender()}
  else if(dStep==='npick'){dStep='ntap';nUnmark();nRender()}
}
const nPad=n=>String(n).padStart(2,'0');
const nToday=()=>{const d=new Date();return d.getFullYear()+'-'+nPad(d.getMonth()+1)+'-'+nPad(d.getDate())};
const nNowT=()=>{const d=new Date();return nPad(d.getHours())+':'+nPad(d.getMinutes())};
const nFmt=(d,t)=>new Date(d+'T'+t).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const nWhenTxt=()=>!nCx?'Add closure dates and times':nCx.now?`Closed now · until ${nFmt(nCx.ed,nCx.et)}`:`${nFmt(nCx.sd,nCx.st)} – ${nFmt(nCx.ed,nCx.et)}`;
function nDlg(){
  const el=$('drwDlg');if(!nDraft){el.hidden=true;return}
  const d=nDraft,dt=(p,l)=>`<div class="ndt"><label class="fd"><span>${l}</span><input type="date" data-n="${p}d" value="${d[p+'d']}"></label><label class="fd"><span>Time</span><input type="time" data-n="${p}t" value="${d[p+'t']}"></label></div>`;
  el.innerHTML=`<div class="ndc" role="dialog" aria-label="Add closure dates and times"><h3 class="sh-sub" style="margin:0 0 12px">Add closure dates and times</h3><div class="nrow"><span>Closed now?</span><button type="button" class="nsw" role="switch" aria-checked="${d.now}" aria-label="Closed now" data-d="nnow"></button></div><h4 class="fs-h" style="margin:14px 0 0">${d.now?'When will the closure end?':'Add details (optional)'}</h4>${d.now?dt('e','End date'):dt('s','Start date')+dt('e','End date')}${d.err?`<p class="dinfo" style="color:#e5484d">${d.err}</p>`:''}<div class="btns"><button class="btn" data-d="ncancel">Cancel</button><button class="btn p" data-d="ndone">Done</button></div></div>`;
  el.hidden=false;
}
function nOpenDlg(){nDraft=nCx?Object.assign({},nCx):{now:true,sd:nToday(),st:nNowT(),ed:nToday(),et:'23:59'};nDlg()}
function nDoneDlg(){
  const d=nDraft,e=new Date(d.ed+'T'+d.et),st=d.now?new Date():new Date(d.sd+'T'+d.st);
  if(isNaN(e)||(!d.now&&isNaN(st))){d.err='Choose a valid date and time.';return nDlg()}
  if(e<=st){d.err='The end must be after the start.';return nDlg()}
  nCx={now:d.now,sd:d.sd,st:d.st,ed:d.ed,et:d.et};nDraft=null;nDlg();nRender();
}
function nSubmit(){
  const K=NK[nKind];
  if(nKind==='dir'?!nDir:nKind==='name'?!nNew.trim():(K.req&&!nDet.trim()))return;
  const key=K.key;
  me.pts+=PT[key];me.items.unshift({v:key,t:nLbl(),pt:PT[key], details:{ coordinates:nSelCoords(), name:nNew, note:nDet, direction:nDir, reason:nRsn, way:nWay, closure:nCx }});me.items=me.items.slice(0,20);
  store.set('me',me);refreshAv();closeDraw(true);
  toast('Road draft saved on this device');
}

/* ---------- Hours: Hours screen + Select days & time dialog ---------- */
const HD=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],HL=['S','M','T','W','T','F','S'];
const HRS_PEN='<path d="M4 20h4L19 9l-4-4L4 16z"/>';
let HRS=HD.map(()=>({st:'none',r:[]})),SNAP=null,hdSel=new Set(),hdS={};
const hrsSum=d=>d.st==='open24'?'Open 24 hours':d.st==='closed'?'Closed':d.st==='hours'?d.r.map(x=>x.o+'–'+x.c).join(', '):'';
const hrsText=()=>HD.map((n,i)=>HRS[i].st==='none'?'':n.slice(0,3)+' '+hrsSum(HRS[i])).filter(Boolean).join('; ');
const hbtnInner=()=>`<span class="${hrsText()?'':'ph'}">${esc(hrsText()||'Add hours')}</span>${ic(HRS_PEN,16)}`;
const hbtn=()=>`<button type="button" class="hbtn" data-x="hrs">${hbtnInner()}</button><input type="hidden" name="h" value="${esc(hrsText())}">`;
function refreshHrs(){
  document.querySelectorAll('.hbtn').forEach(b=>b.innerHTML=hbtnInner());
  document.querySelectorAll('input[name="h"]').forEach(i=>i.value=hrsText());
}
const HP=document.createElement('section');HP.id='hrsPanel';HP.hidden=true;HP.setAttribute('aria-label','Hours');document.body.appendChild(HP);
function drawHours(){
  HP.innerHTML=`<div class="hp-top"><h3>Hours</h3><button class="ib" data-hx="cancel" aria-label="Close">${ic(IC.x)}</button></div>
  <div>${HD.map((n,i)=>`<div class="hp-row"><span>${n}</span><span class="hp-v${HRS[i].st==='none'?' ph':''}">${esc(hrsSum(HRS[i])||'Add hours')}</span><button class="ib" data-hx="edit" data-i="${i}" aria-label="Edit ${n}">${ic(HRS_PEN,18)}</button></div>`).join('')}</div>
  <div class="hp-chips"><button data-hx="preset" data-p="all">Edit all hours</button><button data-hx="preset" data-p="wkday">Edit Mon–Fri</button><button data-hx="preset" data-p="wkend">Edit Sat–Sun</button></div>
  <div class="hp-foot"><button class="btn" data-hx="cancel">Cancel</button><button class="btn p" data-hx="save">Save</button></div>
  <div id="hdDlg" hidden></div>`;
}
function openHours(){SNAP=JSON.parse(JSON.stringify(HRS));drawHours();HP.hidden=false}
function openDlg(days){
  hdSel=new Set(days);const d=HRS[days[0]];
  hdS={o:d.st==='open24',c:d.st==='closed',r:d.st==='hours'&&d.r.length?d.r.map(x=>({...x})):[{o:'',c:''}]};
  drawDlg();
}
function drawDlg(){
  const el=document.getElementById('hdDlg');el.hidden=false;
  const days=HL.map((l,i)=>`<button type="button" class="hd-day${hdSel.has(i)?' on':''}" data-hx="day" data-i="${i}">${l}</button>`).join('');
  const ranges=hdS.r.map((x,i)=>`<div class="hd-rg"><label class="hd-tf"><span>Open time</span><input type="time" data-hx-r="o" data-i="${i}" value="${x.o}"></label><label class="hd-tf"><span>Close time</span><input type="time" data-hx-r="c" data-i="${i}" value="${x.c}"></label>${hdS.r.length>1?`<button type="button" class="ib" data-hx="rm" data-i="${i}" aria-label="Remove">${ic(IC.x,16)}</button>`:''}</div>`).join('');
  el.innerHTML=`<div class="hd-card"><div class="hd-body"><h4>Select days &amp; time</h4><div class="hd-days">${days}</div>
  <div class="hd-opts"><label><input type="checkbox" data-hx-k="o"${hdS.o?' checked':''}>Open 24 hours</label><label><input type="checkbox" data-hx-k="c"${hdS.c?' checked':''}>Closed</label></div>
  ${hdS.o||hdS.c?'':ranges+'<button type="button" class="hd-add" data-hx="add">Add hours</button>'}</div>
  <div class="hd-foot"><button type="button" class="btn" data-hx="dcancel">Cancel</button><button type="button" class="btn p" data-hx="dsave">Save</button></div></div>`;
}
const PRESET={all:[0,1,2,3,4,5,6],wkday:[1,2,3,4,5],wkend:[0,6]};
HP.addEventListener('click',e=>{
  const t=e.target.closest('[data-hx]');if(!t)return;
  const k=t.dataset.hx,i=+t.dataset.i;
  if(k==='cancel'){HRS=SNAP;HP.hidden=true;refreshHrs();return}
  if(k==='save'){HP.hidden=true;refreshHrs();return}
  if(k==='edit')return openDlg([i]);
  if(k==='preset')return openDlg(PRESET[t.dataset.p]);
  if(k==='day'){hdSel.has(i)?hdSel.delete(i):hdSel.add(i);return drawDlg()}
  if(k==='add'){hdS.r.push({o:'',c:''});return drawDlg()}
  if(k==='rm'){hdS.r.splice(i,1);return drawDlg()}
  if(k==='dcancel'){document.getElementById('hdDlg').hidden=true;return}
  if(k==='dsave'){
    if(!hdSel.size)return toast('Choose at least one day');
    const st=hdS.o?'open24':hdS.c?'closed':'hours';
    if(st==='hours'&&hdS.r.some(x=>!x.o||!x.c))return toast('Enter open and close times');
    hdSel.forEach(d=>HRS[d]={st,r:st==='hours'?hdS.r.map(x=>({...x})):[]});
    drawHours();
  }
});
HP.addEventListener('change',e=>{
  const k=e.target.dataset.hxK;if(!k)return;
  hdS[k]=e.target.checked;
  if(e.target.checked)hdS[k==='o'?'c':'o']=false;
  drawDlg();
});
HP.addEventListener('input',e=>{
  const k=e.target.dataset.hxR;if(!k)return;
  hdS.r[+e.target.dataset.i][k]=e.target.value;
});
})();

/* ---------- weather pill (Open-Meteo, current conditions at map centre) ---------- */
(()=>{
  const pill=document.getElementById('wx'),T=document.getElementById('wxT'),I=document.getElementById('wxI');
  const ICON={sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    cloud:'<path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.2 3.2 0 0 0 7 18z"/>',
    rain:'<path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.2 3.2 0 0 0 7 14z"/><path d="M8 18v2M12 18v2M16 18v2"/>',
    storm:'<path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.2 3.2 0 0 0 7 14z"/><path d="M12 15l-2 4h3l-2 3"/>'};
  const kind=c=>c===0||c===1?'sun':c<=3||(c>=45&&c<=48)?'cloud':c>=95?'storm':c>=51?'rain':'cloud';
  async function load(){
    const c=map.getCenter();
    try{
      const u=`https://api.open-meteo.com/v1/forecast?latitude=${c.lat.toFixed(3)}&longitude=${c.lng.toFixed(3)}&current=temperature_2m,weather_code&timezone=auto`;
      const r=await fetch(u);if(!r.ok)throw 0;
      const d=(await r.json()).current;
      T.textContent=Math.round(d.temperature_2m)+'°C';
      I.innerHTML=ICON[kind(d.weather_code)];
      pill.hidden=false;
    }catch(e){pill.hidden=true}
  }
  map.once('load',load);
  let timer;
  map.on('moveend',()=>{clearTimeout(timer);timer=setTimeout(load,1200);});
  setInterval(load,10*60*1000);
})();

/* Google Maps style dual scale. Measure along the screen's centre line so
   pitch, bearing and latitude are included in the ground-distance calculation. */
class GoogleScaleControl {
  constructor(options = {}) { this.maxWidth = options.maxWidth || 100; this._update = this._update.bind(this); }
  onAdd(map) {
    this._map = map;
    this._el = document.createElement("div");
    this._el.id = "scaleBox";
    this._el.className = "gscale";
    this._el.setAttribute("role", "img");
    this._el.setAttribute("aria-label", "Map distance scale");
    this._el.innerHTML = `<i class="gs-line"></i><i class="gs-ti"></i><i class="gs-mi"></i><span class="gs-lbl gs-li"></span><span class="gs-lbl gs-lm"></span>`;
    const q = s => this._el.querySelector(s);
    this._lblTop = q(".gs-li");
    this._lblBot = q(".gs-lm");
    map.on("move", this._update);
    map.on("resize", this._update);
    map.on("load", this._update);
    this._update();
    return this._el;
  }
  onRemove() {
    this._map.off("move", this._update);
    this._map.off("resize", this._update);
    this._map.off("load", this._update);
    this._el.remove();
    this._map = undefined;
  }
  _nice(n) {
    const p = 10 ** Math.floor(Math.log10(n)), d = n / p;
    return p * (d >= 5 ? 5 : d >= 2 ? 2 : 1);
  }
  _fmt(n) { return String(parseFloat(n.toPrecision(6))); }
  _update() {
    const map = this._map;
    if (!map || !map.getContainer().clientHeight) return;
    const y = map.getContainer().clientHeight / 2;
    const maxMeters = map.unproject([0, y]).distanceTo(map.unproject([this.maxWidth, y]));
    if (!Number.isFinite(maxMeters) || maxMeters <= 0) return;
    let mVal, mUnit, mPx;
    if (maxMeters >= 1000) {
      mVal = this._nice(maxMeters / 1000); mUnit = "km"; mPx = mVal * 1000 / maxMeters * this.maxWidth;
    } else {
      mVal = this._nice(maxMeters); mUnit = "m"; mPx = mVal / maxMeters * this.maxWidth;
    }
    const maxFeet = maxMeters * 3.28084;
    let iVal, iUnit, iPx;
    if (maxFeet >= 5280) {
      iVal = this._nice(maxFeet / 5280); iUnit = "mi"; iPx = iVal * 5280 / maxFeet * this.maxWidth;
    } else {
      iVal = this._nice(maxFeet); iUnit = "ft"; iPx = iVal / maxFeet * this.maxWidth;
    }
    const w = Math.max(iPx, mPx), s = this._el.style;
    s.setProperty("--i", `${iPx}px`);
    s.setProperty("--m", `${mPx}px`);
    s.setProperty("--w", `${w}px`);
    s.width = `${w}px`;
    this._lblTop.textContent = `${this._fmt(iVal)} ${iUnit}`;
    this._lblBot.textContent = `${this._fmt(mVal)} ${mUnit}`;
    this._el.setAttribute("aria-label", `${this._lblTop.textContent}, ${this._lblBot.textContent}`);
  }
}
document.body.appendChild(new GoogleScaleControl({ maxWidth: 100 }).onAdd(map));

/* ---------- search: expands to a bottom sheet while focused; swipe the pill to close ---------- */
(() => {
  const panel = $('panel'), grab = panel.querySelector('.sgrab');
  const EASE = 'transform .3s cubic-bezier(.2,.8,.2,1)';
  const isOpen = () => document.body.classList.contains('search-open');
  const finish = () => {
    document.body.classList.remove('search-open');
    panel.style.removeProperty('transition'); panel.style.transform = '';
    clearTimeout(timer); ctl?.abort(); clearFound();
    q.blur();
  };
  /* animate the sheet down, then drop the expanded state */
  window.collapseSearch = (animate = true) => {
    if (!isOpen()) return;
    if (!animate) return finish();
    panel.style.setProperty('transition', EASE, 'important');
    panel.style.transform = 'translateY(100%)';
    setTimeout(finish, 300);
  };
  q.addEventListener('focus', () => document.body.classList.add('search-open'));
  grab.onclick = e => { if (e.detail === 0) collapseSearch(true); };
  $('sClose').onclick = () => { q.value = ''; $('clear').hidden = true; home(); collapseSearch(true); };
  addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) collapseSearch(true); });
  map.on('click', () => { if (isOpen() && !q.value) collapseSearch(true); });

  /* swipe the grab pill down: follow the finger, then close or snap back */
  let d = null, moved = false;
  grab.addEventListener('pointerdown', e => {
    if (!isOpen()) return;
    d = { y: e.clientY, t: performance.now() }; moved = false;
    grab.setPointerCapture(e.pointerId);
    panel.style.setProperty('transition', 'none', 'important');
  });
  grab.addEventListener('pointermove', e => {
    if (!d) return;
    const dy = Math.max(0, e.clientY - d.y);
    if (dy > 4) moved = true;
    panel.style.transform = `translateY(${dy}px)`;
  });
  const release = e => {
    if (!d) return;
    const dy = Math.max(0, e.clientY - d.y), v = dy / (performance.now() - d.t + 1);
    d = null;
    if (!moved) return;
    if (dy > panel.offsetHeight * 0.22 || v > 0.5) return collapseSearch(true);
    panel.style.setProperty('transition', EASE, 'important');                 /* snap back to fully open */
    panel.style.transform = '';
    setTimeout(() => panel.style.removeProperty('transition'), 300);
  };
  grab.addEventListener('pointerup', release);
  grab.addEventListener('pointercancel', release);
})();
/* ---------- microphone in the search bar: voice search ---------- */
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = document.createElement('button');
  mic.type = 'button';
  mic.className = 'ib';
  mic.id = 'mic';
  mic.setAttribute('aria-label', 'Voice search');
  mic.title = 'Voice search';
  mic.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14.5a3.2 3.2 0 0 0 3.2-3.2V5.7a3.2 3.2 0 0 0-6.4 0v5.6a3.2 3.2 0 0 0 3.2 3.2z"/><path d="M18.5 11.3a6.5 6.5 0 0 1-13 0M12 17.8V21M8.8 21h6.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  document.querySelector('.bar').appendChild(mic);
  mic.onclick = () => {
    if (!SR) return toast('Voice search is not supported in this browser');
    const r = new SR();
    r.lang = 'en-US';
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = e => { q.value = e.results[0][0].transcript; q.dispatchEvent(new Event('input')); };
    r.onerror = () => toast('Could not hear that. Try again.');
    try { r.start(); document.body.classList.add('search-open'); } catch (e) { toast('Voice search is unavailable right now'); }
  };
})();

map.once('load', async () => {
  const params = new URL(location.href).searchParams;
  try {
    const id = params.get('place');
    if (id) {
      const row = (await searchIndex()).find(item => String(item[0]) === id);
      if (row) select(toPlace(row), !hasHash);
    } else if (params.get('pin') === '1' && hasHash) drop(map.getCenter());
  } catch { toast('Couldn’t load this shared place'); }
});
