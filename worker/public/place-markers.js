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
function markerImage(kind) {
  const canvas = document.createElement("canvas");
  canvas.width = 112; canvas.height = 112;
  const c = canvas.getContext("2d"); c.scale(4, 4);
  const aliases = { restaurant: "food", fast_food: "food", food_court: "food", hospital: "health", pharmacy: "health", hotel: "hotel", lodging: "hotel", park: "leisure", shop: "shopping" };
  const category = aliases[kind] || kind;
  const colour = colours[category] || colours[kind] || colours.other;
  const cx = 14, cy = 14, radius = 11.5;
  c.save(); c.shadowColor = "rgba(0,0,0,.30)"; c.shadowBlur = 3; c.shadowOffsetY = 1.25;
  const body = c.createRadialGradient(cx - 4, cy - 6, 1, cx, cy, radius + 1);
  body.addColorStop(0, "rgba(255,255,255,.48)"); body.addColorStop(.3, colour); body.addColorStop(1, colour);
  c.fillStyle = body; c.beginPath(); c.arc(cx, cy, radius, 0, Math.PI * 2); c.fill(); c.restore();
  c.strokeStyle = "rgba(255,255,255,.96)"; c.lineWidth = 1.4; c.beginPath(); c.arc(cx, cy, radius - .1, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = "rgba(255,255,255,.42)"; c.lineWidth = .75; c.beginPath(); c.arc(cx, cy, radius - 2, Math.PI * 1.12, Math.PI * 1.88); c.stroke();
  const filledIcons = {
    food: 'M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z',
    health: 'M19 3H5c-1.1 0-1.99.9-1.99 2L3 19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 11h-4v4h-4v-4H6v-4h4V6h4v4h4v4z',
    hotel: 'M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9c0-2.21-1.79-4-4-4z',
    leisure: 'M17 12h2L12 2 5.05 12H7l-3.9 6h6.92v4h3.96v-4H21z',
    shopping: 'M18 6h-2c0-2.21-1.79-4-4-4S8 3.79 8 6H6c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6-2c1.1 0 2 .9 2 2h-4c0-1.1.9-2 2-2z',
  };
  c.fillStyle = "#fff";
  if (filledIcons[category]) { c.save(); c.translate(6, 6); c.scale(.67, .67); c.fill(new Path2D(filledIcons[category])); c.restore(); }
  else drawIcon(c, placeIcons[kind] || "place", 6.5, 6.5, 15, "#fff");
  return { width: 112, height: 112, data: c.getImageData(0, 0, 112, 112).data };
}
export function stylePlaces(style) {
  const layers = Object.fromEntries(style.layers.map((l) => [l.id, l]));
  const dot = layers["mazo-places-dot"];
  const pin = layers["mazo-places-icon"];
  if (!dot || !pin) return style;
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
    "icon-padding": 4,
    "icon-optional": false,
    "text-field": /^en(?:-|$)/i.test(navigator.language)
      ? ["coalesce", ["get", "label"], ["get", "name"]]
      : ["get", "name"],
    "text-font": ["Mazo Maps Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 16, 11],
    "text-variable-anchor-offset": [
      "left",
      [0.8, -0.15],
      "right",
      [-0.8, -0.15],
      "bottom",
      [0, -0.8],
      "top",
      [0, 0.8],
    ],
    "text-justify": "auto",
    "text-optional": false,
    "text-allow-overlap": false,
    "text-padding": 4,
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
function roadShieldImage() {
  const canvas = document.createElement("canvas"); canvas.width = 88; canvas.height = 56;
  const c = canvas.getContext("2d"); c.scale(2, 2);
  const g = c.createLinearGradient(0, 0, 0, 28); g.addColorStop(0, "#39995d"); g.addColorStop(1, "#197341");
  c.fillStyle = g; c.strokeStyle = "rgba(255,255,255,.94)"; c.lineWidth = 1.4;
  c.beginPath(); c.roundRect(1, 1, 42, 26, 4); c.fill(); c.stroke();
  return { width: 88, height: 56, data: c.getImageData(0, 0, 88, 56).data };
}
function directionArrowImage() {
  const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
  const c = canvas.getContext("2d"); c.scale(2, 2);
  c.translate(16, 16); c.fillStyle = "#e7f2ff"; c.strokeStyle = "rgba(20,38,55,.88)"; c.lineWidth = 1.4;
  c.lineJoin = "round"; c.beginPath(); c.moveTo(0, -8); c.lineTo(6.2, 5.5); c.lineTo(0, 2.3); c.lineTo(-6.2, 5.5); c.closePath(); c.fill(); c.stroke();
  return { width: 64, height: 64, data: c.getImageData(0, 0, 64, 64).data };
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

export function selectedPlaceElement() {
  const marker = document.createElement("div");
  marker.className = "selected-marker";
  marker.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="24" height="36" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 24 12 24s12-15 12-24c0-6.627-5.373-12-12-12z" fill="#EA4335"/><circle cx="12" cy="12" r="4.5" fill="#FFFFFF"/></svg>';
  return marker;
}
