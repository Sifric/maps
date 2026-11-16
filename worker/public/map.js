import { createMapOptions, initialMapStyle } from "./map-options.js";
import { icon, drawIcon } from "./icons.js";
import * as maplibregl from "https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs";
const $ = (id) => document.getElementById(id);
const colours = {
  food: "#ff8126",
  shopping: "#0095f6",
  health: "#ef5261",
  finance: "#547bc4",
  leisure: "#18a879",
  culture: "#b44df0",
  worship: "#7b969f",
  transport: "#567a9a",
  government: "#78909c",
  landmark: "#b44df0",
  other: "#82969d",
};
const icons = {
  food: "restaurant",
  shopping: "shop",
  health: "hospital",
  finance: "bank",
  leisure: "playground",
  culture: "museum",
  worship: "place_of_worship",
  transport: "bus",
  government: "town_hall",
  landmark: "monument",
};
const categoryNames = {
  food: "Restaurant",
  shopping: "Shopping",
  health: "Health",
  finance: "Bank",
  leisure: "Things to do",
  culture: "Culture",
  worship: "Place of worship",
  transport: "Transport",
  government: "Government",
  landmark: "Landmark",
  other: "Place",
};
let map,
  indexPromise,
  category = null,
  selected = null,
  searchTimer,
  statusTimer,
  highlight,
  routeCard,
  mapOptions,
  geolocateControl;
