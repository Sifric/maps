import { createMapOptions, initialMapStyle } from "./map-options.js";
import { icon } from "./icons.js";
import { placeIcons, registerPlaceImages, selectedPlaceElement, stylePlaces } from "./place-markers.js";
const maplibregl = window.maplibregl;
const $ = (id) => document.getElementById(id);
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
const categoryPatterns = {
  food: /restaurant|fast food|food court/i, coffee: /caf[eé]|coffee/i,
  hotel: /hotel|guest house|resort|hostel|motel/i, fuel: /fuel|petrol|filling station/i,
  pharmacy: /pharmacy/i, atm: /\batm\b/i, park: /\bpark\b|garden|playground/i,
};
const matchesCategory = (row, kind) => kind === "food"
  ? row[4] === "food" && !categoryPatterns.coffee.test(row[5] || "")
  : categoryPatterns[kind].test(`${row[5] || ""} ${row[1]}`);
let map,
  indexPromise,
  category = null,
  selected = null,
  searchTimer,
  statusTimer,
  highlight,
  routeCard,
  mapOptions,
  geolocateControl,
  routeRequestVersion = 0;
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
function roadDirectionImage() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  // Muted grey arrow with a subtle darker outline for both map themes.
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(32, 47);
  ctx.lineTo(32, 17);
  ctx.moveTo(21, 29);
  ctx.lineTo(32, 17);
  ctx.lineTo(43, 29);
  ctx.strokeStyle = "rgba(31, 41, 55, 0.6)";
  ctx.lineWidth = 9;
  ctx.stroke();
  ctx.strokeStyle = "#cbd2da";
  ctx.lineWidth = 5.5;
  ctx.stroke();
  return { width: 64, height: 64, data: ctx.getImageData(0, 0, 64, 64).data };
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
let displayedRoutes = [], displayedRouteIndex = 0, routePreview = 0;
function stopRoutePreview() {
  if (routePreview) cancelAnimationFrame(routePreview);
  routePreview = 0;
  const button = $("route-preview");
  if (button) button.textContent = "Start preview";
}
function routeDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}
function routeDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`;
}
function routeOverview() {
  if (!displayedRoutes.length) return;
  stopRoutePreview();
  const bounds = new maplibregl.LngLatBounds();
  displayedRoutes.forEach((route) => route.geometry.coordinates.forEach((point) => bounds.extend(point)));
  map.fitBounds(bounds, { padding: bottomPanelPadding(), retainPadding: false, maxZoom: 16, pitch: 0, bearing: 0, duration: 650 });
}
function previewRoute(route) {
  if (routePreview) return stopRoutePreview();
  const points = route.geometry.coordinates;
  if (points.length < 2) return;
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + gpsDistanceMeters(
    { longitude: points[i - 1][0], latitude: points[i - 1][1] },
    { longitude: points[i][0], latitude: points[i][1] },
  ));
  const total = lengths.at(-1);
  if (!total) return;
  const duration = Math.min(30000, Math.max(6000, total * 4));
  const start = performance.now();
  let index = 1;
  $("route-preview").textContent = "Stop preview";
  const frame = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const traveled = progress * total;
    while (index < points.length - 1 && lengths[index] < traveled) index++;
    const from = points[index - 1], to = points[index];
    const fraction = (traveled - lengths[index - 1]) / (lengths[index] - lengths[index - 1] || 1);
    const center = from.map((coordinate, axis) => coordinate + (to[axis] - coordinate) * fraction);
    map.jumpTo({ center, zoom: 16.5, pitch: 38 });
    if (progress < 1) routePreview = requestAnimationFrame(frame);
    else stopRoutePreview();
  };
  routePreview = requestAnimationFrame(frame);
}
function stopRouteSession() {
  routeRequestVersion++;
  stopRoutePreview();
  displayedRoutes = [];
  if (!map?.getStyle?.()) return;
  for (const id of ["lk-route-line", "lk-route-casing", "lk-route-alt"])
    if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource("lk-route")) map.removeSource("lk-route");
  applyPlaceFilters();
}
const searchShell = document.querySelector(".search-shell");
const searchInput = $("search");
const suggestions = $("suggestions");
let searchVersion = 0;

function dismissSearch(restoreFocus = false) {
  clearTimeout(searchTimer);
  searchVersion++;
  document.body.classList.remove("search-open");
  suggestions.hidden = true;
  searchInput.blur();
  if (category) filterCategory(category);
  if (restoreFocus) $("menu").focus({ preventScroll: true });
}

function setPlaceExpanded(expanded) {
  $("panel").classList.toggle("place-expanded", expanded);
  const grab = $("place-grab");
  grab.setAttribute("aria-expanded", String(expanded));
  grab.setAttribute("aria-label", expanded ? "Collapse place details" : "Expand place details");
}

function bindSheetHandle(handle, sheet, onRelease, onActivate) {
  let start, swiped = false;
  handle.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    start = event.clientY;
    swiped = false;
  });
  handle.addEventListener("pointermove", (event) => {
    if (start === undefined) return;
    if (Math.abs(event.clientY - start) < 8 && !swiped) return;
    swiped = true;
    if (!handle.hasPointerCapture(event.pointerId)) handle.setPointerCapture(event.pointerId);
    sheet.style.translate = `0 ${Math.max(0, event.clientY - start)}px`;
  });
  handle.addEventListener("pointerup", (event) => {
    if (start === undefined) return;
    const distance = event.clientY - start;
    start = undefined;
    sheet.style.translate = "";
    if (swiped) onRelease(distance);
  });
  handle.addEventListener("lostpointercapture", () => {
    start = undefined;
    sheet.style.translate = "";
  });
  handle.addEventListener("click", (event) => {
    if (!swiped || event.detail === 0) onActivate();
    swiped = false;
  });
}

function bottomPanelPadding() {
  const panelHeight = $("panel").getBoundingClientRect().height;
  return {
    top: 32,
    bottom: Math.min(innerHeight * .44, panelHeight + 26),
    left: 32,
    right: 32,
  };
}

function panel(title) {
  if (document.body.classList.contains("routing-open")) {
    stopRouteSession();
    routeCard?.remove();
    routeCard = null;
    document.body.classList.remove("routing-open");
  }
  dismissSearch();
  $("panel").classList.remove("place-card", "route-panel");
  $("place-grab").hidden = true;
  setPlaceExpanded(false);
  $("panel").hidden = false;
  const content = $("panel-content");
  content.replaceChildren(element("h1", title));
  return content;
}
function closePanel() {
  stopRouteSession();
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
async function shareMapLink(url, title) {
  try {
    if (navigator.share) await navigator.share({ title, url: url.href });
    else {
      await navigator.clipboard.writeText(url.href);
      status("Link copied");
    }
  } catch (error) {
    if (error.name !== "AbortError") status(url.href);
  }
}
function shareView() {
  if (!map) return;
  const url = new URL(location.href);
  const center = map.getCenter();
  url.searchParams.delete("place");
  url.searchParams.delete("pin");
  url.hash = `${map.getZoom().toFixed(2)}/${center.lat.toFixed(5)}/${center.lng.toFixed(5)}`;
  return shareMapLink(url, "Sifric Maps");
}
function showDroppedPin({ lng, lat }) {
  showPlace([`pin-${lat.toFixed(6)},${lng.toFixed(6)}`, "Dropped pin", lng, lat, "other", "Selected location"], false);
}
function showPlace(row, fly = true) {
  selected = row;
  saveRecent(row);
  $("search").value = row[1];
  syncSearchAction();
  const c = panel(row[1]);
  $("panel").classList.add("place-card");
  $("place-grab").hidden = false;
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
  share.className = "place-share";
  share.setAttribute("aria-label", "Share place");
  share.title = "Share place";
  share.replaceChildren(icon("share_view"));
  share.onclick = async () => {
    const u = new URL(location.href);
    u.searchParams.delete("pin");
    u.searchParams.delete("place");
    if (String(row[0]).startsWith("pin-")) u.searchParams.set("pin", "1");
    else u.searchParams.set("place", row[0]);
    u.hash = `${Math.max(map.getZoom(), 14).toFixed(2)}/${row[3]}/${row[2]}`;
    await shareMapLink(u, row[1]);
  };
  actions.append(route, save);
  c.append(
    share,
    actions,
    element(
      "p",
      `${Number(row[3]).toFixed(6)}, ${Number(row[2]).toFixed(6)}`,
      "coordinate",
    ),
    element("p", row[6] && row[6] !== row[1] ? row[6] : "Sri Lanka", "panel-note"),
  );
  if (highlight) highlight.remove();
  highlight = new maplibregl.Marker({ element: selectedPlaceElement(), anchor: "bottom" })
    .setLngLat([row[2], row[3]])
    .addTo(map);
  applyPlaceFilters();
  if (fly)
    map.flyTo({
      center: [row[2], row[3]],
      zoom: Math.max(15, map.getZoom()),
      padding: bottomPanelPadding(),
      retainPadding: false,
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
  glyph.append(icon(placeIcons[row[4]] || "place"));
  const text = element("span");
  text.append(
    element("strong", row[1]),
    element(
      "small",
      `${row[5] || categoryNames[row[4]] || "Place"} · Sri Lanka`,
    ),
  );
  b.append(glyph, text);
  const center = map?.getCenter();
  if (center) b.append(element("span", routeDistance(gpsDistanceMeters(
    { longitude: center.lng, latitude: center.lat },
    { longitude: row[2], latitude: row[3] },
  )), "result-distance"));
  return b;
}
async function searchPlaces() {
  const version = ++searchVersion;
  const q = searchInput.value.trim().toLocaleLowerCase();
  syncSearchAction();
  const box = $("suggestions");
  box.replaceChildren();
  if (q.length < 2) {
    const recent = q ? [] : readStored("lk-recents");
    box.hidden = false;
    box.append(element("div", recent.length ? "Recent searches" : q ? "Enter at least two characters" : "Search for a place or explore a category", "empty"));
    for (const row of recent.slice(0, 5)) {
      const option = resultRow(row);
      option.onclick = () => showPlace(row);
      box.append(option);
    }
    return;
  }
  box.hidden = false;
  box.append(element("div", "Searching Sri Lanka…", "empty"));
  try {
    const rows = await searchIndex();
    if (version !== searchVersion || searchInput.value.trim().toLocaleLowerCase() !== q) return;
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
      b.onclick = () => showPlace(row);
      box.append(b);
    }
  } catch (e) {
    if (version === searchVersion)
      box.replaceChildren(element("div", e.message, "empty"));
  }
}
function applyPlaceFilters() {
  const filters = [];

  if (selected && highlight) filters.push(["!=", ["id"], selected[0]]);
  const routing = document.body.classList.contains("routing-open");
  for (const id of ["mazo-places-dot", "mazo-places-icon"]) {
    if (!map?.getLayer(id)) continue;
    const layerFilters = [...filters];
    // While navigating, remove minor POIs and background dots; keep useful
    // landmarks such as hospitals, transport, and public facilities visible.
    if (routing) {
      if (id === "mazo-places-dot") layerFilters.push(["==", ["get", "kind"], "__hidden_during_routing__"]);
      else layerFilters.push(["!", ["in", ["get", "kind"], ["literal", ["food", "shopping", "other", "leisure"]]]]);
    }
    map.setFilter(id, layerFilters.length ? ["all", ...layerFilters] : null);
  }
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
  for (const button of $("categories").querySelectorAll("[data-kind]")) {
    const active = button.dataset.kind === category;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  $("reset-category").hidden = !category;

}
function showDirections(row) {
  const c = panel("Drive");
  $("panel").classList.add("route-panel");
  document.body.classList.add("routing-open");
  applyPlaceFilters();
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
  c.append(routeCard);

  const summary = element("p", "Choose both locations to see a route.", "route-summary");
  const steps = element("ol", undefined, "route-steps");
  const stepToggle = element("details", undefined, "route-itinerary");
  const stepLabel = element("summary", "Steps");
  stepToggle.append(stepLabel, steps);
  stepToggle.hidden = true;
  const alternatives = element("div", undefined, "route-alternatives");
  const arrival = element("output", undefined, "route-arrival");
  const options = element("div", undefined, "route-options");
  const departure = element("select");
  departure.setAttribute("aria-label", "Departure time");
  for (const [minutes, label] of [[0, "Leave now"], [30, "In 30 min"], [60, "In 1 hour"], [120, "In 2 hours"]])
    departure.add(new Option(label, minutes));
  const avoidance = element("select");
  avoidance.setAttribute("aria-label", "Driving preferences");
  for (const [value, label] of [["", "Any roads"], ["tolls", "Avoid tolls"], ["highways", "Avoid highways"]])
    avoidance.add(new Option(label, value));
  options.append(departure, avoidance);
  let updateArrival = () => {};
  departure.onchange = () => updateArrival();
  avoidance.onchange = () => { if (routeRequested) calculate(); };

  const tabs = element("nav", undefined, "route-mode-tabs");
  tabs.setAttribute("aria-label", "Travel mode");
  let activeMode = "drive", routeRequested = false;
  const modes = [
    ["drive", "Drive", "drive"],
    ["twoWheeler", "Two-wheeler", "bicycle"],
    ["walk", "Walk", "walk"],
    ["cycle", "Cycle", "bicycle"],
  ];
  for (const [value, label, glyph] of modes) {
    const tab = element("button", undefined, "route-mode-tab");
    tab.type = "button";
    tab.dataset.mode = value;
    tab.setAttribute("aria-pressed", String(value === activeMode));
    tab.append(icon(glyph), element("span", label), element("small", "—", "route-mode-time"));
    tab.onclick = () => {
      activeMode = value;
      avoidance.disabled = value !== "drive";
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
  const navigationActions = element("div", undefined, "route-navigation-actions");
  const preview = element("button", "Start preview", "route-start-navigation");
  preview.id = "route-preview";
  const overview = element("button", "Overview");
  overview.onclick = routeOverview;
  const end = element("button", "End");
  end.onclick = () => row ? showPlace(row, false) : closePanel();
  navigationActions.append(preview, overview, end);
  navigationActions.hidden = true;
  c.append(tabs, options, summary, arrival, alternatives, navigationActions, stepToggle, routeNote);
  const calculate = async () => {
    routeRequested = true;
    stopRoutePreview();
    updateArrival = () => { arrival.textContent = ""; };
    updateArrival();
    alternatives.replaceChildren();
    navigationActions.hidden = stepToggle.hidden = true;
    const preferences = activeMode === "drive" ? avoidance.value : "";
    const data = await findRoute(origin.input.value, destination.input.value, row, activeMode, go, summary, origin.input, destination.input, preferences);
    if (!data) return;
    displayedRoutes = data.routes;
    const chooseRoute = (index) => {
      stopRoutePreview();
      const route = displayedRoutes[index];
      selectRouteGeometry(displayedRoutes, index);
      const duration = routeDuration(route.duration);
      setRouteMessage(`${data.from} → ${data.to} · ${data.mode} · ${routeDistance(route.distance)} · ${duration}`, false, summary);
      tabs.querySelector(`[data-mode="${activeMode}"] .route-mode-time`).textContent = duration;
      for (const [i, button] of [...alternatives.children].entries()) button.setAttribute("aria-pressed", String(i === index));
      updateArrival = () => {
        const time = new Date(Date.now() + (route.duration + Number(departure.value) * 60) * 1000);
        arrival.textContent = "Estimated arrival " + time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      };
      updateArrival();
      steps.replaceChildren(...route.steps.map((step) => {
        const item = element("li");
        const instruction = element("span", step.text || "Continue");
        const turn = step.maneuver?.modifier || "";
        const glyph = step.maneuver?.type === "arrive" ? "place"
          : turn.includes("left") ? "turn_left" : turn.includes("right") ? "turn_right" : "straight";
        item.append(icon(glyph), instruction, element("small", routeDistance(step.distance)));
        return item;
      }));
      stepLabel.textContent = `${route.steps.length} steps`;
      stepToggle.hidden = !route.steps.length;
      stepToggle.open = false;
      preview.onclick = () => previewRoute(route);
    };
    if (displayedRoutes.length > 1) displayedRoutes.forEach((route, index) => {
      const button = element("button", routeDuration(route.duration));
      button.append(element("small", routeDistance(route.distance)));
      button.onclick = () => chooseRoute(index);
      alternatives.append(button);
    });
    navigationActions.hidden = false;
    chooseRoute(0);
    routeOverview();
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

async function findRoute(originText, destinationText, destinationRow, mode, button, summary, originInput, destinationInput, avoidance) {
  const request = ++routeRequestVersion;
  const label = { drive: "Driving", twoWheeler: "Two-wheeler", walk: "Walking", cycle: "Cycling" }[mode];
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  setRouteMessage(`Finding a ${label.toLowerCase()} route…`, false, summary);
  try {
    const [origin, destination] = await Promise.all([
      resolveRoutePoint(originText, null, originInput),
      resolveRoutePoint(destinationText, destinationRow, destinationInput),
    ]);
    const body = {
      origin: origin.coordinates, destination: destination.coordinates, mode, alternatives: true,
      ...(avoidance && { avoidTolls: avoidance === "tolls", avoidHighways: avoidance === "highways" }),
    };
    const response = await fetch("/api/v1/route", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (request !== routeRequestVersion) return;
    if (!response.ok) throw Error(result.error || "The route could not be calculated.");
    const routes = (result.routes || [result]).filter((route) => route.geometry?.coordinates?.length >= 2);
    if (!routes.length) throw Error("No route was found.");
    return { from: origin.label, to: destination.label, mode: label, routes };
  } catch (error) {
    if (request === routeRequestVersion) {
      stopRouteSession();
      setRouteMessage(error.message || "The route could not be calculated.", true, summary);
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  } finally {
    if (request === routeRequestVersion) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}
function selectRouteGeometry(routes, selected) {
  displayedRouteIndex = selected;
  const data = {
    type: "FeatureCollection",
    features: routes.map((route, index) => ({ type: "Feature", properties: { selected: index === selected }, geometry: route.geometry })),
  };
  if (map.getSource("lk-route")) return map.getSource("lk-route").setData(data);
  map.addSource("lk-route", { type: "geojson", data });
  const before = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
  for (const [id, color, width, active] of [
    ["lk-route-alt", "#9babca", 5, false], ["lk-route-casing", "#fff", 9, true], ["lk-route-line", "#0879ed", 6, true],
  ]) map.addLayer({
    id, type: "line", source: "lk-route",
    filter: ["==", ["get", "selected"], active],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color, "line-width": width },
  }, before);
}
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let voiceRecognition = null;
let voiceListening = false;
// Custom microphone artwork supplied for Sifric Maps voice search.
function createVoiceMicIcon() {
  const template = document.createElement("template");
  template.innerHTML = `<span class="voice-mic-pair" aria-hidden="true">
    <svg xmlns="http://www.w3.org/2000/svg" class="icon voice-mic-icon voice-mic-light" width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
    <defs><linearGradient id="sifric-voice-mic-grad-light" x1="24" y1="6" x2="40" y2="36" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#3B82F6"/>
    </linearGradient></defs>
    <rect x="24" y="6" width="16" height="30" rx="8" fill="url(#sifric-voice-mic-grad-light)"/>
    <g stroke="#fff" stroke-opacity=".55" stroke-width="2" stroke-linecap="round">
      <line x1="29" y1="15" x2="35" y2="15"/><line x1="29" y1="21" x2="35" y2="21"/><line x1="29" y1="27" x2="35" y2="27"/>
    </g>
    <g stroke="#1F2937" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 29v3a17 17 0 0 0 34 0v-3"/>
      <line x1="32" y1="49" x2="32" y2="57"/><line x1="24" y1="57" x2="40" y2="57"/>
    </g>
  </svg>
    <svg xmlns="http://www.w3.org/2000/svg" class="icon voice-mic-icon voice-mic-dark" width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
    <defs><linearGradient id="sifric-voice-mic-grad-dark" x1="24" y1="6" x2="40" y2="36" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#3B82F6"/>
    </linearGradient></defs>
    <rect x="24" y="6" width="16" height="30" rx="8" fill="url(#sifric-voice-mic-grad-dark)"/>
    <g stroke="#fff" stroke-opacity=".55" stroke-width="2" stroke-linecap="round">
      <line x1="29" y1="15" x2="35" y2="15"/><line x1="29" y1="21" x2="35" y2="21"/><line x1="29" y1="27" x2="35" y2="27"/>
    </g>
    <g stroke="#F3F4F6" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 29v3a17 17 0 0 0 34 0v-3"/>
      <line x1="32" y1="49" x2="32" y2="57"/><line x1="24" y1="57" x2="40" y2="57"/>
    </g>
  </svg>
  </span>`;
  return template.content.firstElementChild;
}
function syncSearchAction() {
  const hasText = $("search").value.length > 0;
  const action = $("search-action");
  action.type = "button";
  action.setAttribute("aria-label", hasText ? "Clear search" : voiceListening ? "Stop voice search" : "Search by voice");
  action.setAttribute("title", hasText ? "Clear search" : voiceListening ? "Stop listening" : "Search by voice");
  action.setAttribute("aria-pressed", String(voiceListening && !hasText));
  action.replaceChildren(hasText ? icon("close") : createVoiceMicIcon());
}
function startVoiceSearch() {
  if (!SpeechRecognitionAPI) {
    alert("Voice search is not supported in this browser. Try Chrome or use the keyboard.");
    return;
  }
  if (voiceListening) {
    voiceRecognition?.stop();
    return;
  }
  const recognition = new SpeechRecognitionAPI();
  voiceRecognition = recognition;
  recognition.lang = navigator.language || "en-LK";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    voiceListening = true;
    syncSearchAction();
  };
  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    if (!transcript) return;
    $("search").value = transcript;
    syncSearchAction();
    clearTimeout(searchTimer);
    searchPlaces();
  };
  recognition.onerror = (event) => {
    if (event.error !== "aborted" && event.error !== "no-speech") {
      alert(event.error === "not-allowed"
        ? "Microphone permission is required for voice search."
        : "Voice search failed. Please try again or type your search.");
    }
  };
  recognition.onend = () => {
    voiceListening = false;
    if (voiceRecognition === recognition) voiceRecognition = null;
    syncSearchAction();
  };
  try { recognition.start(); }
  catch {
    voiceListening = false;
    syncSearchAction();
    alert("Unable to start voice search. Please try again.");
  }
}
syncSearchAction();
$("search").addEventListener("input", () => {
  syncSearchAction();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchPlaces, 150);
});
searchInput.addEventListener("focus", () => {
  if (document.body.classList.contains("search-open")) return;
  document.body.classList.add("search-open");
  $("categories").scrollLeft = 0;
  if (!$("layer-panel").hidden) $("close-layers").click();
  void searchPlaces();
});
const closeSearch = () => dismissSearch(true);
$("close-search").onclick = closeSearch;
bindSheetHandle($("search-grab"), searchShell, (distance) => {
  if (distance > 55) closeSearch();
}, closeSearch);
const contributionSheet = $("contribution-sheet");
const contributionGrab = $("contribution-grab");
function resizeContribution(expanded) {
  contributionSheet.dataset.size = expanded ? "expanded" : "compact";
  contributionGrab.setAttribute("aria-expanded", String(expanded));
  contributionGrab.setAttribute("aria-label", expanded ? "Collapse contribution sheet" : "Expand contribution sheet");
}
bindSheetHandle(contributionGrab, contributionSheet, (distance) => {
  if (distance < -45) resizeContribution(true);
  else if (distance > 55 && contributionSheet.dataset.size === "expanded") resizeContribution(false);
  else if (distance > 70) $("contribution-close").click();
}, () => resizeContribution(contributionSheet.dataset.size !== "expanded"));
new MutationObserver(() => {
  if (contributionSheet.hidden && !document.body.classList.contains("contribution-picking")) resizeContribution(false);
}).observe(contributionSheet, { attributes: true, attributeFilter: ["hidden"] });
const placeSheet = $("panel");
const togglePlace = () => setPlaceExpanded(!placeSheet.classList.contains("place-expanded"));
bindSheetHandle($("place-grab"), placeSheet, (distance) => {
  if (distance < -45) setPlaceExpanded(true);
  else if (distance > 45 && placeSheet.classList.contains("place-expanded")) setPlaceExpanded(false);
  else if (distance > 80) closePanel();
}, togglePlace);
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
$("search-action").onclick = (event) => {
  if (!$("search").value.length) {
    event.preventDefault();
    startVoiceSearch();
    return;
  }
  event.preventDefault();
  $("search").value = "";
  syncSearchAction();
  $("suggestions").hidden = true;
  $("suggestions").replaceChildren();
  clearTimeout(searchTimer);
  closePanel();
  $("search").focus();
};
$("close-panel").onclick = closePanel;
$("directions").onclick = () => showDirections(selected);
$("categories")
  .querySelectorAll("[data-kind]")
  .forEach((button) => {
    button.setAttribute("aria-pressed", "false");
    button.onclick = async () => {
      filterCategory(button.dataset.kind);
      if (!category) return searchPlaces();
      const kind = category;
      const version = ++searchVersion;
      const center = map?.getCenter() || { lng: 80.7, lat: 7.9 };
      const nearer = (row) => ((row[2] - center.lng) * Math.cos(center.lat * Math.PI / 180)) ** 2 + (row[3] - center.lat) ** 2;
      suggestions.hidden = false;
      suggestions.replaceChildren(element("div", "Finding nearby places…", "empty"));
      try {
        const rows = await searchIndex();
        if (version !== searchVersion) return;
        const nearby = rows.filter((row) => matchesCategory(row, kind))
          .map((row) => ({ row, distance: nearer(row) }))
          .sort((a, b) => a.distance - b.distance).slice(0, 12);
        suggestions.replaceChildren();
        if (!nearby.length) suggestions.append(element("div", "No places in this category", "empty"));
        for (const { row } of nearby) {
          const option = resultRow(row);
          option.onclick = () => showPlace(row);
          suggestions.append(option);
        }
      } catch (error) {
        if (version === searchVersion) suggestions.replaceChildren(element("div", error.message, "empty"));
      }
    };
  });
$("reset-category").onclick = () => {
  filterCategory(category);
  void searchPlaces();
};
const locationSvgShapes = {
  on: `<g stroke="STROKE" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="32" r="16"/><line x1="32" y1="6" x2="32" y2="12"/><line x1="32" y1="52" x2="32" y2="58"/><line x1="6" y1="32" x2="12" y2="32"/><line x1="52" y1="32" x2="58" y2="32"/></g><circle fill="STROKE" cx="32" cy="32" r="7"/>`,
  off: `<defs><mask id="off-gap-THEME" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/><line x1="10" y1="10" x2="54" y2="54" stroke="#000" stroke-width="12" stroke-linecap="round"/></mask></defs><g stroke="STROKE" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><g mask="url(#off-gap-THEME)"><circle cx="32" cy="32" r="16"/><line x1="32" y1="6" x2="32" y2="12"/><line x1="32" y1="52" x2="32" y2="58"/><line x1="6" y1="32" x2="12" y2="32"/><line x1="52" y1="32" x2="58" y2="32"/></g><line x1="10" y1="10" x2="54" y2="54"/></g>`,
  locked: `<defs><mask id="lock-gap-THEME" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/><circle cx="47" cy="47" r="14" fill="#000"/></mask></defs><g stroke="STROKE" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" mask="url(#lock-gap-THEME)"><circle cx="32" cy="32" r="16"/><line x1="32" y1="6" x2="32" y2="12"/><line x1="32" y1="52" x2="32" y2="58"/><line x1="6" y1="32" x2="12" y2="32"/><line x1="52" y1="32" x2="58" y2="32"/></g><rect fill="STROKE" x="39.5" y="46" width="15" height="11" rx="3.5"/><path stroke="STROKE" d="M43 46v-3a4 4 0 0 1 8 0v3" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`
};
let locationPermission = "prompt";
let locationDeviceUnavailable = !("geolocation" in navigator);
function updateLocationIcon() {
  const state = locationPermission === "denied" ? "locked"
    : locationDeviceUnavailable ? "off" : locationPermission === "granted" ? "on" : "locked";
  const holder = $("location-icon");
  if (!holder) return;
  holder.innerHTML = ["light", "dark"].map(theme => {
    const stroke = theme === "dark" ? "#F3F4F6" : "#1F2937";
    const paths = locationSvgShapes[state].replaceAll("THEME", theme).replaceAll("STROKE", stroke);
    return `<svg class="location-state-svg location-state-${theme}" xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">${paths}</svg>`;
  }).join("");
  const label = state === "on" ? "Show your current location"
    : state === "off" ? "Enable device location and try again" : "Allow location access";
  $("locate").setAttribute("aria-label", label);
  $("locate").title = label;
}
async function initLocationPermission() {
  if (!navigator.permissions?.query) { updateLocationIcon(); return; }
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    const sync = () => {
      locationPermission = permission.state;
      if (locationPermission !== "granted") locationDeviceUnavailable = false;
      updateLocationIcon();
    };
    permission.addEventListener?.("change", sync);
    sync();
  } catch { updateLocationIcon(); }
}
initLocationPermission();
async function handleLocationFailure(error) {
  let permission = locationPermission;
  try {
    if (navigator.permissions?.query) {
      permission = (await navigator.permissions.query({ name: "geolocation" })).state;
    }
  } catch {}
  locationPermission = permission;
  // Android Chrome may report PERMISSION_DENIED while device-wide Location is OFF,
  // even though this site's permission is still granted.
  if (permission === "granted") {
    locationDeviceUnavailable = true;
    updateLocationIcon();
    status("Device Location may be off. Turn on Location in Android Quick Settings or Settings → Location, then tap this button again.");
    return;
  }
  if (permission === "denied") {
    locationDeviceUnavailable = false;
    updateLocationIcon();
    status("Location is blocked for this site. Allow Location in Chrome Site settings, then try again.");
    return;
  }
  if (error?.code === 2 || error?.code === 3) {
    locationDeviceUnavailable = true;
    updateLocationIcon();
    status("Location unavailable. Turn on Android Location and try again.");
    return;
  }
  updateLocationIcon();
  status("Chrome could not access your location. Check device Location and site permission, then try again.");
}
// Start continuous high-accuracy positioning on demand; no background tracking before consent.
let orientationListening = false;
let lastCompassHeading = null;
let travelHeading = null;
let displayedBeamHeading = null;
let lastTravelPosition = null;
let lastTravelTime = 0;
let movementHeadingActive = false;
let liveLocationWatchId = null;
let liveLocationMarker = null;
let liveLocationCoords = null;
let focusOnNextLocation = false;
let lastRawFix = null;
let lastAcceptedGps = null;
let lastAcceptedGpsTime = 0;
function validatedDeviceFix(position) {
  const { coords, timestamp } = position;
  if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude) ||
      !Number.isFinite(coords.accuracy) || coords.accuracy <= 0 ||
      coords.latitude < -90 || coords.latitude > 90 ||
      coords.longitude < -180 || coords.longitude > 180) return null;
  const time = Number.isFinite(timestamp) ? timestamp : Date.now();
  // Ignore old, out-of-order browser geolocation callbacks.
  if (time <= lastAcceptedGpsTime || Date.now() - time > 15000) return null;
  const point = coordinateFix(coords);
  if (lastAcceptedGps) {
    const distance = gpsDistanceMeters(lastAcceptedGps, point);
    const seconds = Math.max(0.1, (time - lastAcceptedGpsTime) / 1000);
    // Only reject extreme jumps when both fixes report good accuracy.
    if (coords.accuracy <= 15 && lastAcceptedGps.accuracy <= 15 &&
        distance > Math.max(80, seconds * 25)) return null;
  }
  lastAcceptedGps = { ...point, accuracy: coords.accuracy };
  lastAcceptedGpsTime = time;
  return coords;
}

