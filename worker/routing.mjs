const missing = 0xffffffff;
const metersPerDegree = 111195;
const routingModes = ['drive', 'walk', 'cycle'];
const graphPrefix = 'lkmaps/routing/v1/';
const gridWidth = 500;
const gridHeight = 600;

export class RoutingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseRoutingGraph(buffer) {
  if (buffer.byteLength > 80 * 1024 ** 2 || new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== 'SIFRIC02') {
    throw new Error('Invalid routing graph.');
  }
  let offset = 12;
  function column(Type = Uint32Array) {
    const length = new DataView(buffer, offset, 4).getUint32(0, true);
    const values = new Type(buffer, offset + 4, length);
    offset += 4 + values.byteLength;
    return values;
  }
  const side = () => ({ offsets: column(), heads: column(), weights: column(), first: column(), second: column() });
  const graph = {
    ranks: column(), terminalNodes: column(), terminalRanks: column(), cells: column(), cellNodes: column(),
    lon: column(Float32Array), lat: column(Float32Array), forward: side(), backward: side(),
    transitions: column(), heads: column(), meters: column(),
    geometryOffsets: column(), geometryLengths: column(), shapeBoundaries: column(),
  };
  if (offset !== buffer.byteLength || graph.cells.length !== gridWidth * gridHeight + 1 ||
      graph.lon.length !== graph.ranks.length || graph.lat.length !== graph.ranks.length ||
      graph.terminalRanks.length !== graph.terminalNodes.length || graph.heads.length !== graph.meters.length || graph.geometryOffsets.length !== graph.heads.length ||
      graph.geometryLengths.length !== graph.heads.length || graph.shapeBoundaries.length !== 121) throw new Error('Invalid routing graph layout.');
  return graph;
}

function lowerBound(values, key) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (values[mid] < key) left = mid + 1;
    else right = mid;
  }
  return left;
}

function nearestVertices(graph, [lon, lat], radius, count) {
  const lonScale = metersPerDegree * Math.cos(lat * Math.PI / 180);
  const cellX = value => Math.floor((value - 78) * 100);
  const cellY = value => Math.floor((value - 5) * 100);
  const ranked = [];
  for (let y = Math.max(0, cellY(lat - radius / metersPerDegree)); y <= Math.min(gridHeight - 1, cellY(lat + radius / metersPerDegree)); y++) {
    for (let x = Math.max(0, cellX(lon - radius / lonScale)); x <= Math.min(gridWidth - 1, cellX(lon + radius / lonScale)); x++) {
      const cell = y * gridWidth + x;
      for (let i = graph.cells[cell]; i < graph.cells[cell + 1]; i++) {
        const candidate = graph.cellNodes[i];
        const squared = ((graph.lon[candidate] - lon) * lonScale) ** 2 + ((graph.lat[candidate] - lat) * metersPerDegree) ** 2;
        if (squared >= radius ** 2 || (ranked.length === count && squared >= ranked.at(-1).squared)) continue;
        ranked.push({ vertex: candidate, squared });
        ranked.sort((a, b) => a.squared - b.squared);
        if (ranked.length > count) ranked.pop();
      }
    }
  }
  return ranked.map(({ vertex, squared }) => ({ vertex, location: coordinate(graph, vertex), distance: Math.sqrt(squared) }));
}

function pushRank(queue, rank) {
  let i = queue.length;
  queue.push(rank);
  while (i > 0) {
    const parent = (i - 1) >>> 1;
    if (queue[parent] <= rank) break;
    queue[i] = queue[parent];
    i = parent;
  }
  queue[i] = rank;
}

function popRank(queue) {
  const first = queue[0];
  const last = queue.pop();
  if (!queue.length) return first;
  let i = 0;
  while (i * 2 + 1 < queue.length) {
    let child = i * 2 + 1;
    if (child + 1 < queue.length && queue[child + 1] < queue[child]) child++;
    if (queue[child] >= last) break;
    queue[i] = queue[child];
    i = child;
  }
  queue[i] = last;
  return first;
}

// All hierarchy arcs point upward in rank order. Processing ranks in that
// order settles each visited vertex once, even with zero-cost terminal arcs.
function search(side, starts) {
  const queue = [];
  const visited = new Map();
  for (const rank of starts) {
    visited.set(rank, { weight: 0 });
    pushRank(queue, rank);
  }
  while (queue.length) {
    const rank = popRank(queue);
    const { weight } = visited.get(rank);
    for (let arc = side.offsets[rank]; arc < side.offsets[rank + 1]; arc++) {
      const head = side.heads[arc];
      const next = weight + side.weights[arc];
      const old = visited.get(head);
      if (old && old.weight <= next) continue;
      if (!old) pushRank(queue, head);
      visited.set(head, { weight: next, rank, arc });
    }
  }
  return visited;
}