function status(text) {
  $("map-status").textContent = text;
  $("map-status").classList.add("visible");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(
    () => $("map-status").classList.remove("visible"),
    4500,
  );
}
function showError(error) {
  console.error(error);
  $("error").textContent = error.message || String(error);
  $("error").hidden = false;
}
function readStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}
function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    status("Browser storage is unavailable");
  }
}
function element(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function actionLabel(button, text, glyph) {
  button.replaceChildren(icon(glyph), element("span", text));
}
function dotImage(kind) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 144;
  const c = canvas.getContext("2d");
  c.scale(2, 2);
  c.fillStyle = colours[kind] || colours.other;
  c.beginPath();
  c.arc(32, 68, 5, 0, Math.PI * 2);
  c.fill();
  return { width: 128, height: 144, data: c.getImageData(0, 0, 128, 144).data };
}
function markerImage(kind) {
  const canvas = document.createElement("canvas");
  // 4× bitmap density keeps the circular outline smooth on high-DPI screens.
  canvas.width = 128;
  canvas.height = 144;
  const c = canvas.getContext("2d");
  c.scale(2, 2);
  const colour = colours[kind] || colours.other;
  c.shadowColor = "#0003";
  c.shadowBlur = 8;
  c.shadowOffsetY = 2;
  c.fillStyle = colour;
  c.strokeStyle = "#fff";
  c.lineWidth = 2.8;
  c.lineJoin = "round";
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(32, 7);
  c.bezierCurveTo(44.7, 7, 55, 17.3, 55, 30);
  c.bezierCurveTo(55, 41, 47.8, 50, 38, 52.4);
  c.bezierCurveTo(36, 52.8, 34.8, 57, 33, 58);
  c.quadraticCurveTo(32, 59, 31, 58);
  c.bezierCurveTo(29.2, 57, 28, 52.8, 26, 52.4);
  c.bezierCurveTo(16.2, 50, 9, 41, 9, 30);
  c.bezierCurveTo(9, 17.3, 19.3, 7, 32, 7);
  c.closePath();
  c.fill();
  c.stroke();
  c.shadowColor = "transparent";
  drawIcon(c, icons[kind] || "place", 18, 15, 28, "#fff");
  return { width: 128, height: 144, data: c.getImageData(0, 0, 128, 144).data };
}
function stylePlaces(style) {
  const layers = Object.fromEntries(style.layers.map((l) => [l.id, l]));
  for (const id of [
    "mazo-places-pin",
    "mazo-places-label",
    "mazo-places-subtitle",
  ])
    if (layers[id])
      layers[id].layout = { ...(layers[id].layout || {}), visibility: "none" };
  const dot = layers["mazo-places-dot"];
  // Fallback dots share the pin collision footprint, so they yield to named
  // pins and to each other instead of drawing an unrestricted cloud of points.
  dot.type = "symbol";
  delete dot.maxzoom;
  dot.layout = {
    "icon-image": ["concat", "lk-dot-", ["get", "kind"]],
    "icon-size": [
      "interpolate",
      ["linear"],
      ["zoom"],
      7,
      0.65,
      12,
      0.8,
      16,
      0.9,
    ],
    "icon-anchor": "bottom",
    "icon-allow-overlap": false,
    "icon-ignore-placement": false,
    "icon-padding": 8,
  };
  dot.paint = {};
  const pin = layers["mazo-places-icon"];
  pin.minzoom = 7;
  delete pin.filter;
  pin.layout = {
    "icon-image": ["concat", "lk-pin-", ["get", "kind"]],
    "icon-size": [
      "interpolate",
      ["linear"],
      ["zoom"],
      7,
      0.65,
      12,
      0.8,
      14,
      0.85,
      16,
      0.9,
    ],
    "icon-anchor": "bottom",
    "icon-allow-overlap": false,
    "icon-padding": 8,
    "icon-optional": false,
    "text-field": /^en(?:-|$)/i.test(navigator.language)
      ? ["coalesce", ["get", "label"], ["get", "name"]]
      : ["get", "name"],
    "text-font": ["Mazo Maps Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 12, 12, 16, 13],
    "text-variable-anchor-offset": [
      "left",
      [1.1, -1.35],
      "right",
      [-1.1, -1.35],
      "bottom",
      [0, -2.3],
      "top",
      [0, 0.3],
    ],
    "text-justify": "auto",
    "text-optional": false,
    "text-allow-overlap": false,
    "text-padding": 6,
    "text-max-width": 10,
    "symbol-sort-key": [
      "match",
      ["get", "kind"],
      "food",
      1,
      "leisure",
      2,
      "culture",
      3,
      "shopping",
      4,
      "transport",
      5,
      "health",
      6,
      "finance",
      7,
      "worship",
      8,
      "government",
      9,
      10,
    ],
  };
  pin.paint = {
    "text-color": [
      "match",
      ["get", "kind"],
      ...Object.entries(colours)
        .filter(([k]) => k !== "other")
        .flat(),
      colours.other,
    ],
    "text-halo-color": "#ffffff",
    "text-halo-width": 1.5,
    "text-halo-blur": 0.5,
  };
  const selectedLabel = structuredClone(pin);
  selectedLabel.id = "mazo-places-selected-label";
  selectedLabel.layout = Object.fromEntries(
    Object.entries(pin.layout).filter(
      ([key]) => key.startsWith("text-") || key === "symbol-sort-key",
    ),
  );
  selectedLabel.layout["text-allow-overlap"] = true;
  selectedLabel.layout["text-ignore-placement"] = true;
  selectedLabel.filter = ["==", ["id"], "__no_selected_place__"];
  selectedLabel.paint = { ...pin.paint };
  dot.layout["symbol-sort-key"] = pin.layout["symbol-sort-key"];
  // Geographic names keep placement priority over businesses at overview zooms.
  const base = style.layers.filter((layer) => layer !== dot && layer !== pin);
  const geographicNames = base.findIndex(
    (layer) => layer["source-layer"] === "place",
  );
  base.splice(geographicNames < 0 ? base.length : geographicNames, 0, dot, pin);
  base.push(selectedLabel);
  style.layers = base;
  return style;
}
async function searchIndex() {
  if (!indexPromise)
    indexPromise = fetch("/assets/places-search.json.gz").then(async (r) => {
      if (!r.ok) throw Error("Place search could not be loaded");
      if (typeof DecompressionStream === "undefined")
        throw Error("This browser cannot decompress the place search index");
      const stream = r.body.pipeThrough(new DecompressionStream("gzip"));
      return new Response(stream).json();
    });
  return indexPromise;
}
function panel(title) {
  $("suggestions").hidden = true;
  $("panel").hidden = false;
  const content = $("panel-content");
  content.replaceChildren(element("h1", title));
  return content;
}
function closePanel() {
  $("panel").hidden = true;
  document.body.classList.remove("routing-open");
  routeCard?.remove();
  routeCard = null;
  if (highlight) {
    highlight.remove();
    highlight = null;
  }
  applyPlaceFilters();
}
function saveRecent(row) {
  const recents = readStored("lk-recents").filter((r) => r[0] !== row[0]);
  writeStored("lk-recents", [row, ...recents].slice(0, 15));
}
function showPlace(row, fly = true) {
  selected = row;
  saveRecent(row);
  $("search").value = row[1];
  $("clear-search").hidden = false;
  const c = panel(row[1]);
  c.append(
    element("p", row[5] || categoryNames[row[4]] || "Place", "detail-kind"),
  );
  const actions = element("div", undefined, "detail-actions");
  const route = element("button", "Directions");
  actionLabel(route, "Directions", "directions");
  route.onclick = () => showDirections(row);
  const save = element(
    "button",
    readStored("lk-saved").some((r) => r[0] === row[0]) ? "Saved" : "Save",
  );
  actionLabel(
    save,
    save.textContent,
    save.textContent === "Saved" ? "bookmark_check" : "bookmark",
  );
  save.onclick = () => {
    const all = readStored("lk-saved"),
      found = all.some((r) => r[0] === row[0]);
    writeStored(
      "lk-saved",
      found ? all.filter((r) => r[0] !== row[0]) : [row, ...all],
    );
    actionLabel(
      save,
      found ? "Save" : "Saved",
      found ? "bookmark" : "bookmark_check",
    );
    status(found ? "Removed from saved places" : "Place saved");
  };
  const share = element("button", "Share");
  actionLabel(share, "Share", "share");
  share.onclick = async () => {
    const u = new URL(location.href);
    u.searchParams.set("place", row[0]);
    u.hash = `${Math.max(map.getZoom(), 14).toFixed(2)}/${row[3]}/${row[2]}`;
    try {
      await navigator.clipboard.writeText(u.href);
      status("Link copied");
    } catch {
      status(u.href);
    }
  };
  actions.append(route, save, share);
  c.append(
    actions,
    element("p", "Sri Lanka"),
    element(
      "p",
      `${Number(row[3]).toFixed(6)}, ${Number(row[2]).toFixed(6)}`,
      "coordinate",
    ),
    element(
      "p",
      "Place information from the Sri Lanka places dataset.",
      "panel-note",
    ),
  );
  if (highlight) highlight.remove();
  const selectedPin = element("div", undefined, "selected-marker");
  selectedPin.append(icon("selected_place"));
  highlight = new maplibregl.Marker({ element: selectedPin, anchor: "bottom" })
    .setLngLat([row[2], row[3]])
    .addTo(map);
  applyPlaceFilters();
  if (fly)
    map.flyTo({
      center: [row[2], row[3]],
      zoom: Math.max(15, map.getZoom()),
      padding:
        innerWidth > 900
          ? { left: 400, right: 30, top: 70, bottom: 50 }
          : { left: 0, right: 0, top: 100, bottom: 300 },
      duration: 1000,
    });
}
function showList(title, rows) {
  const c = panel(title);
  if (!rows.length)
    c.append(
      element("p", "No places here yet. Search for a place to get started."),
    );
  for (const row of rows) {
    const b = resultRow(row);
    b.onclick = () => showPlace(row);
    c.append(b);
  }
}
function resultRow(row) {
  const b = element("button", undefined, "result");
  b.type = "button";
  const glyph = element("span", undefined, "result-icon");
  glyph.append(icon(icons[row[4]] || "place"));
  const text = element("span");
  text.append(
    element("strong", row[1]),
    element(
      "small",
      `${row[5] || categoryNames[row[4]] || "Place"} · Sri Lanka`,
    ),
  );
  b.append(glyph, text);
  return b;
}
async function searchPlaces() {
  const q = $("search").value.trim().toLocaleLowerCase();
  $("clear-search").hidden = !q;
  const box = $("suggestions");
  box.replaceChildren();
  if (q.length < 2) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.append(element("div", "Searching Sri Lanka…", "empty"));
  try {
    const rows = await searchIndex();
    if ($("search").value.trim().toLocaleLowerCase() !== q) return;
    const words = q.split(/\s+/);
    const found = rows
      .filter((r) => {
        const names = `${r[1]} ${r[6] || ""}`.toLocaleLowerCase();
        return words.every((w) => names.includes(w));
      })
      .sort(
        (a, b) =>
          Number(!a[1].toLocaleLowerCase().startsWith(q)) -
          Number(!b[1].toLocaleLowerCase().startsWith(q)),
      )
      .slice(0, 10);
    box.replaceChildren();
    if (!found.length)
      box.append(
        element("div", "No matching places found. Try another name.", "empty"),
      );
    for (const row of found) {
      const b = resultRow(row);
      b.setAttribute("role", "option");
      b.onclick = () => showPlace(row);
      box.append(b);
    }
  } catch (e) {
    box.replaceChildren(element("div", e.message, "empty"));
  }
}
function applyPlaceFilters() {
  const filters = [];
  if (category) filters.push(["==", ["get", "kind"], category]);
  if (selected && highlight) filters.push(["!=", ["id"], selected[0]]);
  for (const id of ["mazo-places-dot", "mazo-places-icon"])
    if (map?.getLayer(id))
      map.setFilter(id, filters.length ? ["all", ...filters] : null);
  if (map?.getLayer("mazo-places-selected-label"))
    map.setFilter(
      "mazo-places-selected-label",
      selected && highlight
        ? ["==", ["id"], selected[0]]
        : ["==", ["id"], "__no_selected_place__"],
    );
}
function filterCategory(kind) {
  category = category === kind ? null : kind;
  for (const b of $("categories").querySelectorAll("[data-kind]"))
    b.classList.toggle("active", b.dataset.kind === category);
  $("reset-category").hidden = !category;
  applyPlaceFilters();
  status(
    category
      ? `Showing ${categoryNames[category].toLowerCase()} places`
      : "Showing all categories",
  );
}
function showDirections(row) {
  const c = panel("Drive");
  c.classList.add("route-panel");
  document.body.classList.add("routing-open");
  routeCard?.remove();
  routeCard = element("section", undefined, "route-card");
  routeCard.setAttribute("aria-label", "Route locations");

  const makeField = (label, kind) => {
    const wrap = element("div", undefined, `route-field-wrap route-${kind}`);
    const mark = element("span", undefined, "route-point-mark");
    mark.setAttribute("aria-hidden", "true");
    const input = element("input");
    input.className = "route-input";
    input.placeholder = label;
    input.setAttribute("aria-label", label);
    input.autocomplete = "off";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    const suggestions = element("div", undefined, "route-suggestions");
    suggestions.setAttribute("role", "listbox");
    wrap.append(mark, input, suggestions);
    bindRouteSearch(input, suggestions);
    return { wrap, input, suggestions };
  };
  const origin = makeField("Starting point", "origin");
  const destination = makeField("Destination", "destination");
  if (row) {
    destination.input.value = row[1] || "";
    setRoutePointData(destination.input, Number(row[2]), Number(row[3]), row[1]);
  }

  const line = element("span", undefined, "route-waypoint-line");
  const swap = element("button", "↕", "route-swap");
  swap.type = "button";
  swap.title = "Swap starting point and destination";
  swap.setAttribute("aria-label", swap.title);
  swap.onclick = () => {
    const a = routePointData(origin.input), b = routePointData(destination.input);
    [origin.input.value, destination.input.value] = [destination.input.value, origin.input.value];
    setRoutePointData(origin.input, b?.lng, b?.lat, b?.label);
    setRoutePointData(destination.input, a?.lng, a?.lat, a?.label);
    origin.suggestions.hidden = destination.suggestions.hidden = true;
  };
  const routeFields = element("div", undefined, "route-fields");
  routeFields.append(origin.wrap, destination.wrap, line, swap);
  const useLocation = element("button", "Use current location", "route-location");
  useLocation.type = "button";
  useLocation.prepend(icon("locate"));
  useLocation.onclick = () => {
    if (!navigator.geolocation) {
      setRouteMessage("Location is not available in this browser.", true, summary);
      return;
    }
    useLocation.disabled = true;
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const label = `${coords.latitude.toFixed(6)}, ${coords.longitude.toFixed(6)}`;
        origin.input.value = label;
        setRoutePointData(origin.input, coords.longitude, coords.latitude, label);
        useLocation.disabled = false;
      },
      () => {
        useLocation.disabled = false;
        setRouteMessage("Could not get your location. Check location permission.", true, summary);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  };
  const go = element("button", undefined, "route-launch");
  go.type = "button";
  go.setAttribute("aria-label", "Find route");
  go.title = "Find route";
  go.prepend(icon("directions"));
  routeCard.append(routeFields, useLocation, go);
  document.body.append(routeCard);

  const summary = element("p", "Choose both locations to see a route.", "route-summary");
  const steps = element("ol", undefined, "route-steps");
  const tabs = element("nav", undefined, "route-mode-tabs");
  tabs.setAttribute("aria-label", "Travel mode");
  let activeMode = "drive", routeRequested = false;
  const modes = [
    ["drive", "Drive", "directions"],
    ["twoWheeler", "Two-wheeler", "bicycle"],
    ["walk", "Walk", "locate"],
  ];
  for (const [value, label, glyph] of modes) {
    const tab = element("button", undefined, "route-mode-tab");
    tab.type = "button";
    tab.dataset.mode = value;
    tab.setAttribute("aria-pressed", String(value === activeMode));
    tab.append(icon(glyph), element("span", label), element("small", "—", "route-mode-time"));
    tab.onclick = () => {
      activeMode = value;
      for (const item of tabs.querySelectorAll("button")) {
        const selected = item.dataset.mode === activeMode;
        item.classList.toggle("active", selected);
        item.setAttribute("aria-pressed", String(selected));
      }
      c.querySelector("h1").textContent = label;
      if (routeRequested) calculate();
    };
    tabs.append(tab);
  }
  const routeNote = element("p", undefined, "route-note");
  routeNote.append("Routing: OSRM · © OpenStreetMap contributors. Providers may log route requests. ");
  const fixMapLink = element("a", "Fix the map");
  fixMapLink.href = "https://www.openstreetmap.org/fixthemap";
  fixMapLink.target = "_blank";
  fixMapLink.rel = "noopener noreferrer";
  routeNote.append(fixMapLink);
  c.append(tabs, summary, routeNote, steps);
  const calculate = () => {
    routeRequested = true;
    findRoute(origin.input.value, destination.input.value, row, activeMode, go, summary, steps, origin.input, destination.input, tabs);
  };
  go.onclick = calculate;
  for (const input of [origin.input, destination.input])
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const first = input.parentElement.querySelector(".route-suggestions button");
        if (first && !input.parentElement.querySelector(".route-suggestions").hidden) first.click();
        else calculate();
      }
    });
}

