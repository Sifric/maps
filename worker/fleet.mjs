import { routingRequest, RoutingError } from './routing.mjs';

function invalid(message) {
  throw new RoutingError(400, message);
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10 ** 12) invalid('Invalid ' + label + '.');
  return value;
}

function windowList(value) {
  if (value === undefined) return [[0, 10 ** 12]];
  if (!Array.isArray(value) || !value.length || value.length > 5) invalid('Supply 1 to 5 time windows.');
  return value.map(window => {
    if (!Array.isArray(window) || window.length !== 2) invalid('Specify time windows as [start, end].');
    const start = integer(window[0], 'time window');
    const end = integer(window[1], 'time window');
    if (start > end) invalid('A time window must end after it starts.');
    return [start, end];
  }).sort((a, b) => a[0] - b[0]);
}

function parse(body) {
  const { vehicles, jobs = [], shipments = [] } = body;
  if (!Array.isArray(vehicles) || !vehicles.length || vehicles.length > 4 ||
      !Array.isArray(jobs) || !Array.isArray(shipments) || !jobs.length && !shipments.length ||
      jobs.length + 2 * shipments.length > 10) {
    invalid('Provide 1 to 4 vehicles and 1 to 10 job, pickup, or delivery stops.');
  }
  const locations = [];
  const index = new Map();
  const ids = new Set();
  function location(point) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
        point[0] < 78 || point[0] > 82.5 || point[1] < 5 || point[1] > 10.5) {
      invalid('Specify Sri Lanka locations as [longitude, latitude].');
    }
    const key = point.join(',');
    if (!index.has(key)) {
      if (locations.length === 6) invalid('Use at most six distinct locations.');
      index.set(key, locations.length);
      locations.push(point);
    }
    return index.get(key);
  }
  const dimension = vehicles[0]?.capacity?.length ?? 0;
  if (!Number.isInteger(dimension) || dimension > 5) invalid('Use at most five capacity dimensions.');
  function amounts(value) {
    if (value === undefined) return Array(dimension).fill(0);
    if (!Array.isArray(value) || value.length !== dimension) invalid('All capacity and amount arrays must have the same length.');
    return value.map(number => integer(number, 'capacity or amount'));
  }
  function id(value, type) {
    const number = integer(value, type + ' ID');
    const key = type + ':' + number;
    if (ids.has(key)) invalid('IDs must be unique for each type.');
    ids.add(key);
    return number;
  }
  function stop(value, type, pickup, delivery) {
    if (!value || typeof value !== 'object') invalid('Each stop needs an ID and location.');
    if (value.skills !== undefined || value.priority !== undefined || value.setup !== undefined) {
      invalid('This fleet planner supports service durations, time windows, and capacity constraints.');
    }
    return {
      id: id(value.id, type), type, location: location(value.location),
      service: integer(value.service ?? 0, 'service duration'),
      windows: windowList(value.time_windows), pickup, delivery,
    };
  }
  const fleet = vehicles.map(vehicle => {
    if (!vehicle?.start || (vehicle.profile ?? 'drive') !== 'drive') invalid('Each vehicle needs a start and the drive profile.');
    if (vehicle.breaks !== undefined || vehicle.skills !== undefined || vehicle.max_tasks !== undefined ||
        vehicle.max_travel_time !== undefined || vehicle.max_distance !== undefined || vehicle.costs !== undefined) {
      invalid('This fleet planner supports vehicle time windows and capacities.');
    }
    return {
      id: id(vehicle.id, 'vehicle'),
      start: location(vehicle.start), end: vehicle.end === undefined ? null : location(vehicle.end),
      capacity: amounts(vehicle.capacity), window: windowList(vehicle.time_window === undefined ? undefined : [vehicle.time_window])[0],
    };
  });
  const tasks = jobs.map(job => [stop(job, 'job', amounts(job?.pickup), amounts(job?.delivery))]);
  for (const shipment of shipments) {
    const amount = amounts(shipment?.amount);
    tasks.push([
      stop(shipment?.pickup, 'pickup', amount, amounts()),
      stop(shipment?.delivery, 'delivery', amounts(), amount),
    ]);
  }
  return { fleet, tasks, locations };
}