function backwardSearch(graph, target) {
  const ranks = [graph.ranks[target]];
  const i = lowerBound(graph.terminalNodes, target);
  if (graph.terminalNodes[i] === target) ranks.push(graph.terminalRanks[i]);
  return search(graph.backward, ranks);
}

function appendExpanded(graph, graphArcs, pending, backwards) {
  while (pending.length) {
    const [arc, direction] = pending.pop();
    const side = direction ? graph.backward : graph.forward;
    const first = side.first[arc];
    const second = side.second[arc];
    if (second !== missing) {
      pending.push([second, false], [first, true]);
      continue;
    }
    const original = graph.transitions[first];
    if (original !== missing) graphArcs.push(original);
  }
}

function connect(graph, from, to) {
  let bestWeight = Infinity;
  let peak;
  for (const [rank, visit] of from) {
    const reverse = to.get(rank);
    if (reverse && visit.weight + reverse.weight < bestWeight) {
      bestWeight = visit.weight + reverse.weight;
      peak = rank;
    }
  }
  if (peak === undefined) return null;
  const arcs = [];
  const forward = [];
  for (let p = from.get(peak); p.arc !== undefined; p = from.get(p.rank)) forward.push([p.arc, false]);
  appendExpanded(graph, arcs, forward);
  for (let p = to.get(peak); p.arc !== undefined; p = to.get(p.rank)) appendExpanded(graph, arcs, [[p.arc, true]]);
  let distance = 0;
  for (const arc of arcs) distance += graph.meters[arc];
  return { arcs, distance, duration: bestWeight / 1000 };
}

const coordinate = (graph, vertex) => [graph.lon[vertex], graph.lat[vertex]];
const arrival = (graph, arcs, target) => arcs.length ? coordinate(graph, graph.heads[arcs.at(-1)]) : coordinate(graph, target);
const step = (type, location, modifier) => ({ name: '', maneuver: { type, location, ...(modifier && { modifier }) } });

function heading(a, b) {
  return Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI;
}

function legGeometry(graph, leg, source, target, shapes, limits) {
  const coordinates = [coordinate(graph, source)];
  const steps = [step('depart', coordinates[0])];
  const speedLimits = [];
  for (const arc of leg.arcs) {
    const start = coordinates.length - 1;
    const from = coordinates.at(-1);
    const shape = shapes.get(arc);
    const to = coordinate(graph, graph.heads[arc]);
    if (coordinates.length > 1) {
      const next = shape ? [shape[0], shape[1]] : to;
      const previous = coordinates.at(-2);
      const angle = (heading(from, next) - heading(previous, from) + 540) % 360 - 180;
      const absolute = Math.abs(angle);
      if (absolute >= 35) {
        const direction = angle > 0 ? 'right' : 'left';
        const modifier = absolute > 165 ? 'uturn' : absolute >= 115 ? 'sharp ' + direction :
          absolute < 55 ? 'slight ' + direction : direction;
        steps.push(step('turn', from, modifier));
      }
    }
    if (shape) {
      for (let i = 0; i < shape.length; i += 2) coordinates.push([shape[i], shape[i + 1]]);
    }
    coordinates.push(to);
    if (limits) {
      const amount = limits[arc] & 0x7fff;
      const unit = amount ? (limits[arc] & 0x8000 ? 'mph' : 'km/h') : null;
      const speed = amount || null;
      const previous = speedLimits.at(-1);
      const end = coordinates.length - 1;
      if (previous?.speed === speed && previous?.unit === unit) previous.endIndex = end;
      else speedLimits.push({ startIndex: start, endIndex: end, speed, unit });
    }
  }
  steps.push(step('arrive', arrival(graph, leg.arcs, target)));
  return { coordinates, steps, duration: leg.duration, distance: leg.distance, ...(limits && { speedLimits }) };
}