let lastSnappedFix = null;
let lastSnappedAt = 0;
let followRoadsEnabled = false;
try {
  followRoadsEnabled = JSON.parse(localStorage.getItem("lk-map-settings") || "{}").followRoads === true;
} catch { /* Default to raw device GPS. */ }
window.addEventListener("sifric-follow-roads-change", (event) => {
  followRoadsEnabled = event.detail?.enabled === true;
  lastSnappedFix = null;
  lastSnappedAt = 0;
  // Immediately return to the real device fix when disabling matching.
  if (!followRoadsEnabled && liveLocationCoords) showLiveLocation(coordinateFix(liveLocationCoords));
});
const ROAD_SNAP_MAX_METERS = 18;
const ROAD_SNAP_MIN_SPEED_MPS = 1.4;
function gpsDistanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function coordinateFix(coords) {
  return { latitude: coords.latitude, longitude: coords.longitude };
}
function showLiveLocation(coords) {
  liveLocationMarker?.setLngLat([coords.longitude, coords.latitude]);
}
// Use already-loaded MapLibre vector road geometry. No OSRM nearest requests.
function snapMovingDotToRoad(coords, speed) {
  if (!map || !map.isStyleLoaded()) return null;
  const center = map.project([coords.longitude, coords.latitude]);
  // Pitch and 3D buildings make pixel-distance an unreliable ground-distance
  // measure. Use pixels only to find candidates; validate in geographic meters.
  const metersPerPixel = 156543.03392 * Math.cos(coords.latitude * Math.PI / 180) /
    Math.pow(2, map.getZoom());
  // Conservative road proximity: do not snap a rider across an open ground.
  // Snap only when enabled; retain a conservative distance to avoid mapping
  // an open-ground cyclist onto a nearby street.
  const maxDistance = lastSnappedFix ? 14 : 10;
  const radius = Math.min(250, Math.max(35, maxDistance /
    Math.max(0.01, metersPerPixel) * 2.5));
  const style = map.getStyle();
  const styleLayers = style?.layers || [];
  const isRoad = value =>
    /(road|street|transportation|highway|motorway|trunk|primary|secondary|tertiary|residential)/.test(value) &&
    !/(rail|water|boundary|ferry|contour|footway|cycleway|path|pedestrian|building)/.test(value);
  const roadLayers = styleLayers.filter(layer =>
    layer.type === "line" && isRoad(
      ((layer.id || "") + " " + (layer["source-layer"] || "")).toLowerCase()));
  let features = [];
  try {
    if (roadLayers.length) {
      features = map.queryRenderedFeatures(
        [[center.x - radius, center.y - radius],
         [center.x + radius, center.y + radius]],
        { layers: roadLayers.map(layer => layer.id) });
    }
    // Rendered road lines may be absent in satellite/terrain styles.
    // Inspect locally loaded vector source tiles as well, without API requests.
    const sourceLayers = new Set();
    for (const layer of styleLayers) {
      if (layer.source && layer["source-layer"] && isRoad(
        (layer["source-layer"] + " " + (layer.id || "")).toLowerCase())) {
        sourceLayers.add(layer.source + "|" + layer["source-layer"]);
      }
    }
    for (const entry of sourceLayers) {
      const [source, sourceLayer] = entry.split("|");
      if (style.sources?.[source]?.type !== "vector") continue;
      const candidates = map.querySourceFeatures(source, { sourceLayer });
      for (const feature of candidates) {
        const bounds = feature.geometry?.coordinates;
        if (bounds) features.push(feature);
      }
    }
  } catch (error) {
    console.warn("Local road snapping query failed", error);
  }
  if (!features.length) return null;
  const raw = coordinateFix(coords);
  let best = null;
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry || !["LineString", "MultiLineString"].includes(geometry.type)) continue;
    const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        // Project each vector segment onto a local ground plane in meters.
        // Unlike screen-space projection this works with tilted/3D maps.
        const cosLat = Math.max(0.01, Math.cos(raw.latitude * Math.PI / 180));
        const scaleX = 111320 * cosLat, scaleY = 110574;
        const ax = (line[i - 1][0] - raw.longitude) * scaleX;
        const ay = (line[i - 1][1] - raw.latitude) * scaleY;
        const bx = (line[i][0] - raw.longitude) * scaleX;
        const by = (line[i][1] - raw.latitude) * scaleY;
        const dx = bx - ax, dy = by - ay;
        const length2 = dx * dx + dy * dy;
        if (length2 < 0.0001) continue;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
        const x = ax + t * dx, y = ay + t * dy;
        const distance = Math.hypot(x, y);
        if (distance > maxDistance) continue;
        const candidate = {
          longitude: raw.longitude + x / scaleX,
          latitude: raw.latitude + y / scaleY
        };
        const jump = lastSnappedFix ? gpsDistanceMeters(lastSnappedFix, candidate) : 0;
        const age = Date.now() - lastSnappedAt;
        const implausible = lastSnappedFix && age < 10000 &&
          jump > Math.max(25, speed * age / 1000 * 2.5 + 15);
        if (implausible) continue;
        const score = distance + (lastSnappedFix ? Math.min(jump, 40) * 0.18 : 0);
        if (!best || score < best.score) best = { candidate, score };
      }
    }
  }
  if (!best) return null;
  lastSnappedFix = best.candidate;
  lastSnappedAt = Date.now();
  return best.candidate;
}

