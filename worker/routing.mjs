const missing = 0xffffffff;
const metersPerDegree = 111195;
const routingModes = ['drive', 'walk', 'cycle', 'motorcycle', 'tuk'];
export const graphPrefix = 'lkmaps/routing/v2/';
const gridWidth = 500;
const gridHeight = 600;
const maxCoreBytes = 80 * 1024 ** 2;
const packedCoreBytes = 62 * 1024 ** 2;
const coreReadBytes = 8 * 1024 ** 2;

export class RoutingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseRoutingGraph(buffer, length = buffer.byteLength) {
  const header = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
  const packed = header === 'SIFRIC03';
  if (length > (packed ? packedCoreBytes : maxCoreBytes) || (!packed && header !== 'SIFRIC02')) {
    throw new Error('Invalid routing graph.');
  }
  const view = new DataView(buffer, 0, length);
  let offset = 12;
  function column(Type = Uint32Array) {
    const count = view.getUint32(offset, true);
    const width = packed ? view.getUint32(offset + 4, true) : 4;
    offset += packed ? 8 : 4;
    if (width < 1 || width > 4 || (Type === Float32Array && width !== 4) || offset + width * count > length) {
      throw new Error('Invalid routing index column.');
    }
    const start = offset;
    offset += width * count + ((-width * count) & 3);
    if (width === 4) {
      const values = new Type(buffer, start, count);
      return { length: count, get: i => values[i] };
    }
    if (width === 2) {
      const values = new Uint16Array(buffer, start, count);
      return { length: count, get: i => values[i] === 65535 ? missing : values[i] };
    }
    const bytes = new Uint8Array(buffer, start, width * count);
    if (width === 1) return { length: count, get: i => bytes[i] === 255 ? missing : bytes[i] };
    return {
      length: count,
      get(i) {
        if (i >= count) return undefined;
        const index = i * 3;
        const value = bytes[index] | bytes[index + 1] << 8 | bytes[index + 2] << 16;
        return value === 0xffffff ? missing : value;
      },
    };
  }
  const side = () => ({ offsets: column(), heads: column(), weights: column(), first: column(), second: column() });
  const graph = {
    ranks: column(), terminalNodes: column(), terminalRanks: column(), cells: column(), cellNodes: column(),
    lon: column(Float32Array), lat: column(Float32Array), forward: side(), backward: side(),
    transitions: column(), heads: column(), meters: column(),
    geometryOffsets: column(), geometryLengths: column(), shapeBoundaries: column(),
  };
  if (offset !== length || graph.cells.length !== gridWidth * gridHeight + 1 ||
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
    if (values.get(mid) < key) left = mid + 1;
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
      for (let i = graph.cells.get(cell); i < graph.cells.get(cell + 1); i++) {
        const candidate = graph.cellNodes.get(i);
        const squared = ((graph.lon.get(candidate) - lon) * lonScale) ** 2 + ((graph.lat.get(candidate) - lat) * metersPerDegree) ** 2;
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
    for (let arc = side.offsets.get(rank); arc < side.offsets.get(rank + 1); arc++) {
      const head = side.heads.get(arc);
      const next = weight + side.weights.get(arc);
      const old = visited.get(head);
      if (old && old.weight <= next) continue;
      if (!old) pushRank(queue, head);
      visited.set(head, { weight: next, rank, arc });
    }
  }
  return visited;
}

function backwardSearch(graph, target) {
  const ranks = [graph.ranks.get(target)];
  const i = lowerBound(graph.terminalNodes, target);
  if (graph.terminalNodes.get(i) === target) ranks.push(graph.terminalRanks.get(i));
  return search(graph.backward, ranks);
}

function appendExpanded(graph, graphArcs, pending, backwards) {
  while (pending.length) {
    const [arc, direction] = pending.pop();
    const side = direction ? graph.backward : graph.forward;
    const first = side.first.get(arc);
    const second = side.second.get(arc);
    if (second !== missing) {
      pending.push([second, false], [first, true]);
      continue;
    }
    const original = graph.transitions.get(first);
    if (original !== missing) graphArcs.push(original);
  }
}

function meetingRanks(from, to) {
  const peaks = [];
  for (const [rank, visit] of from) {
    const reverse = to.get(rank);
    if (reverse) peaks.push({ rank, weight: visit.weight + reverse.weight });
  }
  return peaks;
}

function expandRoute(graph, from, to, { rank, weight }) {
  const arcs = [];
  const forward = [];
  for (let p = from.get(rank); p.arc !== undefined; p = from.get(p.rank)) forward.push([p.arc, false]);
  appendExpanded(graph, arcs, forward);
  for (let p = to.get(rank); p.arc !== undefined; p = to.get(p.rank)) appendExpanded(graph, arcs, [[p.arc, true]]);
  let distance = 0;
  for (const arc of arcs) distance += graph.meters.get(arc);
  return { arcs, distance, duration: weight / 1000 };
}

function connect(graph, from, to) {
  const best = meetingRanks(from, to).reduce((best, next) => !best || next.weight < best.weight ? next : best, null);
  return best && expandRoute(graph, from, to, best);
}

function alternativePaths(graph, forward, backward, primary, source) {
  const alternatives = [];
  const used = [new Set(primary.arcs)];
  const peaks = meetingRanks(forward, backward)
    .filter(peak => peak.weight <= primary.duration * 1550)
    .sort((a, b) => a.weight - b.weight);
  for (const peak of peaks.slice(0, 32)) {
    const path = expandRoute(graph, forward, backward, peak);
    if (!path.distance) continue;
    const vertices = new Set([source]);
    for (const arc of path.arcs) vertices.add(graph.heads.get(arc));
    if (vertices.size !== path.arcs.length + 1) continue;
    if (used.some(arcs => path.arcs.reduce((sum, arc) => sum + (arcs.has(arc) ? 0 : graph.meters.get(arc)), 0) < path.distance * 0.20)) continue;
    alternatives.push(path);
    used.push(new Set(path.arcs));
    if (alternatives.length === 2) break;
  }
  return alternatives;
}

export function optimizeWaypointOrder(durations) {
  const middle = durations.length - 2;
  const all = (1 << middle) - 1;
  const states = new Map();
  function visit(mask, last) {
    if (mask === all) return { cost: durations[last].at(-1) ?? Infinity, stops: [] };
    const key = mask * durations.length + last;
    if (states.has(key)) return states.get(key);
    let best = { cost: Infinity, stops: [] };
    for (let i = 0; i < middle; i++) {
      if (mask & 1 << i || durations[last][i + 1] == null) continue;
      const rest = visit(mask | 1 << i, i + 1);
      const cost = durations[last][i + 1] + rest.cost;
      if (cost < best.cost) best = { cost, stops: [i + 1, ...rest.stops] };
    }
    states.set(key, best);
    return best;
  }
  const plan = visit(0, 0);
  return Number.isFinite(plan.cost) ? [0, ...plan.stops, durations.length - 1] : null;
}

export function routingProfile(body) {
  const mode = body.mode ?? 'drive';
  if (!routingModes.includes(mode)) throw new RoutingError(400, 'Choose drive, walk, cycle, motorcycle, or tuk.');
  for (const key of ['avoidTolls', 'avoidHighways', 'avoidFerries']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new RoutingError(400, key + ' must be a Boolean.');
  }
  if ((body.avoidTolls || body.avoidHighways) && mode !== 'drive') {
    throw new RoutingError(400, 'Toll and expressway avoidance are available for drive routes.');
  }
  return body.avoidTolls ? 'drive-no-tolls' : body.avoidHighways ? 'drive-no-highways' : mode;
}

const coordinate = (graph, vertex) => [graph.lon.get(vertex), graph.lat.get(vertex)];
const arrival = (graph, arcs, target) => arcs.length ? coordinate(graph, graph.heads.get(arcs.at(-1))) : coordinate(graph, target);
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
    const to = coordinate(graph, graph.heads.get(arc));
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

export async function solveRoute(graph, points, sources, destinations, loadShapes, matchTrace = false, limits, options = {}) {
  const radius = matchTrace ? 100 : 500;
  const choices = points.map(point => nearestVertices(graph, point, radius, matchTrace ? 3 : 1));
  if (choices.some(candidate => !candidate.length)) throw new RoutingError(422, `A coordinate is more than ${radius} m from a routable vertex.`);
  const forward = new Map();
  const backward = new Map();
  const pair = (source, target) => {
    if (source === target) return { arcs: [], distance: 0, duration: 0 };
    if (!forward.has(source)) forward.set(source, search(graph.forward, [graph.ranks.get(source)]));
    if (!backward.has(target)) backward.set(target, backwardSearch(graph, target));
    return connect(graph, forward.get(source), backward.get(target));
  };
  let waypoints = matchTrace ? traceVertices(points, choices, pair) : choices.map(candidate => candidate[0]);
  let pairs = waypoints.map(point => point.vertex);
  let waypointOrder;
  if (options.optimizeWaypointOrder) {
    const times = pairs.map(from => pairs.map(to => pair(from, to)?.duration ?? null));
    waypointOrder = optimizeWaypointOrder(times);
    if (!waypointOrder) throw new RoutingError(422, 'The intermediate stops cannot be connected.');
    waypoints = waypointOrder.map(index => waypoints[index]);
    pairs = waypoints.map(point => point.vertex);
  }
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
  for (let i = 1; i < pairs.length; i++) {
    const leg = pair(pairs[i - 1], pairs[i]);
    if (!leg) throw new RoutingError(422, 'No route connects these coordinates for this travel mode.');
    for (const arc of leg.arcs) {
      geometrySize += 1 + graph.geometryLengths.get(arc);
      arcs.add(arc);
    }
    if (geometrySize > 40000) throw new RoutingError(422, 'The route exceeds the geometry limit.');
    paths.push(leg);
    distance += leg.distance;
  }
  const render = (legsForRoute, shapes) => {
    const coordinates = [];
    const legs = legsForRoute.map((leg, i) => {
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
    return { distance: legsForRoute.reduce((sum, leg) => sum + leg.distance, 0),
      duration: legsForRoute.reduce((sum, leg) => sum + leg.duration, 0),
      geometry: { type: 'LineString', coordinates }, legs };
  };
  let alternatives = [];
  if (options.alternatives && pairs[0] !== pairs[1]) {
    alternatives = alternativePaths(graph, forward.get(pairs[0]), backward.get(pairs[1]), paths[0], pairs[0])
      .filter(path => path.arcs.reduce((sum, arc) => sum + 1 + graph.geometryLengths.get(arc), 1) <= 40000);
  }
  let shapes;
  if (alternatives.length) {
    const combined = new Set([...arcs, ...alternatives.flatMap(path => path.arcs)]);
    try { shapes = await loadShapes(combined); }
    catch (error) {
      if (!(error instanceof RoutingError) || error.status !== 422) throw error;
      alternatives = [];
    }
  }
  shapes ??= await loadShapes(arcs);
  const route = render(paths, shapes);
  if (matchTrace) {
    if (!distance) throw new RoutingError(422, 'The trace resolves to a single road vertex.');
    return { matchings: [route], tracepoints: waypoints.map(({ location, distance }) => ({ location, distance })) };
  }
  return { routes: [route, ...alternatives.map(path => render([path], shapes))], waypoints,
    ...(waypointOrder && { optimizedIntermediateWaypointIndices: waypointOrder.slice(1, -1).map(index => index - 1) }) };
}

let cachedGraph;
let coreBuffer;
let activeMode;
let activeRequests = 0;

async function readRange(bucket, key, etag, offset, length, buffer = new Uint8Array(length)) {
  const object = await bucket.get(key, { onlyIf: { etagMatches: etag }, range: { offset, length } });
  if (!object?.body) throw new RoutingError(503, 'Routing graph changed. Retry the request.');
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
  const packed = new TextDecoder().decode(new Uint8Array(metadata, 0, 8)) === 'SIFRIC03';
  const bufferSize = packed ? packedCoreBytes : maxCoreBytes;
  if (size < 12 || size > head.size || size > bufferSize) throw new Error('Routing graph exceeds the memory budget.');
  if (coreBuffer?.byteLength !== bufferSize) coreBuffer = new ArrayBuffer(bufferSize);
  // Keep a cold R2 transfer bounded while the destination buffer is resident.
  for (let offset = 0; offset < size; offset += coreReadBytes) {
    const length = Math.min(coreReadBytes, size - offset);
    await readRange(bucket, key, head.etag, offset, length, new Uint8Array(coreBuffer, offset, length));
  }
  const graph = parseRoutingGraph(coreBuffer, size);
  cachedGraph = { key, etag: head.etag, graph, size, objectSize: head.size };
  return cachedGraph;
}

async function loadGraphShapes(bucket, file, arcs) {
  const { key, etag, graph, size } = file;
  const intervals = [];
  for (const arc of arcs) {
    const length = graph.geometryLengths.get(arc);
    if (!length) continue;
    const start = graph.geometryOffsets.get(arc);
    intervals.push({ arc, start, end: start + length });
  }
  intervals.sort((a, b) => a.start - b.start);
  const gaps = [];
  for (let i = 1; i < intervals.length; i++) {
    const points = intervals[i].start - intervals[i - 1].end;
    if (points >= 512) gaps.push({ i, points });
  }
  // Spend the bounded range-request budget on the largest unused spans.
  // Neighboring roads can be far apart in the stored arc ordering.
  gaps.sort((a, b) => b.points - a.points);
  const split = new Set();
  let span = intervals.length ? intervals.at(-1).end - intervals[0].start : 0;
  for (const gap of gaps) {
    if (span <= 65536 || split.size === 34) break;
    split.add(gap.i);
    span -= gap.points;
  }
  const ranges = [];
  for (let i = 0; i < intervals.length; i++) {
    const { arc, start, end } = intervals[i];
    if (i === 0 || split.has(i)) ranges.push({ start, end, arcs: [arc] });
    else {
      const range = ranges.at(-1);
      range.end = end;
      range.arcs.push(arc);
    }
  }
  const count = ranges.reduce((total, range) => total + range.end - range.start, 0);
  if (count * 8 > 12 * 1024 ** 2) throw new RoutingError(422, 'The route exceeds the shape retrieval limit.');
  const shapes = new Map();
  await Promise.all(ranges.map(async ({ start, end, arcs: group }) => {
    const data = new Float32Array(await readRange(bucket, key, etag, size + start * 8, (end - start) * 8));
    for (const arc of group) {
      const first = (graph.geometryOffsets.get(arc) - start) * 2;
      shapes.set(arc, data.subarray(first, first + graph.geometryLengths.get(arc) * 2));
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
  const profile = routingProfile(body);
  if (body.speedLimits !== undefined && (typeof body.speedLimits !== 'boolean' || mode !== 'drive' || operation === 'matrix')) {
    throw new RoutingError(400, 'Speed limits are available for drive routes and traces.');
  }
  for (const key of ['alternatives', 'optimizeWaypointOrder']) {
    if (body[key] !== undefined && (typeof body[key] !== 'boolean' || operation !== 'routes')) {
      throw new RoutingError(400, key + ' is a Boolean route option.');
    }
  }
  const max = operation === 'matrix' ? 25 : operation === 'match' ? 25 : 8;
  const coordinates = body.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > max ||
      coordinates.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
        point[0] < 78 || point[0] > 82.5 || point[1] < 5 || point[1] > 10.5)) {
    throw new RoutingError(400, 'Supply 2 to ' + max + ' coordinates as [longitude, latitude] in Sri Lanka.');
  }
  if (body.alternatives && coordinates.length !== 2) throw new RoutingError(400, 'Alternatives require two coordinates.');
  if (body.optimizeWaypointOrder && coordinates.length < 3) throw new RoutingError(400, 'Optimization requires at least one intermediate stop.');
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
  if (activeRequests >= 2 || (activeRequests && (activeMode !== profile || !cachedGraph))) {
    throw new RoutingError(503, 'Routing is busy. Retry shortly.');
  }
  activeMode = profile;
  activeRequests++;
  try {
    const file = await getGraph(bucket, profile);
    let limits;
    if (body.speedLimits) {
      const offset = file.size + file.graph.shapeBoundaries.get(file.graph.shapeBoundaries.length - 1) * 8;
      const size = file.graph.heads.length * 2;
      if (file.objectSize !== offset + size) throw new RoutingError(503, 'Posted speed data is unavailable.');
      limits = new Uint16Array(await readRange(bucket, file.key, file.etag, offset, size));
    }
    const route = await solveRoute(file.graph, coordinates, sources, destinations,
      arcs => loadGraphShapes(bucket, file, arcs), operation === 'match', limits, body);
    return { code: 'Ok', mode, traffic: 'none', attribution: '© OpenStreetMap contributors',
      ...(profile !== mode && { drivingProfile: profile }), ...route };
  } finally {
    activeRequests--;
  }
}