function traceVertices(points, choices, pair) {
  let previous = choices[0].map(point => ({ point, cost: point.distance }));
  for (let i = 1; i < points.length; i++) {
    const [lon, lat] = points[i];
    const [previousLon, previousLat] = points[i - 1];
    const observed = metersPerDegree * Math.hypot(
      (lon - previousLon) * Math.cos(lat * Math.PI / 180), lat - previousLat,
    );
    const current = [];
    for (const point of choices[i]) {
      let best;
      for (const before of previous) {
        const route = pair(before.point.vertex, point.vertex);
        if (!route || route.distance > observed * 4 + 100) continue;
        const cost = before.cost + point.distance + Math.abs(route.distance - observed) * 0.5;
        if (!best || cost < best.cost) best = { point, cost, before };
      }
      if (best) current.push(best);
    }
    if (!current.length) throw new RoutingError(422, 'The trace contains an implausible gap.');
    previous = current;
  }
  const path = [];
  for (let state = previous.reduce((best, next) => best.cost < next.cost ? best : next); state; state = state.before) {
    path.push(state.point);
  }
  return path.reverse();
}

export async function solveRoute(graph, points, sources, destinations, loadShapes, matchTrace = false, limits) {
  const radius = matchTrace ? 100 : 500;
  const choices = points.map(point => nearestVertices(graph, point, radius, matchTrace ? 3 : 1));
  if (choices.some(candidate => !candidate.length)) throw new RoutingError(422, `A coordinate is more than ${radius} m from a routable vertex.`);
  const forward = new Map();
  const backward = new Map();
  const pair = (source, target) => {
    if (source === target) return { arcs: [], distance: 0, duration: 0 };
    if (!forward.has(source)) forward.set(source, search(graph.forward, [graph.ranks[source]]));
    if (!backward.has(target)) backward.set(target, backwardSearch(graph, target));
    return connect(graph, forward.get(source), backward.get(target));
  };
  const waypoints = matchTrace ? traceVertices(points, choices, pair) : choices.map(candidate => candidate[0]);
  const pairs = waypoints.map(point => point.vertex);
  if (sources) {
    const values = sources.map(a => destinations.map(b => pair(pairs[a], pairs[b])));
    return {
      durations: values.map(row => row.map(value => value?.duration ?? null)),
      distances: values.map(row => row.map(value => value?.distance ?? null)),
      sources: sources.map(i => waypoints[i]), destinations: destinations.map(i => waypoints[i]),
    };
  }
  const paths = [];
  const arcs = new Set();
  let geometrySize = 1;
  let distance = 0;
  let duration = 0;
  for (let i = 1; i < pairs.length; i++) {
    const leg = pair(pairs[i - 1], pairs[i]);
    if (!leg) throw new RoutingError(422, 'No route connects these coordinates for this travel mode.');
    for (const arc of leg.arcs) {
      geometrySize += 1 + graph.geometryLengths[arc];
      arcs.add(arc);
    }
    if (geometrySize > 40000) throw new RoutingError(422, 'The route exceeds the geometry limit.');
    paths.push(leg);
    distance += leg.distance;
    duration += leg.duration;
  }
  const shapes = await loadShapes(arcs);
  const coordinates = [];
  const legs = paths.map((leg, i) => {
    const { coordinates: geometry, ...details } = legGeometry(graph, leg, pairs[i], pairs[i + 1], shapes, limits);
    if (limits) {
      const offset = i ? coordinates.length - 1 : 0;
      for (const span of details.speedLimits) {
        span.startIndex += offset;
        span.endIndex += offset;
      }
    }
    for (let j = i === 0 ? 0 : 1; j < geometry.length; j++) coordinates.push(geometry[j]);
    return details;
  });
  if (coordinates.length === 1) coordinates.push(coordinates[0]);
  const route = { distance, duration, geometry: { type: 'LineString', coordinates }, legs };
  if (matchTrace) {
    if (!distance) throw new RoutingError(422, 'The trace resolves to a single road vertex.');
    return { matchings: [route], tracepoints: waypoints.map(({ location, distance }) => ({ location, distance })) };
  }
  return { routes: [route], waypoints };
}

let cachedGraph;
let activeMode;
let activeRequests = 0;

async function readRange(bucket, key, etag, offset, length) {
  const object = await bucket.get(key, { onlyIf: { etagMatches: etag }, range: { offset, length } });
  if (!object?.body) throw new RoutingError(503, 'Routing graph changed. Retry the request.');
  const buffer = new Uint8Array(length);
  let written = 0;
  const reader = object.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (written + value.byteLength > length) {
        await reader.cancel();
        throw new Error('Routing graph range exceeded.');
      }
      buffer.set(value, written);
      written += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (written !== length) throw new Error('Routing graph range incomplete.');
  return buffer.buffer;
}