function normalizeHeading(heading) {
  return ((heading % 360) + 360) % 360;
}
function gpsTravelBearing(from, to) {
  const rad = Math.PI / 180;
  const lat1 = from.latitude * rad, lat2 = to.latitude * rad;
  const dLon = (to.longitude - from.longitude) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalizeHeading(Math.atan2(y, x) / rad);
}
let beamTargetHeading = null;
let beamAnimationFrame = null;
function animateLocationBeam() {
  beamAnimationFrame = null;
  if (beamTargetHeading === null || !liveLocationMarker) return;
  if (displayedBeamHeading === null) displayedBeamHeading = beamTargetHeading;
  const delta = ((beamTargetHeading - displayedBeamHeading + 540) % 360) - 180;
  displayedBeamHeading += delta * 0.24;
  const marker = liveLocationMarker.getElement();
  marker.style.setProperty("--sifric-heading",
    `${displayedBeamHeading - (map?.getBearing() || 0)}deg`);
  marker.classList.add("sifric-heading-active");
  if (Math.abs(delta) > 0.15) {
    beamAnimationFrame = requestAnimationFrame(animateLocationBeam);
  }
}
function setLocationBeam(heading) {
  if (!Number.isFinite(heading)) return;
  beamTargetHeading = normalizeHeading(heading);
  if (beamAnimationFrame === null) beamAnimationFrame = requestAnimationFrame(animateLocationBeam);
}
function updateTravelBeam(point, moving, coords, time) {
  // Phone orientation always wins. GPS course is only a sensor fallback.
  if (lastCompassHeading !== null) {
    setLocationBeam(lastCompassHeading);
    return;
  }
  const distance = lastTravelPosition
    ? gpsDistanceMeters(lastTravelPosition, point) : 0;
  if (moving && lastTravelPosition && distance >= 3 && time > lastTravelTime) {
    travelHeading = gpsTravelBearing(lastTravelPosition, point);
  } else if (moving && Number.isFinite(coords.heading) && coords.heading >= 0) {
    travelHeading = coords.heading;
  }
  if (travelHeading !== null) setLocationBeam(travelHeading);
  if (!lastTravelPosition || distance >= 3) {
    lastTravelPosition = { ...point };
    lastTravelTime = time;
  }
}
function handleDeviceOrientation(event) {
  // Use calibrated compass when available; absolute orientation otherwise.
  const heading = Number.isFinite(event.webkitCompassHeading)
    ? event.webkitCompassHeading
    : event.absolute && Number.isFinite(event.alpha)
      ? (360 - event.alpha) % 360 : null;
  if (heading !== null) {
    lastCompassHeading = normalizeHeading(heading);
    setLocationBeam(lastCompassHeading);
  }
}