function setRoutePointData(input, lng, lat, label) {
  if (Number.isFinite(lng) && Number.isFinite(lat)) {
    input.dataset.routeLng = String(lng);
    input.dataset.routeLat = String(lat);
    input.dataset.routeLabel = label || input.value;
  } else {
    delete input.dataset.routeLng;
    delete input.dataset.routeLat;
    delete input.dataset.routeLabel;
  }
}

function routePointData(input) {
  if (input.dataset.routeLng === undefined || input.dataset.routeLat === undefined) return null;
  return { lng: Number(input.dataset.routeLng), lat: Number(input.dataset.routeLat), label: input.dataset.routeLabel };
}

function bindRouteSearch(input, list) {
  input.addEventListener("input", () => {
    setRoutePointData(input, NaN, NaN);
    showRouteSuggestions(input, list);
  });
  input.addEventListener("focus", () => showRouteSuggestions(input, list));
  input.addEventListener("blur", () => setTimeout(() => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }, 150));
}

async function showRouteSuggestions(input, list) {
  const query = input.value.trim().toLocaleLowerCase();
  list.replaceChildren();
  if (query.length < 2) {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    return;
  }
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  list.append(element("div", "Searching places…", "route-suggestion-empty"));
  try {
    const rows = await searchIndex();
    if (input.value.trim().toLocaleLowerCase() !== query) return;
    const words = query.split(/\s+/);
    const matches = rows.filter((r) => {
      const names = `${r[1] || ""} ${r[6] || ""}`.toLocaleLowerCase();
      return words.every((word) => names.includes(word));
    }).sort((a, b) => Number(!String(a[1]).toLocaleLowerCase().startsWith(query)) - Number(!String(b[1]).toLocaleLowerCase().startsWith(query))).slice(0, 7);
    list.replaceChildren();
    if (!matches.length) list.append(element("div", "No matching places", "route-suggestion-empty"));
    for (const row of matches) {
      const option = element("button", undefined, "route-option");
      option.type = "button";
      option.setAttribute("role", "option");
      option.append(element("strong", row[1]), element("small", row[5] || "Sri Lanka"));
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.onclick = () => {
        input.value = row[1];
        setRoutePointData(input, Number(row[2]), Number(row[3]), row[1]);
        list.hidden = true;
        input.setAttribute("aria-expanded", "false");
      };
      list.append(option);
    }
  } catch {
    list.replaceChildren(element("div", "Place suggestions are unavailable", "route-suggestion-empty"));
  }
}

