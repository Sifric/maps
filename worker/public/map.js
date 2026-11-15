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
  highlight;
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
function markerImage(kind) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 80;
  const c = canvas.getContext("2d");
  const colour = colours[kind] || colours.other;
  c.shadowColor = "#0005";
  c.shadowBlur = 4;
  c.shadowOffsetY = 2;
  c.fillStyle = colour;
  c.strokeStyle = "#fff";
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(32, 69);
  c.bezierCurveTo(27, 62, 9, 45, 9, 29);
  c.arc(32, 29, 23, Math.PI, 0);
  c.bezierCurveTo(55, 45, 37, 62, 32, 69);
  c.closePath();
  c.fill();
  c.stroke();
  c.shadowColor = "transparent";
  c.strokeStyle = "#fff";
  c.fillStyle = "#fff";
  c.lineWidth = 3;
  c.lineCap = "round";
  c.lineJoin = "round";
  const line = (...p) => {
    c.beginPath();
    c.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]);
    c.stroke();
  };
  if (kind === "food") {
    line(23, 18, 23, 39);
    line(18, 18, 18, 26, 28, 26, 28, 18);
    line(38, 18, 34, 28, 41, 28, 41, 39);
  } else if (kind === "shopping") {
    c.strokeRect(20, 24, 24, 18);
    c.beginPath();
    c.arc(32, 24, 7, Math.PI, 0);
    c.stroke();
  } else if (kind === "health") {
    c.fillRect(28, 17, 8, 25);
    c.fillRect(19, 25, 26, 8);
  } else if (
    kind === "finance" ||
    kind === "culture" ||
    kind === "government"
  ) {
    line(18, 24, 32, 16, 46, 24, 18, 24);
    for (const x of [23, 32, 41]) line(x, 28, x, 39);
    line(18, 42, 46, 42);
  } else if (kind === "leisure") {
    c.beginPath();
    c.moveTo(32, 16);
    c.lineTo(20, 32);
    c.lineTo(44, 32);
    c.closePath();
    c.fill();
    c.fillRect(29, 30, 6, 13);
  } else if (kind === "worship") {
    c.beginPath();
    c.arc(32, 27, 10, Math.PI, 0);
    c.stroke();
    c.strokeRect(22, 27, 20, 15);
    line(32, 17, 32, 12);
    c.strokeRect(29, 33, 6, 9);
  } else if (kind === "transport") {
    c.strokeRect(21, 18, 22, 23);
    line(22, 31, 42, 31);
    c.fillRect(25, 34, 3, 3);
    c.fillRect(36, 34, 3, 3);
    line(24, 41, 24, 44);
    line(40, 41, 40, 44);
  } else if (kind === "landmark") {
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5,
        r = i % 2 ? 6 : 13;
      c[i ? "lineTo" : "moveTo"](32 + Math.cos(a) * r, 29 + Math.sin(a) * r);
    }
    c.closePath();
    c.fill();
  } else {
    c.beginPath();
    c.arc(32, 29, 6, 0, 2 * Math.PI);
    c.fill();
  }
  return { width: 64, height: 80, data: c.getImageData(0, 0, 64, 80).data };
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
  dot.maxzoom = 12;
  dot.paint["circle-color"] = [
    "match",
    ["get", "kind"],
    ...Object.entries(colours)
      .filter(([k]) => k !== "other")
      .flat(),
    colours.other,
  ];
  dot.paint["circle-radius"] = [
    "interpolate",
    ["linear"],
    ["zoom"],
    7,
    1.5,
    11,
    2.5,
  ];
  const pin = layers["mazo-places-icon"];
  pin.minzoom = 12;
  pin.filter = ["!=", ["get", "kind"], "other"];
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
    "icon-anchor": "bottom",
    "icon-allow-overlap": false,
    "icon-padding": 8,
    "icon-optional": false,
    "text-field": ["get", "name"],
    "text-font": ["Mazo Maps Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 12, 12, 16, 13],
    "text-anchor": "left",
    "text-offset": [1, -1.45],
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
  return style;
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
function closePanel() {
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
  route.onclick = () => showDirections(row);
  const save = element(
    "button",
    readStored("lk-saved").some((r) => r[0] === row[0]) ? "Saved" : "Save",
  );
  save.onclick = () => {
    const all = readStored("lk-saved"),
      found = all.some((r) => r[0] === row[0]);
    writeStored(
      "lk-saved",
      found ? all.filter((r) => r[0] !== row[0]) : [row, ...all],
    );
    save.textContent = found ? "Save" : "Saved";
    status(found ? "Removed from saved places" : "Place saved");
  };
  const share = element("button", "Share");
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
  highlight = new maplibregl.Marker({ color: colours[row[4]] || colours.other })
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
  const icon = element("span", "⌖", "result-icon");
  const text = element("span");
  text.append(
    element("strong", row[1]),
    element(
      "small",
      `${row[5] || categoryNames[row[4]] || "Place"} · Sri Lanka`,
    ),
  );
  b.append(icon, text);
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
    const base =
      id === "mazo-places-icon" ? ["!=", ["get", "kind"], "other"] : null;
    map.setFilter(id, category ? ["==", ["get", "kind"], category] : base);
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
$("layers").onclick = () => {
  $("layer-panel").hidden = !$("layer-panel").hidden;
};
$("show-places").onchange = (e) => {
  for (const id of ["mazo-places-dot", "mazo-places-icon"])
    map.setLayoutProperty(
      id,
      "visibility",
      e.target.checked ? "visible" : "none",
    );
};
$("show-buildings").onchange = (e) => {
  for (const l of map.getStyle().layers)
    if (l["source-layer"] === "building" && l.type === "fill")
      map.setLayoutProperty(
        l.id,
        "visibility",
        e.target.checked ? "visible" : "none",
      );
};
$("locate").onclick = () => {
  if (!navigator.geolocation) {
    status("Geolocation is unavailable");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (p) =>
      map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 15 }),
    () =>
      status("Location permission was denied or the location is unavailable"),
  );
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
    style,
    ...initialCamera,
    maxZoom: 20,
    attributionControl: true,
    renderWorldCopies: false,
  });
  window.map = map;
  map.on("styleimagemissing", (e) => {
    if (e.id.startsWith("lk-pin-") && !map.hasImage(e.id))
      map.addImage(e.id, markerImage(e.id.slice(7)), { pixelRatio: 2 });
  });
  map.on("error", (e) => showError(e.error));
  map.addControl(
    new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }),
    "bottom-right",
  );
  map.on("click", "mazo-places-icon", (e) => {
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
    "mazo-places-icon",
    () => (map.getCanvas().style.cursor = "pointer"),
  );
  map.on(
    "mouseleave",
    "mazo-places-icon",
    () => (map.getCanvas().style.cursor = ""),
  );
  map.on("click", (e) => {
    if (
      !map.queryRenderedFeatures(e.point, { layers: ["mazo-places-icon"] })
        .length
    )
      $("suggestions").hidden = true;
  });
  map.once("load", async () => {
    const id = new URL(location.href).searchParams.get("place");
    if (id) {
      const row = (await searchIndex()).find((r) => String(r[0]) === id);
      if (row) showPlace(row);
    }
  });
})().catch(showError);