function evaluate(vehicle, stops, matrix) {
  let current = vehicle.start;
  let duration = 0;
  let distance = 0;
  let start = vehicle.window[0];
  const load = vehicle.capacity.map((_, i) => stops.reduce((sum, stop) => sum + (stop.type === 'job' ? stop.delivery[i] : 0), 0));
  if (load.some((amount, i) => amount > vehicle.capacity[i])) return null;
  const steps = [{ type: 'start', location: current, arrival: start, load: [...load] }];
  for (const stop of stops) {
    const travel = matrix.durations[current][stop.location];
    if (travel == null) return null;
    duration += travel;
    distance += matrix.distances[current][stop.location];
    const arrival = start + travel;
    const window = stop.windows.find(([, end]) => arrival <= end);
    if (!window) return null;
    const serviceStart = Math.max(arrival, window[0]);
    start = serviceStart + stop.service;
    for (let i = 0; i < load.length; i++) {
      if (load[i] < stop.delivery[i]) return null;
      load[i] += stop.pickup[i] - stop.delivery[i];
      if (load[i] > vehicle.capacity[i]) return null;
    }
    steps.push({ type: stop.type, id: stop.id, location: stop.location, arrival, service: stop.service,
      waiting_time: serviceStart - arrival, load: [...load] });
    current = stop.location;
  }
  if (vehicle.end !== null) {
    const travel = matrix.durations[current][vehicle.end];
    if (travel == null) return null;
    duration += travel;
    distance += matrix.distances[current][vehicle.end];
    start += travel;
    steps.push({ type: 'end', location: vehicle.end, arrival: start, load: [...load] });
  }
  if (start > vehicle.window[1]) return null;
  return { vehicle: vehicle.id, duration, distance, steps };
}

function insertions(stops, task) {
  const candidates = [];
  for (let i = 0; i <= stops.length; i++) {
    const inserted = [...stops.slice(0, i), task[0], ...stops.slice(i)];
    if (task.length === 1) candidates.push(inserted);
    else {
      for (let j = i + 1; j <= inserted.length; j++) {
        candidates.push([...inserted.slice(0, j), task[1], ...inserted.slice(j)]);
      }
    }
  }
  return candidates;
}

export async function optimizeFleet(bucket, body, matrixRequest = routingRequest) {
  const { fleet, tasks, locations } = parse(body);
  const matrix = locations.length === 1 ? { durations: [[0]], distances: [[0]] } :
    await matrixRequest(bucket, 'matrix', { coordinates: locations, mode: 'drive' });
  const routes = fleet.map(vehicle => ({ vehicle, stops: [], plan: null }));
  for (;;) {
    let best;
    for (let i = 0; i < tasks.length; i++) {
      for (const route of routes) {
        for (const stops of insertions(route.stops, tasks[i])) {
          const plan = evaluate(route.vehicle, stops, matrix);
          if (!plan) continue;
          const cost = plan.duration - (route.plan?.duration ?? 0);
          if (!best || cost < best.cost) best = { i, route, stops, plan, cost };
        }
      }
    }
    if (!best) break;
    best.route.stops = best.stops;
    best.route.plan = best.plan;
    tasks.splice(best.i, 1);
  }
  const plans = routes.flatMap(({ plan }) => plan ? [{
    ...plan, steps: plan.steps.map(stop => ({ ...stop, location: locations[stop.location] })),
  }] : []);
  const unassigned = tasks.flatMap(task => task.map(stop => ({ id: stop.id, type: stop.type, location: locations[stop.location] })));
  const summary = {
    routes: plans.length, unassigned: unassigned.length,
    duration: plans.reduce((sum, plan) => sum + plan.duration, 0),
    distance: plans.reduce((sum, plan) => sum + plan.distance, 0),
  };
  return { code: 0, algorithm: 'greedy-insertion', summary, unassigned, routes: plans };
}