async function getGraph(bucket, mode) {
  const key = graphPrefix + mode + '.bin';
  const head = await bucket.head(key);
  if (!head) throw new RoutingError(503, 'This travel mode has no deployed routing graph.');
  if (cachedGraph?.etag === head.etag && cachedGraph?.key === key) return cachedGraph;
  if (activeRequests > 1) throw new RoutingError(503, 'The routing graph is refreshing. Retry shortly.');
  cachedGraph = undefined;
  const metadata = await readRange(bucket, key, head.etag, 0, 12);
  const size = new DataView(metadata).getUint32(8, true);
  if (size < 12 || size > head.size || size > 80 * 1024 ** 2) throw new Error('Routing graph exceeds the memory budget.');
  const graph = parseRoutingGraph(await readRange(bucket, key, head.etag, 0, size));
  cachedGraph = { key, etag: head.etag, graph, size, objectSize: head.size };
  return cachedGraph;
}

async function loadGraphShapes(bucket, file, arcs) {
  const { key, etag, graph, size } = file;
  const cells = new Map();
  for (const arc of arcs) {
    const length = graph.geometryLengths[arc];
    if (!length) continue;
    const start = graph.geometryOffsets[arc];
    const cell = lowerBound(graph.shapeBoundaries, start + 1) - 1;
    if (!cells.has(cell)) cells.set(cell, { start, end: start + length, arcs: [] });
    const range = cells.get(cell);
    range.start = Math.min(range.start, start);
    range.end = Math.max(range.end, start + length);
    range.arcs.push(arc);
  }
  const count = [...cells.values()].reduce((total, range) => total + range.end - range.start, 0);
  if (cells.size > 36 || count * 8 > 14 * 1024 ** 2) throw new RoutingError(422, 'The route exceeds the shape retrieval limit.');
  const shapes = new Map();
  await Promise.all([...cells.values()].map(async ({ start, end, arcs: group }) => {
    const data = new Float32Array(await readRange(bucket, key, etag, size + start * 8, (end - start) * 8));
    for (const arc of group) {
      const first = (graph.geometryOffsets[arc] - start) * 2;
      shapes.set(arc, data.subarray(first, first + graph.geometryLengths[arc] * 2));
    }
  }));
  return shapes;
}

export async function availableRoutingModes(bucket) {
  if (!bucket?.head) return [];
  const files = await Promise.all(routingModes.map(mode => bucket.head(graphPrefix + mode + '.bin')));
  return routingModes.filter((_, i) => files[i]);
}

export async function routingRequest(bucket, operation, body) {
  const mode = body.mode ?? 'drive';
  if (!routingModes.includes(mode)) throw new RoutingError(400, 'Choose drive, walk, or cycle.');
  if (body.speedLimits !== undefined && (typeof body.speedLimits !== 'boolean' || mode !== 'drive' || operation === 'matrix')) {
    throw new RoutingError(400, 'Speed limits are available for drive routes and traces.');
  }
  const max = operation === 'matrix' ? 6 : 8;
  const coordinates = body.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > max ||
      coordinates.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
        point[0] < 78 || point[0] > 82.5 || point[1] < 5 || point[1] > 10.5)) {
    throw new RoutingError(400, 'Supply 2 to ' + max + ' coordinates as [longitude, latitude] in Sri Lanka.');
  }
  function indices(values) {
    if (values === undefined) return coordinates.map((_, i) => i);
    if (!Array.isArray(values) || !values.length || values.length > max ||
        values.some(n => !Number.isInteger(n) || n < 0 || n >= coordinates.length)) {
      throw new RoutingError(400, 'Invalid matrix coordinate indices.');
    }
    return values;
  }
  const sources = operation === 'matrix' ? indices(body.sources) : undefined;
  const destinations = operation === 'matrix' ? indices(body.destinations) : undefined;
  if (activeRequests >= 2 || (activeRequests && (activeMode !== mode || !cachedGraph))) {
    throw new RoutingError(503, 'Routing is busy. Retry shortly.');
  }
  activeMode = mode;
  activeRequests++;
  try {
    const file = await getGraph(bucket, mode);
    let limits;
    if (body.speedLimits) {
      const offset = file.size + file.graph.shapeBoundaries.at(-1) * 8;
      const size = file.graph.heads.length * 2;
      if (file.objectSize !== offset + size) throw new RoutingError(503, 'Posted speed data is unavailable.');
      limits = new Uint16Array(await readRange(bucket, file.key, file.etag, offset, size));
    }
    const route = await solveRoute(file.graph, coordinates, sources, destinations,
      arcs => loadGraphShapes(bucket, file, arcs), operation === 'match', limits);
    return { code: 'Ok', mode, traffic: 'none', attribution: '© OpenStreetMap contributors', ...route };
  } finally {
    activeRequests--;
  }
}
