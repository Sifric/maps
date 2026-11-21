import { routingProfile, routingRequest, RoutingError } from './routing.mjs';

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

function skills(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 20) invalid('Use at most 20 skill IDs.');
  return values.map(value => integer(value, 'skill ID'));
}

function priority(value) {
  const rank = integer(value ?? 0, 'priority');
  if (rank > 100) invalid('Priority must be between 0 and 100.');
  return rank;
}

function limit(value, label) {
  return value === undefined ? Infinity : integer(value, label);
}

function parse(body) {
  const { vehicles, jobs = [], shipments = [] } = body;
  if (!Array.isArray(vehicles) || !vehicles.length || vehicles.length > 8 ||
      !Array.isArray(jobs) || !Array.isArray(shipments) || !jobs.length && !shipments.length ||
      jobs.length + 2 * shipments.length > 16) {
    invalid('Provide 1 to 8 vehicles and 1 to 16 job, pickup, or delivery stops.');
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
      if (locations.length === 20) invalid('Use at most 20 distinct locations.');
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
    return {
      id: id(value.id, type), type, location: location(value.location),
      service: integer(value.service ?? 0, 'service duration'),
      setup: integer(value.setup ?? 0, 'setup duration'),
      skills: skills(value.skills),
      priority: priority(value.priority),
      windows: windowList(value.time_windows), pickup, delivery,
    };
  }
  const fleet = vehicles.map(vehicle => {
    if (!vehicle?.start || (vehicle.profile ?? 'drive') !== 'drive') invalid('Each vehicle needs a start and the drive profile.');
    if (vehicle.breaks !== undefined || vehicle.costs !== undefined) {
      invalid('Driver breaks and custom vehicle costs are unavailable.');
    }
    return {
      id: id(vehicle.id, 'vehicle'),
      start: location(vehicle.start), end: vehicle.end === undefined ? null : location(vehicle.end),
      capacity: amounts(vehicle.capacity), window: windowList(vehicle.time_window === undefined ? undefined : [vehicle.time_window])[0],
      skills: new Set(skills(vehicle.skills)),
      maxStops: limit(vehicle.max_tasks, 'maximum stop count'),
      maxTravel: limit(vehicle.max_travel_time, 'maximum travel duration'),
      maxDistance: limit(vehicle.max_distance, 'maximum distance'),
    };
  });
  const tasks = jobs.map(job => [stop(job, 'job', amounts(job?.pickup), amounts(job?.delivery))]);
  for (const shipment of shipments) {
    const amount = amounts(shipment?.amount);
    const stops = [
      stop(shipment?.pickup, 'pickup', amount, amounts()),
      stop(shipment?.delivery, 'delivery', amounts(), amount),
    ];
    const shipmentSkills = skills(shipment.skills);
    for (const item of stops) {
      item.skills.push(...shipmentSkills);
      item.priority = Math.max(item.priority, priority(shipment.priority));
    }
    tasks.push(stops);
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
    const setup = current === stop.location ? 0 : stop.setup;
    start = serviceStart + setup + stop.service;
    for (let i = 0; i < load.length; i++) {
      if (load[i] < stop.delivery[i]) return null;
      load[i] += stop.pickup[i] - stop.delivery[i];
      if (load[i] > vehicle.capacity[i]) return null;
    }
    steps.push({ type: stop.type, id: stop.id, location: stop.location, arrival, service: stop.service,
      waiting_time: serviceStart - arrival, ...(setup && { setup }), load: [...load] });
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
  if (start > vehicle.window[1] || duration > vehicle.maxTravel || distance > vehicle.maxDistance) return null;
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
  const preferences = { mode: 'drive', avoidTolls: body.avoidTolls, avoidHighways: body.avoidHighways };
  routingProfile(preferences);
  const { fleet, tasks, locations } = parse(body);
  const matrix = locations.length === 1 ? { durations: [[0]], distances: [[0]] } :
    await matrixRequest(bucket, 'matrix', { coordinates: locations, ...preferences });
  const routes = fleet.map(vehicle => ({ vehicle, stops: [], plan: null }));
  for (;;) {
    let best;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const rank = Math.max(...task.map(stop => stop.priority));
      if (best && rank < best.rank) continue;
      let candidate;
      let feasibleVehicles = 0;
      for (const route of routes) {
        if (route.stops.length + task.length > route.vehicle.maxStops ||
            task.some(stop => stop.skills.some(skill => !route.vehicle.skills.has(skill)))) continue;
        let feasible = false;
        for (const stops of insertions(route.stops, task)) {
          const plan = evaluate(route.vehicle, stops, matrix);
          if (!plan) continue;
          feasible = true;
          const cost = plan.duration - (route.plan?.duration ?? 0);
          if (!candidate || cost < candidate.cost) candidate = { i, route, stops, plan, cost, rank };
        }
        if (feasible) feasibleVehicles++;
      }
      if (candidate && (!best || rank > best.rank || feasibleVehicles < best.feasibleVehicles ||
          (feasibleVehicles === best.feasibleVehicles && candidate.cost < best.cost))) {
        best = { ...candidate, feasibleVehicles };
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