async function enableCompass() {
  if (orientationListening || !("DeviceOrientationEvent" in window)) return;
  try {
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      if (await DeviceOrientationEvent.requestPermission() !== "granted") {
        status("Compass permission unavailable; location tracking still works.");
        return;
      }
    }
    window.addEventListener("deviceorientationabsolute", handleDeviceOrientation, { passive: true });
    window.addEventListener("deviceorientation", handleDeviceOrientation, { passive: true });
    orientationListening = true;
  } catch (error) {
    console.warn("Compass unavailable", error);
    status("Compass unavailable on this device or browser.");
  }
}
function updateLiveLocationAccuracy() {
  if (!liveLocationMarker || !liveLocationCoords || !map) return;
  const { latitude, accuracy } = liveLocationCoords;
  const metersPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / Math.pow(2, map.getZoom());
  const radius = Math.min(1500, Math.max(12, accuracy / Math.max(metersPerPixel, 0.01)));
  liveLocationMarker.getElement().style.setProperty("--sifric-accuracy-radius", `${radius}px`);
}
function onLiveLocation(position) {
  const coords = validatedDeviceFix(position);
  if (!coords) return;
  liveLocationCoords = coords;
  const now = position.timestamp || Date.now();
  const movement = lastRawFix
    ? gpsDistanceMeters(lastRawFix.coords, coords) : 0;
  const elapsed = lastRawFix ? Math.max(0.1, (now - lastRawFix.time) / 1000) : 0;
  const inferredSpeed = lastRawFix && elapsed >= 1 ? movement / elapsed : 0;
  const speed = Number.isFinite(coords.speed) && coords.speed >= 0
    ? coords.speed : inferredSpeed;
  const accurate = Number.isFinite(coords.accuracy) && coords.accuracy <= (lastSnappedFix ? 30 : 20);
  const moving = speed >= 0.8 || (movement >= 4 && elapsed >= 1);
  lastRawFix = { coords: coordinateFix(coords), time: now };
  // Follow Roads is explicitly opt-in. Require movement and a reasonable fix;
  // nearby open grounds must not be forcibly mapped to a road.
  let matchedLocation = null;
  if (followRoadsEnabled && accurate && moving) {
    matchedLocation = snapMovingDotToRoad(coords, speed);
  }
  let shownLocation = matchedLocation || coordinateFix(coords);
  if (!liveLocationMarker) {
    const dot = document.createElement("div");
    dot.className = "maplibregl-user-location-dot sifric-live-location";
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", "Your current location");
    liveLocationMarker = new maplibregl.Marker({ element: dot, anchor: "center" })
      .setLngLat([shownLocation.longitude, shownLocation.latitude]).addTo(map);
  } else {
    // Preserve a very recent, close match while cycling slowly; never retain
    // an old road position if the raw GPS has moved away from it.
    const recentMatch = followRoadsEnabled && accurate && moving &&
      lastSnappedFix && Date.now() - lastSnappedAt < 3500 &&
      gpsDistanceMeters(lastSnappedFix, coordinateFix(coords)) <= 14;
    if (!matchedLocation && recentMatch) shownLocation = lastSnappedFix;
    showLiveLocation(shownLocation);
  }
  updateLiveLocationAccuracy();
  if (!followRoadsEnabled || !accurate || !moving) {
    lastSnappedFix = null;
    lastSnappedAt = 0;
  }
  updateTravelBeam(shownLocation, moving, coords, now);
  if (focusOnNextLocation) {
    focusOnNextLocation = false;
    map.flyTo({ center: [shownLocation.longitude, shownLocation.latitude], zoom: Math.max(map.getZoom(), 19), duration: 850 });
  }
  const button = $("locate");
  button.disabled = false;
  button.removeAttribute("aria-busy");
  locationPermission = "granted";
  locationDeviceUnavailable = false;
  updateLocationIcon();
  button.dataset.location = "ready";
  button.setAttribute("aria-label", "Recenter on your location");
  button.title = "Recenter on your location";
}
$("locate").onclick = () => {
  if (!navigator.geolocation || !window.isSecureContext) {
    status("Live location requires device GPS and HTTPS.");
    return;
  }
  if (locationPermission === "denied") {
    status("Allow Location in your browser site settings.");
    return;
  }
  if (!map) {
    status("Map is not ready yet.");
    return;
  }
  void enableCompass();
  if (liveLocationCoords) {
    // Explicit button press is the only action allowed to move the camera.
    map.flyTo({ center: [liveLocationCoords.longitude, liveLocationCoords.latitude], zoom: Math.max(map.getZoom(), 19), duration: 850 });
    return;
  }
  focusOnNextLocation = true;
  const button = $("locate");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (liveLocationWatchId === null) {
    liveLocationWatchId = navigator.geolocation.watchPosition(onLiveLocation, (error) => {
      focusOnNextLocation = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      void handleLocationFailure(error);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  }
};

$("menu").onclick = () => {
  const c = panel("Sifric Maps");
  const contribute = element("button", undefined, "menu-option");
  actionLabel(contribute, "Contribute", "place");
  contribute.onclick = () => {
    closePanel();
    $("menu").focus({ preventScroll: true });
    $("contribute-fab").click();
  };
  c.append(contribute);
  const items = [
    [
      "Explore Sri Lanka",
      () => {
        closePanel();
        map.flyTo({ center: [80.7, 7.9], zoom: 7 });
      },
    ],
    ["Share this map", shareView],
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
            : name === "Share this map" ? "share" : "history",
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
function setupMapTools() {
  const points = [];
  const markers = [];
  const measure = $("measure");
  const bar = $("measure-bar");
  let measuring = false;
  const updateMeasure = () => {
    const data = { type: "FeatureCollection", features: points.length < 2 ? [] : [{
      type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points.map(({ lng, lat }) => [lng, lat]) },
    }] };
    if (map.getSource("home-measure")) map.getSource("home-measure").setData(data);
    else if (measuring && map.isStyleLoaded()) {
      map.addSource("home-measure", { type: "geojson", data });
      map.addLayer({ id: "home-measure", type: "line", source: "home-measure", paint: { "line-color": "#0879ed", "line-width": 4 } });
    }
    const distance = points.reduce((total, point, i) => i ? total + points[i - 1].distanceTo(point) : 0, 0);
    $("measure-output").textContent = points.length > 1
      ? `${routeDistance(distance)} · ${distance >= 304.8 ? (distance / 1609.344).toFixed(2) + " mi" : Math.round(distance / .3048) + " ft"}`
      : points.length ? "Tap the next point" : "Tap the map to start";
    $("measure-undo").disabled = !points.length;
  };
  const setMeasure = (enabled) => {
    measuring = enabled;
    document.body.classList.toggle("measuring", enabled);
    bar.hidden = !enabled;
    measure.setAttribute("aria-pressed", String(enabled));
    if (enabled) closePanel();
    else {
      points.length = 0;
      markers.splice(0).forEach((marker) => marker.remove());
    }
    updateMeasure();
  };
  measure.onclick = () => setMeasure(!measuring);
  $("measure-done").onclick = () => setMeasure(false);
  $("measure-undo").onclick = () => {
    points.pop();
    markers.pop()?.remove();
    updateMeasure();
  };
  map.on("click", ({ lngLat }) => {
    if (!measuring) return;
    points.push(lngLat);
    markers.push(new maplibregl.Marker({ element: element("span", undefined, "measure-point") }).setLngLat(lngLat).addTo(map));
    updateMeasure();
  });
  map.on("style.load", updateMeasure);
  $("share-view").onclick = shareView;
  const fullscreen = $("fullscreen");
  fullscreen.hidden = !document.fullscreenEnabled;
  fullscreen.onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { status("Full screen is unavailable"); }
  };
  document.addEventListener("fullscreenchange", () => fullscreen.setAttribute("aria-pressed", String(!!document.fullscreenElement)));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && measuring) return setMeasure(false);
    if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest("input, textarea, select, [contenteditable]") || document.body.matches(".search-open,.contribution-open,.contribution-picking,.routing-open")) return;
    if (event.key.toLowerCase() === "m") measure.click();
    if (event.key.toLowerCase() === "f" && !fullscreen.hidden) fullscreen.click();
    if (event.key.toLowerCase() === "l") $("layers").click();
  });
  for (const event of ["dragstart", "zoomstart", "touchstart", "mousedown"])
    map.on(event, (e) => { if (e.originalEvent) stopRoutePreview(); });
  map.on("contextmenu", ({ lngLat }) => {
    if (document.body.classList.contains("contribution-picking")) return;
    const coordinates = `${lngLat.lat.toFixed(6)}, ${lngLat.lng.toFixed(6)}`;
    navigator.clipboard?.writeText(coordinates).then(() => status("Copied " + coordinates), () => status(coordinates));
  });
  addEventListener("offline", () => status("You are offline. Loaded map areas remain available."));
  addEventListener("online", () => status("Back online"));
}
function setupWeather() {
  const badge = $("weather");
  let timer, request, lastKey;
  async function refresh(force = false) {
    const center = map.getCenter();
    const key = `${center.lat.toFixed(2)},${center.lng.toFixed(2)}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const [latitude, longitude] = key.split(",");
    try {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.search = new URLSearchParams({ latitude, longitude, current: "temperature_2m,weather_code" });
      const result = await fetch(url, { signal: controller.signal });
      if (!result.ok) throw Error("Weather unavailable");
      const { current } = await result.json();
      if (controller.signal.aborted || !Number.isFinite(current?.temperature_2m)) return;
      const condition = current.weather_code < 2 ? "Clear" : current.weather_code < 51 ? "Cloudy" : current.weather_code >= 95 ? "Thunderstorms" : "Precipitation";
      badge.replaceChildren(icon(condition === "Clear" ? "sun" : condition === "Cloudy" ? "cloud" : "rain"), element("span", `${Math.round(current.temperature_2m)}°C`));
      badge.setAttribute("aria-label", `${condition}, ${Math.round(current.temperature_2m)} degrees Celsius, Open-Meteo`);
      badge.hidden = false;
    } catch {
      if (controller.signal.aborted) return;
      lastKey = undefined;
      badge.hidden = true;
    }
  }
  map.on("moveend", () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 1100);
  });
  setInterval(() => refresh(true), 600000);
  void refresh();
}

document.addEventListener("keydown", (e) => {
  if (document.body.classList.contains("contribution-picking") ||
      !$("contribution-sheet").hidden) return;
  if (e.key === "Escape") {
    if (!$("layer-panel").hidden) return $("close-layers").click();
    if (document.body.classList.contains("search-open")) return closeSearch();
    closePanel();
  }
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey &&
      !e.target.closest("input, textarea, select, [contenteditable]") &&
      !document.body.classList.contains("routing-open")) {
    e.preventDefault();
    searchInput.focus();
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
  registerPlaceImages(map);
  map.on("styleimagemissing", (e) => {
    if (e.id === "sifric-oneway-arrow" && !map.hasImage(e.id))
      map.addImage(e.id, roadDirectionImage(), { pixelRatio: 2 });
  });
  map.on("error", (e) => {
    if (!mapOptions?.handleError(e)) showError(e.error || new Error("Map renderer reported an error"));
  });
  // MapLibre supplies the actual distance labels and pixel widths for both units.
  // Render one shared horizontal rule, with an upward mile tick and downward km tick.
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 68, unit: "imperial" }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 68, unit: "metric" }), "bottom-right");
  const [mileSource, kmSource] = map.getContainer().querySelectorAll(".maplibregl-ctrl-scale");
  const scaleParent = mileSource?.parentElement;
  if (scaleParent && kmSource) {
    for (const source of [mileSource, kmSource]) {
      source.classList.add("scale-measure-source");
      // Inline hiding avoids older theme rules exposing the source controls.
      // Keep layout measurements available (display:none would make width zero).
      source.style.setProperty("position", "absolute", "important");
      source.style.setProperty("visibility", "hidden", "important");
      source.style.setProperty("opacity", "0", "important");
      source.style.setProperty("pointer-events", "none", "important");
      source.style.setProperty("margin", "0", "important");
    }
    const scaleDock = document.createElement("div");
    scaleDock.className = "dual-scale";
    scaleDock.setAttribute("role", "img");
    scaleDock.setAttribute("aria-label", "Map distance scale");
    scaleDock.innerHTML = `
      <span class="dual-scale-rule"></span>
      <span class="dual-scale-mile-tick"></span>
      <span class="dual-scale-km-tick"></span>
      <span class="dual-scale-mile-label"></span>
      <span class="dual-scale-km-label"></span>`;
    // Keep the distance scale independent of the expanding/collapsing attribution control.
    scaleParent.insertBefore(scaleDock, mileSource);
    const mileLabel = scaleDock.querySelector(".dual-scale-mile-label");
    const kmLabel = scaleDock.querySelector(".dual-scale-km-label");
    const updateScale = () => {
      const mileWidth = mileSource.getBoundingClientRect().width;
      const kmWidth = kmSource.getBoundingClientRect().width;
      if (!mileWidth || !kmWidth) return;
      const width = Math.max(mileWidth, kmWidth);
      scaleDock.style.width = `${width}px`;
      scaleDock.style.setProperty("--mile-left", `${width - mileWidth}px`);
      scaleDock.style.setProperty("--km-left", `${width - kmWidth}px`);
      mileLabel.textContent = mileSource.textContent;
      kmLabel.textContent = kmSource.textContent;
      scaleDock.setAttribute("aria-label", `${mileSource.textContent}, ${kmSource.textContent}`);
    };
    let framePending = false;
    const scheduleScaleUpdate = () => {
      if (framePending) return;
      framePending = true;
      requestAnimationFrame(() => {
        framePending = false;
        updateScale();
      });
    };
    map.on("render", scheduleScaleUpdate);
    map.on("moveend", scheduleScaleUpdate);
    map.once("load", scheduleScaleUpdate);
    let scaleHideTimer;
    const revealScale = () => {
      scaleDock.classList.remove("scale-idle");
      clearTimeout(scaleHideTimer);
      scaleHideTimer = setTimeout(() => scaleDock.classList.add("scale-idle"), 3000);
      scheduleScaleUpdate();
    };
    for (const eventName of ["movestart", "move", "zoomstart", "zoom", "touchstart", "mousedown"]) {
      map.on(eventName, revealScale);
    }
    revealScale();
  }
  // Keep the camera independent of GPS updates. Recenter only on explicit button presses.
  map.on("zoom", updateLiveLocationAccuracy);
  map.on("rotate", () => {
    if (beamTargetHeading !== null) {
      const marker = liveLocationMarker?.getElement();
      marker?.style.setProperty("--sifric-heading",
        `${displayedBeamHeading - map.getBearing()}deg`);
    }
  });
  for (const layer of ["mazo-places-icon", "mazo-places-dot"]) {
    map.on("click", layer, (e) => {
      if (document.body.matches(".routing-open,.contribution-picking,.measuring")) return;
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
      () => (map.getCanvas().style.cursor = document.body.matches(".routing-open,.contribution-picking,.measuring") ? "" : "pointer"),
    );
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }
  map.on("click", (e) => {
    if (document.body.matches(".contribution-picking,.measuring,.routing-open")) return;
    const layers = ["mazo-places-icon", "mazo-places-dot"].filter((layer) => map.getLayer(layer));
    if (layers.length && map.queryRenderedFeatures(e.point, { layers }).length) return;
    if (document.body.classList.contains("search-open")) dismissSearch();
    else showDroppedPin(e.lngLat);
  });
  map.on("style.load", () => {
    if (displayedRoutes.length) selectRouteGeometry(displayedRoutes, displayedRouteIndex);
  });
  map.once("load", async () => {
    mapOptions = createMapOptions(map, { baseStyle: style, status });
    setupMapTools();
    setupWeather();
    const layerPanel = $("layer-panel");
    const scrim = $("layer-scrim");
    new MutationObserver(() => {
      scrim.hidden = layerPanel.hidden;
      if (layerPanel.hidden) layerPanel.dataset.size = "compact";
    }).observe(layerPanel, { attributes: true, attributeFilter: ["hidden"] });
    scrim.onclick = () => $("close-layers").click();
    const layerGrab = $("layers-grab");
    const resizeLayers = (expanded) => {
      layerPanel.dataset.size = expanded ? "expanded" : "compact";
      layerGrab.setAttribute("aria-label", expanded ? "Collapse layers" : "Expand layers");
      layerGrab.setAttribute("aria-expanded", String(expanded));
    };
    bindSheetHandle(layerGrab, layerPanel, (distance) => {
      if (distance < -45) resizeLayers(true);
      else if (distance > 55 && layerPanel.dataset.size === "expanded") resizeLayers(false);
      else if (distance > 70) $("close-layers").click();
    }, () => resizeLayers(layerPanel.dataset.size !== "expanded"));
    const applyPreset = (type, theme, enabled) => {
      mapOptions.setType(type);
      mapOptions.setTheme(theme);
      for (const button of layerPanel.querySelectorAll("[data-map-detail]:not([disabled])")) {
        if (enabled.includes(button.dataset.mapDetail) !== (button.getAttribute("aria-pressed") === "true")) button.click();
      }
    };
    const presets = {
      explore: ["default", "system", []], transit: ["default", "system", ["transit"]],
      cycling: ["default", "system", ["bicycling"]], hiking: ["terrain", "system", []], night: ["default", "dark", []],
    };
    layerPanel.querySelectorAll("[data-preset]").forEach((button) => {
      button.onclick = () => applyPreset(...presets[button.dataset.preset]);
    });
    $("reset-layers").onclick = () => applyPreset(...presets.explore);

    $("layers").addEventListener("click", () => {
      if (!layerPanel.hidden) {
        dismissSearch();
        $("close-layers").focus({ preventScroll: true });
      }
    });

    const params = new URL(location.href).searchParams;
    if (params.get("pin") === "1" && hash.length === 3 && hash.every(Number.isFinite))
      showDroppedPin(map.getCenter());
    const id = params.get("place");
    if (id) {
      const row = (await searchIndex()).find((r) => String(r[0]) === id);
      if (row) showPlace(row);
    }
  });
})().catch(showError);
