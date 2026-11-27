import { drawIcon } from "./icons.js";

const colours = {
  food: "#FF9800",
  shopping: "#1E88E5",
  health: "#E53935",
  hotel: "#8E24AA",
  finance: "#547bc4",
  leisure: "#43A047",
  culture: "#8E24AA",
  worship: "#7b969f",
  transport: "#567a9a",
  government: "#78909c",
  landmark: "#b44df0",
  other: "#82969d",
};
const aliases = { restaurant: "food", fast_food: "food", food_court: "food", hospital: "health", pharmacy: "health", hotel: "hotel", lodging: "hotel", park: "leisure", shop: "shopping" };
const selectedColours = { shopping: "#edbd52", health: "#e95f75" };
export const placeIcons = {
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
function markerImage(kind, selected = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 112; canvas.height = 112;
  const c = canvas.getContext("2d"); c.scale(4, 4);
  const category = aliases[kind] || kind;
  const colour = (selected && selectedColours[category]) || colours[category] || colours[kind] || colours.other;
  const cx = 14, cy = 14, radius = 11.5;
  c.save(); c.shadowColor = selected ? "rgba(0,0,0,.44)" : "rgba(0,0,0,.30)"; c.shadowBlur = selected ? 4 : 3; c.shadowOffsetY = 1.25;
  const body = selected ? c.createLinearGradient(0, 2, 0, 27) : c.createRadialGradient(cx - 4, cy - 6, 1, cx, cy, radius + 1);
  if (selected) {
    body.addColorStop(0, colour); body.addColorStop(1, colour);
  } else {
    body.addColorStop(0, "rgba(255,255,255,.48)"); body.addColorStop(.3, colour); body.addColorStop(1, colour);
  }
  c.fillStyle = body; c.beginPath(); c.arc(cx, cy, radius, 0, Math.PI * 2); c.fill(); c.restore();
  if (selected) {
    c.save(); c.beginPath(); c.arc(cx, cy, radius, 0, Math.PI * 2); c.clip();
    const glaze = c.createLinearGradient(0, 2, 0, 26);
    glaze.addColorStop(0, "rgba(255,255,255,.52)"); glaze.addColorStop(.42, "rgba(255,255,255,.11)"); glaze.addColorStop(1, "rgba(0,0,0,.27)");
    c.fillStyle = glaze; c.fillRect(1, 1, 26, 26); c.restore();
    c.strokeStyle = "rgba(10,20,32,.85)"; c.lineWidth = .85; c.beginPath(); c.arc(cx, cy, radius - .1, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = "rgba(255,255,255,.45)"; c.lineWidth = .5; c.beginPath(); c.arc(cx, cy, radius - 1.2, Math.PI * 1.04, Math.PI * 1.94); c.stroke();
  } else {
    c.strokeStyle = "rgba(255,255,255,.96)"; c.lineWidth = 1.4; c.beginPath(); c.arc(cx, cy, radius - .1, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = "rgba(255,255,255,.42)"; c.lineWidth = .75; c.beginPath(); c.arc(cx, cy, radius - 2, Math.PI * 1.12, Math.PI * 1.88); c.stroke();
  }
  const filledIcons = {
    food: 'M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z',
    health: 'M19 3H5c-1.1 0-1.99.9-1.99 2L3 19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 11h-4v4h-4v-4H6v-4h4V6h4v4h4v4z',
    hotel: 'M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9c0-2.21-1.79-4-4-4z',
    leisure: 'M17 12h2L12 2 5.05 12H7l-3.9 6h6.92v4h3.96v-4H21z',
    shopping: 'M18 6h-2c0-2.21-1.79-4-4-4S8 3.79 8 6H6c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6-2c1.1 0 2 .9 2 2h-4c0-1.1.9-2 2-2z',
  };
  const iconColour = selected ? (category === "health" ? "#371b20" : category === "shopping" ? "#29231b" : "#18212b") : "#fff";
  c.fillStyle = iconColour;
  if (selected && category === "health") { c.beginPath(); c.roundRect(12.2, 8.5, 3.6, 11, .3); c.roundRect(8.5, 12.2, 11, 3.6, .3); c.fill(); }
  else if (filledIcons[category]) { c.save(); c.translate(selected ? 7.2 : 6, selected ? 7.2 : 6); c.scale(selected ? .57 : .67, selected ? .57 : .67); c.fill(new Path2D(filledIcons[category])); c.restore(); }
  else drawIcon(c, placeIcons[kind] || "place", selected ? 8 : 6.5, selected ? 8 : 6.5, selected ? 12 : 15, iconColour);
  return { width: 112, height: 112, data: c.getImageData(0, 0, 112, 112).data };
}
export function stylePlaces(style) {
  const layers = Object.fromEntries(style.layers.map((l) => [l.id, l]));
  const dot = layers["mazo-places-dot"];
  const pin = layers["mazo-places-icon"];
  if (!dot || !pin) return style;
  // Use the same bold face for named places at every rendered zoom level.
  for (const layer of style.layers) {
    if (layer["source-layer"] === "place" || layer["source-layer"] === "poi") {
      if (layer.layout?.["text-field"]) {
        layer.layout["text-font"] = ["Geist Bold"];
      }
    }
  }
  for (const id of [
    "label_other",
    "mazo-places-pin",
    "mazo-places-label",
    "mazo-places-subtitle",
  ])
    if (layers[id])
      layers[id].layout = { ...(layers[id].layout || {}), visibility: "none" };
  // Fallback dots share the pin collision footprint, so they yield to named
  // pins and to each other instead of drawing an unrestricted cloud of points.
  dot.type = "symbol";
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
    "icon-anchor": "center",
    "icon-allow-overlap": false,
    "icon-ignore-placement": false,
    "icon-padding": 4,
  };
  dot.paint = {};
  delete pin.filter;
  pin.layout = {
    "icon-image": ["concat", "lk-pin-", ["get", "kind"]],
    "icon-size": [
      "interpolate",
      ["linear"],
      ["zoom"],
      7,
      0.65,
      10,
      0.70,
      12,
      0.76,
      14,
      0.82,
      16,
      0.87,
      18,
      0.92,
    ],
    "icon-anchor": "center",
    "icon-allow-overlap": false,
    "icon-padding": 14,
    "icon-optional": false,
    "text-field": /^en(?:-|$)/i.test(navigator.language)
      ? ["coalesce", ["get", "label"], ["get", "name"]]
      : ["get", "name"],
    "text-font": ["Geist Bold"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 12, 9, 16, 10, 18, 10.5],
    "text-anchor": "left",
    "text-offset": [1.35, 0],
    "text-justify": "auto",
    "text-optional": false,
    "text-allow-overlap": false,
    "text-padding": 12,
    "text-max-width": 8,
    "symbol-sort-key": [
      "match",
      ["get", "kind"],
      "health",
      1,
      "leisure",
      2,
      "transport",
      3,
      "food",
      4,
      "shopping",
      5,
      "culture",
      6,
      "worship",
      7,
      "landmark",
      8,
      "finance",
      9,
      "government",
      10,
      11,
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
  dot.layout["symbol-sort-key"] = pin.layout["symbol-sort-key"];
  // Geographic names keep placement priority over businesses at overview zooms.
  const base = style.layers.filter((layer) => layer !== dot && layer !== pin);
  const geographicNames = base.findIndex(
    (layer) => layer["source-layer"] === "place",
  );
  base.splice(geographicNames < 0 ? base.length : geographicNames, 0, dot, pin);
  style.layers = base;
  return style;
}
function roadShieldImage() {
  const canvas = document.createElement("canvas"); canvas.width = 80; canvas.height = 48;
  const c = canvas.getContext("2d"); c.scale(2, 2);
  const g = c.createLinearGradient(0, 0, 0, 24); g.addColorStop(0, "#278957"); g.addColorStop(1, "#17653d");
  c.fillStyle = g; c.strokeStyle = "rgba(255,255,255,.98)"; c.lineWidth = 1.4;
  c.beginPath(); c.roundRect(1, 1, 38, 22, 4); c.fill(); c.stroke();
  c.strokeStyle = "rgba(8,48,29,.8)"; c.lineWidth = .65;
  c.beginPath(); c.roundRect(2.3, 2.3, 35.4, 19.4, 3); c.stroke();
  return { width: 80, height: 48, data: c.getImageData(0, 0, 80, 48).data };
}
function directionArrowImage() {
  // A line-placed icon's horizontal axis follows the OSM way direction.
  // This is the same east-pointing SVG path included in the shared sprite.
  const outline = new Path2D("M3 8h9V4l9 8-9 8v-4H3z");
  const inset = new Path2D("M4.5 9.5h8.1V7.4l6.2 4.6-6.2 4.6v-2.1H4.5z");
  const canvas = document.createElement("canvas"); canvas.width = 48; canvas.height = 48;
  const context = canvas.getContext("2d");
  context.scale(2, 2);
  context.fillStyle = "#526070";
  context.strokeStyle = "#526070";
  context.lineWidth = 1.5;
  context.lineJoin = "round";
  context.fill(outline);
  context.stroke(outline);
  context.fillStyle = "#ffffff";
  context.fill(inset);
  return { width: 48, height: 48, data: context.getImageData(0, 0, 48, 48).data };
}
export function registerPlaceImages(map) {
  map.on("styleimagemissing", ({ id }) => {
    if (map.hasImage(id)) return;
    if (id.startsWith("lk-pin-")) map.addImage(id, markerImage(id.slice(7)), { pixelRatio: 4 });
    if (id.startsWith("lk-dot-")) map.addImage(id, dotImage(id.slice(7)), { pixelRatio: 4 });
    if (id === "lk-road-shield") map.addImage(id, roadShieldImage(), { pixelRatio: 2 });
    if (id === "lk-direction-arrow") map.addImage(id, directionArrowImage(), { pixelRatio: 2 });
  });
}

export function selectedPlaceElement(kind = "", dropped = false, name = "") {
  const marker = document.createElement("div");
  marker.className = dropped ? "selected-marker" : "selected-marker selected-marker--place";
  if (dropped || !kind || kind === "location") {
    marker.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="24" height="36" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 24 12 24s12-15 12-24c0-6.627-5.373-12-12-12z" fill="#EA4335"/><circle cx="12" cy="12" r="4.5" fill="#FFFFFF"/></svg>';
    return marker;
  }
  const category = aliases[kind] || kind;
  marker.style.setProperty("--marker-color", selectedColours[category] || colours[category] || colours.other);
  const image = markerImage(kind, true), canvas = document.createElement("canvas");
  canvas.width = image.width; canvas.height = image.height;
  canvas.getContext("2d").putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  const visual = document.createElement("span");
  visual.className = "selected-marker__visual";
  const img = document.createElement("img"); img.alt = ""; img.src = canvas.toDataURL("image/png");
  visual.append(img);
  marker.append(visual);
  const dot = document.createElement("span"); dot.className = "selected-marker__anchor-dot";
  marker.append(dot);
  if (name) {
    const label = document.createElement("span");
    label.className = "selected-marker__name";
    label.textContent = name;
    marker.append(label);
  }
  return marker;
}
