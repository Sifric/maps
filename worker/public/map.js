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
  if (kind === "other") {
    c.fillStyle = "#fff";
    c.beginPath();
    c.arc(32, 29, 7, 0, Math.PI * 2);
    c.fill();
  } else drawIcon(c, icons[kind] || "place", 18, 15, 28, "#fff");
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
  delete dot.maxzoom;
  const progress = ["number", ["feature-state", "placeExpansion"], 0];
  const unselected = (opacity) => [
    "case",
    ["boolean", ["feature-state", "selectedPlace"], false],
    0,
    opacity,
  ];
  const radius = (small, large) => [
    "interpolate",
    ["linear"],
    progress,
    0,
    small,
    0.55,
    large,
    1,
    large,
  ];
  dot.paint = {
    "circle-color": [
      "match",
      ["get", "kind"],
      ...Object.entries(colours)
        .filter(([k]) => k !== "other")
        .flat(),
      colours.other,
    ],
    "circle-radius": [
      "interpolate",
      ["linear"],
      ["zoom"],
      7,
      radius(1.5, 5),
      11,
      radius(2.5, 7),
      12,
      radius(3, 8.05),
      14,
      radius(3, 9.43),
      16,
      radius(3, 10.35),
    ],
    "circle-opacity": unselected([
      "interpolate",
      ["linear"],
      progress,
      0,
      1,
      0.45,
      1,
      0.85,
      0.3,
      1,
      0,
    ]),
    "circle-stroke-width": 0,
  };
  const pin = layers["mazo-places-icon"];
  pin.minzoom = 12;
  delete pin.filter;
  pin.layout = {
    "icon-image": ["concat", "lk-pin-", ["get", "kind"]],
    "icon-size": [
      "interpolate",
      ["linear"],
      ["zoom"],
      12,
      0.7,
      14,
      0.82,
      16,
      0.9,
    ],
    "icon-anchor": "center",
    "icon-offset": [0, 3],
    "icon-allow-overlap": false,
    "icon-padding": 8,
    "icon-optional": false,
    "text-field": ["get", "name"],
    "text-font": ["Mazo Maps Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 12, 12, 16, 13],
    "text-anchor": "left",
    "text-offset": [1.1, 0],
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
    "icon-opacity": unselected([
      "interpolate",
      ["linear"],
      progress,
      0,
      0,
      0.35,
      0,
      0.75,
      1,
      1,
      1,
    ]),
    "text-opacity": ["interpolate", ["linear"], progress, 0, 0, 0.55, 0, 1, 1],
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
  return style;
}
// Placement chooses complete icon/name pairs. Animate only those accepted pairs;
// colliding names keep their ordinary dots, rather than leaving nameless pins.
function animatePlaceExpansion(map) {
  const places = new Map();
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  map.on("style.load", () => places.clear());
  map.on("render", () => {
    if (!map.isStyleLoaded() || !map.getLayer("mazo-places-icon")) return;
    const accepted = new Set(
      map
        .queryRenderedFeatures(undefined, {
          layers: ["mazo-places-icon"],
        })
        .map((f) => f.id)
        .filter((id) => id !== undefined),
    );
    const now = performance.now();
    for (const id of accepted) {
      if (!places.has(id))
        places.set(id, { value: 0, from: 0, target: 1, start: now });
    }
    let animating = false;
    for (const [id, state] of places) {
      const target = accepted.has(id) ? 1 : 0;
      if (state.target !== target) {
        state.from = state.value;
        state.target = target;
        state.start = now;
      }
      const t = motion.matches ? 1 : Math.min(1, (now - state.start) / 220);
      const value = state.from + (target - state.from) * (1 - (1 - t) ** 3);
      if (value !== state.value || t === 0) {
        state.value = value;
        map.setFeatureState(
          { source: "openmaptiles", sourceLayer: "places", id },
          { placeExpansion: value },
        );
      }
      if (t < 1) animating = true;
      else if (target === 0) {
        map.removeFeatureState(
          { source: "openmaptiles", sourceLayer: "places", id },
          "placeExpansion",
        );
        places.delete(id);
      }
    }
    if (animating) map.triggerRepaint();
  });
  map.on("remove", () => places.clear());
}

async function searchIndex() {
  if (!indexPromise)
    indexPromise = fetch("/assets/places-search.json").then((r) => {
      if (!r.ok) throw Error("Place search could not be loaded");
      return r.json();
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
function selectionState(row, active) {
  if (!row || !map?.getSource("openmaptiles")) return;
  const feature = { source: "openmaptiles", sourceLayer: "places", id: row[0] };
  if (active) map.setFeatureState(feature, { selectedPlace: true });
  else map.removeFeatureState(feature, "selectedPlace");
}
function closePanel() {
  selectionState(selected, false);
  selected = null;
  $("panel").hidden = true;
  if (highlight) {
    highlight.remove();
    highlight = null;
  }
}
function saveRecent(row) {
  const recents = readStored("lk-recents").filter((r) => r[0] !== row[0]);
  writeStored("lk-recents", [row, ...recents].slice(0, 15));
}
function showPlace(row, fly = true) {
  selectionState(selected, false);
  selected = row;
  selectionState(row, true);
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
      .filter((r) => words.every((w) => r[1].toLocaleLowerCase().includes(w)))
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
function filterCategory(kind) {
  category = category === kind ? null : kind;
  for (const b of $("categories").querySelectorAll("[data-kind]"))
    b.classList.toggle("active", b.dataset.kind === category);
  $("reset-category").hidden = !category;
  for (const id of ["mazo-places-dot", "mazo-places-icon"]) {
    map.setFilter(id, category ? ["==", ["get", "kind"], category] : null);
  }
  status(
    category
      ? `Showing ${categoryNames[category].toLowerCase()} places`
      : "Showing all categories",
  );
}
function showDirections(row) {
  const c = panel("Directions");
  const start = element("input");
  start.className = "route-input";
  start.placeholder = "Starting point";
  start.setAttribute("aria-label", "Starting point");
  const end = element("input");
  end.className = "route-input";
  end.placeholder = "Destination";
  end.setAttribute("aria-label", "Destination");
  end.value = row?.[1] || "";
  const go = element("button", "Open route in Google Maps", "route-launch");
  go.prepend(icon("directions"));
  go.onclick = () => {
    const u = new URL("https://www.google.com/maps/dir/");
    u.searchParams.set("api", "1");
    if (start.value.trim()) u.searchParams.set("origin", start.value.trim());
    u.searchParams.set(
      "destination",
      row ? `${row[3]},${row[2]}` : end.value.trim(),
    );
    u.searchParams.set("travelmode", "driving");
    window.open(u.href, "_blank", "noopener,noreferrer");
  };
  c.append(
    start,
    end,
    go,
    element(
      "p",
      "Routes open in Google Maps. No route engine or live traffic is available in LK Maps.",
      "panel-note",
    ),
  );
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
  animatePlaceExpansion(map);
  map.on("styleimagemissing", (e) => {
    if (e.id.startsWith("lk-pin-") && !map.hasImage(e.id))
      map.addImage(e.id, markerImage(e.id.slice(7)), { pixelRatio: 4 });
  });
  map.on("error", (e) => {
    if (!mapOptions?.handleError(e)) showError(e.error);
  });
  map.addControl(
    new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }),
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
    selectionState(selected, true);
    const id = new URL(location.href).searchParams.get("place");
    if (id) {
      const row = (await searchIndex()).find((r) => String(r[0]) === id);
      if (row) showPlace(row);
    }
  });
})().catch(showError);