function setRouteMessage(text, isError = false, summary) {
  if (!summary?.isConnected) return;
  summary.textContent = text;
  summary.classList.toggle("route-error", isError);
  summary.hidden = false;
}

async function resolveRoutePoint(query, preferredRow, input) {
  const value = query.trim();
  const picked = input && routePointData(input);
  if (picked && picked.label.toLocaleLowerCase() === value.toLocaleLowerCase())
    return { label: picked.label, coordinates: [picked.lng, picked.lat] };
  if (preferredRow && value.toLocaleLowerCase() === String(preferredRow[1]).toLocaleLowerCase())
    return { label: preferredRow[1], coordinates: [Number(preferredRow[2]), Number(preferredRow[3])] };
  const coordinate = value.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (coordinate) {
    const lat = Number(coordinate[1]), lng = Number(coordinate[2]);
    if (lat < 5 || lat > 10.5 || lng < 78 || lng > 82.5)
      throw Error("Enter a location inside Sri Lanka.");
    return { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, coordinates: [lng, lat] };
  }
  if (!value) throw Error("Enter both a starting point and a destination.");
  const rows = await searchIndex(), normalized = value.toLocaleLowerCase();
  const match = rows.find((r) => String(r[1]).toLocaleLowerCase() === normalized) ||
    rows.find((r) => String(r[1]).toLocaleLowerCase().startsWith(normalized)) ||
    rows.find((r) => String(r[1]).toLocaleLowerCase().includes(normalized));
  if (!match) throw Error(`Couldn't find “${value}” in the Sri Lanka places index.`);
  return { label: match[1], coordinates: [Number(match[2]), Number(match[3])] };
}

async function findRoute(originText, destinationText, destinationRow, mode, button, summary, steps, originInput, destinationInput, tabs) {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const modeNames = { drive: "Driving", twoWheeler: "Two-wheeler", walk: "Walking" };
  setRouteMessage(`Finding a ${modeNames[mode].toLowerCase()} route…`, false, summary);
  try {
    const [origin, destination] = await Promise.all([
      resolveRoutePoint(originText, null, originInput),
      resolveRoutePoint(destinationText, destinationRow, destinationInput),
    ]);
    const response = await fetch("/api/v1/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin: origin.coordinates, destination: destination.coordinates, mode }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "The route could not be calculated.");
    if (!result.geometry?.coordinates?.length) throw Error("The routing service returned no route geometry.");
    if (!map.getSource("lk-route")) {
      map.addSource("lk-route", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: result.geometry },
      });
      const before = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
      map.addLayer({
        id: "lk-route-casing", type: "line", source: "lk-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 5, 16, 10] },
      }, before);
      map.addLayer({
        id: "lk-route-line", type: "line", source: "lk-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#1a73e8", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 3, 16, 6] },
      }, before);
    } else {
      map.getSource("lk-route").setData({ type: "Feature", properties: {}, geometry: result.geometry });
    }
    const bounds = new maplibregl.LngLatBounds();
    for (const point of result.geometry.coordinates) bounds.extend(point);
    map.fitBounds(bounds, {
      padding: { top: 110, bottom: innerWidth < 600 ? 300 : 60, left: innerWidth > 900 ? 430 : 40, right: 40 },
      maxZoom: 15,
      duration: 700,
    });
    const distance = result.distance >= 1000
      ? `${(result.distance / 1000).toFixed(1)} km`
      : `${Math.round(result.distance)} m`;
    const minutes = Math.round(result.duration / 60);
    const duration = minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`;
    setRouteMessage(`${origin.label} → ${destination.label} · ${modeNames[mode]} · ${distance} · ${duration}`, false, summary);
    const time = tabs?.querySelector(`[data-mode="${mode}"] .route-mode-time`);
    if (time) time.textContent = duration;
    steps.replaceChildren(...(result.steps || []).slice(0, 10).map((step) => {
      const distance = step.distance >= 1000
        ? `${(step.distance / 1000).toFixed(1)} km`
        : `${Math.round(step.distance)} m`;
      return element("li", `${step.text || "Continue"} · ${distance}`);
    }));
  } catch (error) {
    steps.replaceChildren();
    setRouteMessage(error.message || "The route could not be calculated.", true, summary);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchPlaces, 150);
});
$("search").addEventListener("focus", () => {
  if ($("search").value.length > 1) searchPlaces();
});
$("search").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    const first = $("suggestions").querySelector("button");
    if (first) {
      e.preventDefault();
      first.focus();
    }
  }
});
$("suggestions").addEventListener("keydown", (e) => {
  const options = [...$("suggestions").querySelectorAll("button")],
    i = options.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = options[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) next.focus();
    else if (e.key === "ArrowUp") $("search").focus();
  }
});
$("search-form").onsubmit = (e) => {
  e.preventDefault();
  const first = $("suggestions").querySelector("button");
  if (first) first.click();
  else searchPlaces();
};
$("clear-search").onclick = () => {
  $("search").value = "";
  $("clear-search").hidden = true;
  $("suggestions").hidden = true;
  closePanel();
  $("search").focus();
};
$("close-panel").onclick = closePanel;
$("saved").onclick = () => showList("Saved places", readStored("lk-saved"));
$("recent").onclick = () =>
  showList("Recent searches", readStored("lk-recents"));
$("directions").onclick = () => showDirections(selected);
$("categories")
  .querySelectorAll("[data-kind]")
  .forEach((b) => (b.onclick = () => filterCategory(b.dataset.kind)));
$("reset-category").onclick = () => filterCategory(category);
$("zoom-in").onclick = () => map.zoomIn({ duration: 250 });
$("zoom-out").onclick = () => map.zoomOut({ duration: 250 });
$("compass").onclick = () =>
  map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
$("locate").onclick = () => {
  if (!navigator.geolocation) {
    status("Geolocation is unavailable");
    return;
  }
  if (!geolocateControl) {
    status("The map is still loading. Try again in a moment.");
    return;
  }
  const button = $("locate");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (!geolocateControl.trigger()) {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    status("Location is unavailable. Check your browser location permission.");
  }
};
$("menu").onclick = () => {
  const c = panel("LK Maps");
  const items = [
    [
      "Explore Sri Lanka",
      () => {
        closePanel();
        map.flyTo({ center: [80.7, 7.9], zoom: 7 });
      },
    ],
    ["Saved places", () => showList("Saved places", readStored("lk-saved"))],
    [
      "Recent searches",
      () => showList("Recent searches", readStored("lk-recents")),
    ],
  ];
  for (const [name, fn] of items) {
    const b = element("button", name, "menu-option");
    b.prepend(
      icon(
        name === "Explore Sri Lanka"
          ? "home"
          : name === "Saved places"
            ? "bookmark"
            : "history",
      ),
    );
    b.onclick = fn;
    c.append(b);
  }
  c.append(
    element(
      "p",
      "An independent map of Sri Lanka. Not affiliated with Google.",
      "panel-note",
    ),
    element("p", "© OpenStreetMap contributors", "attribution-note"),
  );
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("suggestions").hidden = true;
    closePanel();
  }
});
(async () => {
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  const r = await fetch("/style.json");
  if (!r.ok) throw Error(`Style fetch failed: ${r.status}`);
  const style = stylePlaces(await r.json());
  let center = [80.7, 7.9],
    zoom = 7;
  const hash = location.hash.slice(1).split("/").map(Number);
  if (
    hash.length === 3 &&
    hash.every(Number.isFinite) &&
    hash[0] >= 0 &&
    hash[0] <= 20 &&
    hash[1] >= -85 &&
    hash[1] <= 85 &&
    hash[2] >= -180 &&
    hash[2] <= 180
  ) {
    zoom = hash[0];
    center = [hash[2], hash[1]];
  }
  const initialCamera =
    innerWidth < 600 && hash.length !== 3
      ? {
          bounds: [
            [79.5, 5.9],
            [82.0, 9.9],
          ],
          fitBoundsOptions: {
            padding: { top: 130, bottom: 70, left: 20, right: 20 },
          },
        }
      : { center, zoom };
  map = new maplibregl.Map({
    container: "map",
    style: initialMapStyle(style),
    ...initialCamera,
    maxZoom: 20,
    attributionControl: true,
    renderWorldCopies: false,
  });
  window.map = map;
  map.on("styleimagemissing", (e) => {
    if (e.id.startsWith("lk-pin-") && !map.hasImage(e.id))
      map.addImage(e.id, markerImage(e.id.slice(7)), { pixelRatio: 4 });
    if (e.id.startsWith("lk-dot-") && !map.hasImage(e.id))
      map.addImage(e.id, dotImage(e.id.slice(7)), { pixelRatio: 4 });
  });
  map.on("error", (e) => {
    if (!mapOptions?.handleError(e)) showError(e.error);
  });
  map.addControl(
    new maplibregl.ScaleControl({ maxWidth: 80, unit: "metric" }),
    "bottom-right",
  );
  // One-shot requests only: retain the location dot without background tracking.
  geolocateControl = new maplibregl.GeolocateControl({
    positionOptions: {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 30000,
    },
    trackUserLocation: false,
    showUserLocation: true,
    showAccuracyCircle: true,
    fitBoundsOptions: { maxZoom: 15, duration: 1000 },
  });
  map.addControl(geolocateControl, "top-right");
  geolocateControl.on("geolocate", () => {
    const button = $("locate");
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.dataset.location = "ready";
    button.setAttribute("aria-label", "Recenter on your location");
    button.title = "Recenter on your location";
  });
  geolocateControl.on("error", () => {
    $("locate").disabled = false;
    $("locate").removeAttribute("aria-busy");
    status("Location permission was denied or the location is unavailable");
  });
  for (const layer of ["mazo-places-icon", "mazo-places-dot"]) {
    map.on("click", layer, (e) => {
      const f = e.features[0],
        p = f.properties;
      showPlace([
        f.id,
        p.name,
        ...f.geometry.coordinates,
        p.kind,
        p.subtitle || "",
      ]);
    });
    map.on(
      "mouseenter",
      layer,
      () => (map.getCanvas().style.cursor = "pointer"),
    );
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }
  map.on("click", (e) => {
    if (
      !map.queryRenderedFeatures(e.point, {
        layers: ["mazo-places-icon", "mazo-places-dot"],
      }).length
    )
      $("suggestions").hidden = true;
  });
  map.once("load", async () => {
    mapOptions = createMapOptions(map, { baseStyle: style, status });
    const id = new URL(location.href).searchParams.get("place");
    if (id) {
      const row = (await searchIndex()).find((r) => String(r[0]) === id);
      if (row) showPlace(row);
    }
  });
})().catch(showError);
